/**
 * Minimal X.509 v3 certificate writer for the secure gateway's self-signed
 * mode (src/lib/gatewayCerts.ts): one local certificate authority, and server
 * certificates it signs.
 *
 * Node can parse and verify certificates (`crypto.X509Certificate`) but cannot
 * create them, and the alternatives are a pure-JS crypto library or shelling
 * out to `openssl` (absent on Windows). The two shapes needed here are small
 * and fixed, so this writes the DER directly and leaves all cryptography to
 * `node:crypto`: ECDSA P-256 keys, SHA-256 signatures. Nothing here parses
 * untrusted input.
 *
 * Shapes (RFC 5280):
 * - CA: basicConstraints CA:TRUE pathlen 0 (critical), keyUsage keyCertSign +
 *   cRLSign (critical), subjectKeyIdentifier.
 * - Server: basicConstraints CA:FALSE (critical), keyUsage digitalSignature
 *   (critical), extKeyUsage serverAuth, subjectAltName, subjectKeyIdentifier,
 *   authorityKeyIdentifier. Apple platforms refuse a server certificate from a
 *   user-installed CA without the SAN, the serverAuth EKU, or with a validity
 *   over 825 days; the caller picks the validity.
 */

import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { domainToASCII } from "node:url";

// ── DER primitives ────────────────────────────────────────────────────────

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const octetString = (bytes: Buffer) => tlv(0x04, bytes);
const utf8String = (text: string) => tlv(0x0c, Buffer.from(text, "utf8"));
const bitString = (bytes: Buffer, unusedBits = 0) =>
  tlv(0x03, Buffer.from([unusedBits]), bytes);
const booleanTrue = () => tlv(0x01, Buffer.from([0xff]));
/** Context-specific constructed tag `[n]` wrapping `content` (EXPLICIT). */
const explicit = (n: number, content: Buffer) => tlv(0xa0 | n, content);

/**
 * An INTEGER from bytes that are already its minimal positive encoding: the
 * first bit clear, and no leading zero octet unless the value is zero. Every
 * caller passes a constant or a serial number built to that shape.
 */
const integer = (bytes: Buffer) => tlv(0x02, bytes);

function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const bytes: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let v = arc >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function time(date: Date): Buffer {
  const year = date.getUTCFullYear();
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return year < 2050
    ? tlv(0x17, Buffer.from(pad(year % 100) + rest, "ascii"))
    : tlv(0x18, Buffer.from(pad(year, 4) + rest, "ascii"));
}

// ── Names ─────────────────────────────────────────────────────────────────

const OID = {
  commonName: "2.5.4.3",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

/** X.520 upper bound on a commonName. */
const MAX_COMMON_NAME = 64;

/** A distinguished name holding only a commonName. */
function distinguishedName(commonName: string): Buffer {
  const cn = Array.from(commonName).slice(0, MAX_COMMON_NAME).join("");
  return sequence(set(sequence(oid(OID.commonName), utf8String(cn))));
}

/** The element starting at `offset`: where its content starts and where the
 * next element begins. */
function readElement(der: Buffer, offset: number): { tag: number; content: number; next: number } {
  const first = der[offset + 1];
  if (first < 0x80) {
    return { tag: der[offset], content: offset + 2, next: offset + 2 + first };
  }
  const lengthBytes = first & 0x7f;
  const length = der.readUIntBE(offset + 2, lengthBytes);
  const content = offset + 2 + lengthBytes;
  return { tag: der[offset], content, next: content + length };
}

/**
 * The encoded subject Name of a certificate, byte for byte. A certificate's
 * issuer must equal its issuer's subject exactly, so the server certificate
 * copies these bytes instead of re-encoding a name read back as text.
 */
function subjectNameOf(certPem: string): Buffer {
  const der = new X509Certificate(certPem).raw;
  const certificate = readElement(der, 0);
  const tbs = readElement(der, certificate.content);
  // version [0], then serialNumber.
  let field = readElement(der, readElement(der, tbs.content).next);
  // signature, issuer, validity, subject.
  let start = field.next;
  for (let i = 0; i < 4; i++) {
    start = field.next;
    field = readElement(der, start);
  }
  return der.subarray(start, field.next);
}

/** The 16 bytes of an IPv6 address in text form (`::` compression allowed). */
function ipv6Bytes(address: string): Buffer {
  const [head, tail] = address.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = groups(tail);
  const fill = address.includes("::") ? 8 - left.length - right.length : 0;
  const all = [...left, ...Array<string>(fill).fill("0"), ...right];
  const out = Buffer.alloc(16);
  all.forEach((group, i) => out.writeUInt16BE(parseInt(group, 16), i * 2));
  return out;
}

/**
 * One subjectAltName entry: an iPAddress for an IP literal, otherwise a
 * dNSName. Returns null for a name that cannot be written (empty, a zoned or
 * IPv4-embedding IPv6 literal, a host with no ASCII form).
 */
export function subjectAltNameEntry(name: string): Buffer | null {
  const value = name.trim().replace(/^\[|\]$/g, "");
  if (!value) return null;
  if (isIPv4(value)) {
    return tlv(0x87, Buffer.from(value.split(".").map(Number)));
  }
  if (isIPv6(value)) {
    if (value.includes("%") || value.includes(".")) return null;
    return tlv(0x87, ipv6Bytes(value));
  }
  const ascii = domainToASCII(value).toLowerCase();
  if (!ascii || !/^[a-z0-9*]([a-z0-9.-]*[a-z0-9])?$/.test(ascii)) return null;
  return tlv(0x82, Buffer.from(ascii, "ascii"));
}

// ── Certificates ──────────────────────────────────────────────────────────

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? sequence(oid(id), booleanTrue(), octetString(value))
    : sequence(oid(id), octetString(value));
}

/** A key identifier: the leading 160 bits of SHA-256 over the public key
 * (RFC 7093 method 1), so it works where SHA-1 is unavailable. */
function keyIdentifier(spki: Buffer): Buffer {
  return createHash("sha256").update(spki).digest().subarray(0, 20);
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

interface CertificateFields {
  subject: Buffer;
  issuer: Buffer;
  notBefore: Date;
  notAfter: Date;
  subjectSpki: Buffer;
  extensions: Buffer[];
  signingKey: KeyObject;
}

function buildCertificate(f: CertificateFields): string {
  if (!(f.notAfter.getTime() > f.notBefore.getTime())) {
    throw new Error("Certificate notAfter must be later than notBefore");
  }
  // 16 random octets with the first forced into 0x01-0x7f: positive (first
  // bit clear), minimally encoded (no leading zero octet), and never zero.
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const signatureAlgorithm = sequence(oid(OID.ecdsaWithSha256));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    signatureAlgorithm,
    f.issuer,
    sequence(time(f.notBefore), time(f.notAfter)),
    f.subject,
    f.subjectSpki,
    explicit(3, sequence(...f.extensions)),
  );
  const signature = sign("sha256", tbs, f.signingKey);
  return pem("CERTIFICATE", sequence(tbs, signatureAlgorithm, bitString(signature)));
}

function newKeyPair(): { spki: Buffer; privateKey: KeyObject; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    spki: publicKey.export({ type: "spki", format: "der" }),
    privateKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export interface CertificateAndKey {
  /** PEM certificate. */
  cert: string;
  /** PEM PKCS#8 private key. */
  key: string;
}

export interface CertificateAuthorityOptions {
  commonName: string;
  notBefore: Date;
  notAfter: Date;
}

/** Create a self-signed certificate authority that may sign server
 * certificates only (pathlen 0). */
export function createCertificateAuthority(
  options: CertificateAuthorityOptions,
): CertificateAndKey {
  const pair = newKeyPair();
  const name = distinguishedName(options.commonName);
  const cert = buildCertificate({
    subject: name,
    issuer: name,
    notBefore: options.notBefore,
    notAfter: options.notAfter,
    subjectSpki: pair.spki,
    signingKey: pair.privateKey,
    extensions: [
      extension(
        OID.basicConstraints,
        true,
        sequence(booleanTrue(), integer(Buffer.from([0]))),
      ),
      // keyCertSign (bit 5) + cRLSign (bit 6): 0b0000_0110, one unused bit.
      extension(OID.keyUsage, true, bitString(Buffer.from([0x06]), 1)),
      extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(pair.spki))),
    ],
  });
  return { cert, key: pair.privateKeyPem };
}

export interface ServerCertificateOptions {
  /** The authority's PEM certificate. */
  caCert: string;
  /** The authority's PEM private key. */
  caKey: string;
  commonName: string;
  /** DNS names and IP literals for the subjectAltName. */
  names: readonly string[];
  notBefore: Date;
  notAfter: Date;
}

/** Create a TLS server certificate signed by a CA from
 * {@link createCertificateAuthority}. Throws when no name can be written. */
export function createServerCertificate(
  options: ServerCertificateOptions,
): CertificateAndKey {
  const altNames = options.names
    .map(subjectAltNameEntry)
    .filter((entry): entry is Buffer => entry !== null);
  if (altNames.length === 0) {
    throw new Error("A server certificate needs at least one DNS name or IP address");
  }
  const caPrivateKey = createPrivateKey(options.caKey);
  const caSpki = createPublicKey(caPrivateKey).export({ type: "spki", format: "der" });
  const pair = newKeyPair();
  const cert = buildCertificate({
    subject: distinguishedName(options.commonName),
    issuer: subjectNameOf(options.caCert),
    notBefore: options.notBefore,
    notAfter: options.notAfter,
    subjectSpki: pair.spki,
    signingKey: caPrivateKey,
    extensions: [
      extension(OID.basicConstraints, true, sequence()),
      // digitalSignature (bit 0): 0b1000_0000, seven unused bits.
      extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)),
      extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
      extension(OID.subjectAltName, false, sequence(...altNames)),
      extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(pair.spki))),
      extension(
        OID.authorityKeyIdentifier,
        false,
        sequence(tlv(0x80, keyIdentifier(caSpki))),
      ),
    ],
  });
  return { cert, key: pair.privateKeyPem };
}

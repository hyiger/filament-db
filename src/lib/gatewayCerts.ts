/**
 * TLS material for the secure gateway (src/lib/secureGateway.ts).
 *
 * Two modes:
 * - **own certificate**: PEM files named by `FILAMENTDB_TLS_CERT` /
 *   `FILAMENTDB_TLS_KEY` (mkcert, Tailscale, Let's Encrypt, a company CA).
 * - **self-signed**: a local certificate authority and a server certificate it
 *   signs, generated into the secure directory. A client trusts the gateway by
 *   installing the CA once. The server certificate is then reissued freely
 *   (it expires yearly, and it must name the machine's current addresses)
 *   without the client noticing.
 *
 * Every function is called again on a timer, so each returns the existing
 * material when it is still good and only writes when something must change.
 */

import { X509Certificate, createPrivateKey } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { domainToASCII } from "node:url";
import { pickLanIpv4, type NetworkAddress } from "@/lib/getLanIp";
import { writeSecretFile } from "@/lib/gatewayKey";
import {
  createCertificateAuthority,
  createServerCertificate,
  subjectAltNameEntry,
} from "@/lib/x509";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A private CA has no public-trust lifetime rule; ten years outlives the install. */
export const CA_VALIDITY_DAYS = 3650;
/** Apple platforms refuse a server certificate valid for more than 825 days;
 * 397 matches what public CAs issue. */
export const SERVER_VALIDITY_DAYS = 397;
/** Reissue this long before expiry. */
export const RENEW_BEFORE_DAYS = 30;
/** Backdate notBefore so a client whose clock runs slightly behind accepts a
 * certificate issued a moment ago. */
const BACKDATE_MS = 60 * 60 * 1000;

export const CA_CERT_FILE = "ca.crt";
export const CA_KEY_FILE = "ca.key";
export const SERVER_CERT_FILE = "server.crt";
export const SERVER_KEY_FILE = "server.key";

export interface GatewayTls {
  mode: "self-signed" | "custom";
  /** PEM server certificate (with any chain the file carried). */
  cert: string;
  /** PEM private key. */
  key: string;
  /** PEM of the generated CA; null with an own certificate. */
  caCert: string | null;
  /** SHA-256 fingerprint of the server certificate, colon-separated hex. */
  fingerprint256: string;
  caFingerprint256: string | null;
  /** Expiry of the server certificate, ISO 8601. */
  notAfter: string;
  /** DNS names and IP addresses the server certificate is valid for. */
  names: string[];
}

/**
 * The names a generated server certificate should carry: loopback, this
 * machine's host name, its LAN IPv4 addresses, and any extra hosts. Names that
 * cannot go into a certificate are dropped; order is stable and duplicates
 * are removed.
 */
export function desiredCertificateNames(input: {
  hostname: string;
  interfaces: Record<string, NetworkAddress[] | undefined>;
  extraHosts: readonly string[];
}): string[] {
  const host = input.hostname.trim().replace(/\.+$/, "").toLowerCase();
  const hostNames = host ? [host, ...(host.includes(".") ? [] : [`${host}.local`])] : [];
  const candidates = [
    ...input.extraHosts.map((h) => h.trim().toLowerCase().replace(/^\[|\]$/g, "")),
    ...pickLanIpv4(input.interfaces),
    ...hostNames,
    "localhost",
    "127.0.0.1",
    "::1",
  ];
  // The ASCII form is what the certificate stores, and so what it has to be
  // checked against later: a host name left as "büro-pc" would never match its
  // own punycode entry, and the certificate would be reissued on every check.
  const ascii = candidates.map((name) => (isIP(name) ? name : domainToASCII(name) || name));
  return [...new Set(ascii)].filter((name) => subjectAltNameEntry(name) !== null);
}

function coversNames(cert: X509Certificate, names: readonly string[]): boolean {
  return names.every((name) =>
    isIP(name) ? cert.checkIP(name) !== undefined : cert.checkHost(name) !== undefined,
  );
}

/** `"DNS:a, IP Address:1.2.3.4"` → `["a", "1.2.3.4"]`. */
function namesOf(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .map((entry) => /^(?:DNS|IP Address):(.+)$/.exec(entry)?.[1] ?? "")
    .filter(Boolean);
}

interface LoadedPair {
  cert: string;
  key: string;
  x509: X509Certificate;
}

/** A certificate and its key from disk, or null when either is missing,
 * unreadable, or they do not belong together. */
function readPair(certFile: string, keyFile: string): LoadedPair | null {
  try {
    const cert = fs.readFileSync(certFile, "utf8");
    const key = fs.readFileSync(keyFile, "utf8");
    const x509 = new X509Certificate(cert);
    if (!x509.checkPrivateKey(createPrivateKey(key))) return null;
    return { cert, key, x509 };
  } catch {
    return null;
  }
}

function expiresAfter(x509: X509Certificate, when: number): boolean {
  return new Date(x509.validTo).getTime() > when;
}

function toTls(
  mode: GatewayTls["mode"],
  server: LoadedPair,
  ca: LoadedPair | null,
): GatewayTls {
  return {
    mode,
    cert: server.cert,
    key: server.key,
    caCert: ca ? ca.cert : null,
    fingerprint256: server.x509.fingerprint256,
    caFingerprint256: ca ? ca.x509.fingerprint256 : null,
    notAfter: new Date(server.x509.validTo).toISOString(),
    names: namesOf(server.x509),
  };
}

/**
 * Return the generated CA and server certificate from `dir`, creating or
 * reissuing whatever is missing, damaged, close to expiry, or (for the server
 * certificate) no longer valid for every name in `names`.
 */
export function ensureSelfSignedTls(options: {
  dir: string;
  names: readonly string[];
  /** Shown in the certificate subjects, to tell two machines' CAs apart. */
  label: string;
  now: number;
}): GatewayTls {
  const { dir, names, now } = options;
  const label = options.label.trim() || "local";
  const renewAt = now + RENEW_BEFORE_DAYS * DAY_MS;
  const caCertFile = path.join(dir, CA_CERT_FILE);
  const caKeyFile = path.join(dir, CA_KEY_FILE);
  const certFile = path.join(dir, SERVER_CERT_FILE);
  const keyFile = path.join(dir, SERVER_KEY_FILE);

  let ca = readPair(caCertFile, caKeyFile);
  if (ca && !(ca.x509.ca && expiresAfter(ca.x509, renewAt))) ca = null;
  if (!ca) {
    const created = createCertificateAuthority({
      commonName: `Filament DB Local CA (${label})`,
      notBefore: new Date(now - BACKDATE_MS),
      notAfter: new Date(now + CA_VALIDITY_DAYS * DAY_MS),
    });
    writeSecretFile(caKeyFile, created.key);
    writeSecretFile(caCertFile, created.cert);
    ca = { ...created, x509: new X509Certificate(created.cert) };
  }

  let server = readPair(certFile, keyFile);
  if (
    server &&
    !(
      server.x509.checkIssued(ca.x509) &&
      server.x509.verify(ca.x509.publicKey) &&
      expiresAfter(server.x509, renewAt) &&
      coversNames(server.x509, names)
    )
  ) {
    server = null;
  }
  if (!server) {
    const created = createServerCertificate({
      caCert: ca.cert,
      caKey: ca.key,
      commonName: `Filament DB (${label})`,
      names,
      notBefore: new Date(now - BACKDATE_MS),
      notAfter: new Date(now + SERVER_VALIDITY_DAYS * DAY_MS),
    });
    writeSecretFile(keyFile, created.key);
    writeSecretFile(certFile, created.cert);
    server = { ...created, x509: new X509Certificate(created.cert) };
  }

  return toTls("self-signed", server, ca);
}

/**
 * Load the user's own certificate. Throws with a message fit for the Settings
 * page when a file is missing, is not PEM, or the key does not match.
 */
export function loadCustomTls(certFile: string, keyFile: string): GatewayTls {
  let cert: string;
  let key: string;
  try {
    cert = fs.readFileSync(certFile, "utf8");
    key = fs.readFileSync(keyFile, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw new Error(`Could not read the TLS certificate or key file (${code}).`);
  }
  let x509: X509Certificate;
  let matches: boolean;
  try {
    x509 = new X509Certificate(cert);
    matches = x509.checkPrivateKey(createPrivateKey(key));
  } catch {
    throw new Error(
      "The TLS certificate or key is not valid PEM (an encrypted key is not supported).",
    );
  }
  if (!matches) {
    throw new Error("The TLS key does not belong to the TLS certificate.");
  }
  return toTls("custom", { cert, key, x509 }, null);
}

import { describe, it, expect } from "vitest";
import { X509Certificate, createPrivateKey } from "node:crypto";
import https from "node:https";
import type { AddressInfo } from "node:net";
import {
  createCertificateAuthority,
  createServerCertificate,
  subjectAltNameEntry,
} from "@/lib/x509";

/**
 * The hand-written X.509 encoder behind the secure gateway's generated
 * certificates. Everything is checked through an independent parser
 * (`crypto.X509Certificate`, i.e. OpenSSL) and, at the end, a real TLS
 * handshake: a certificate that only this file's own code could read would be
 * worthless.
 */

const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);

function authority(overrides: Partial<Parameters<typeof createCertificateAuthority>[0]> = {}) {
  return createCertificateAuthority({
    commonName: "Filament DB Local CA (test)",
    notBefore: at("2026-01-01T00:00:00Z"),
    notAfter: at("2036-01-01T00:00:00Z"),
    ...overrides,
  });
}

function server(
  ca: { cert: string; key: string },
  overrides: Partial<Parameters<typeof createServerCertificate>[0]> = {},
) {
  return createServerCertificate({
    caCert: ca.cert,
    caKey: ca.key,
    commonName: "Filament DB (test)",
    names: ["localhost", "127.0.0.1", "::1", "192.168.1.20", "studio.local"],
    notBefore: at("2026-01-01T00:00:00Z"),
    notAfter: at("2027-02-01T00:00:00Z"),
    ...overrides,
  });
}

describe("createCertificateAuthority", () => {
  it("is a self-signed CA limited to signing end-entity certificates", () => {
    const ca = authority();
    const x509 = new X509Certificate(ca.cert);
    expect(x509.ca).toBe(true);
    expect(x509.subject).toBe("CN=Filament DB Local CA (test)");
    expect(x509.issuer).toBe(x509.subject);
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.checkIssued(x509)).toBe(true);
    expect(new Date(x509.validFrom).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(x509.validTo).toISOString()).toBe("2036-01-01T00:00:00.000Z");
    // basicConstraints critical, CA:TRUE, pathlen 0.
    expect(x509.raw.toString("hex")).toContain("0603551d130101ff040830060101ff020100");
    // keyUsage critical: keyCertSign + cRLSign.
    expect(x509.raw.toString("hex")).toContain("0603551d0f0101ff040403020106");
  });

  it("returns a private key that belongs to the certificate", () => {
    const ca = authority();
    expect(new X509Certificate(ca.cert).checkPrivateKey(createPrivateKey(ca.key))).toBe(true);
    expect(ca.key).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it("gives every certificate its own positive serial number", () => {
    const serials = new Set(
      Array.from({ length: 20 }, () => new X509Certificate(authority().cert).serialNumber),
    );
    expect(serials.size).toBe(20);
    for (const serial of serials) {
      // At most 16 octets, never negative (high bit clear), never zero.
      expect(serial.length).toBeLessThanOrEqual(32);
      expect(parseInt(serial.padStart(32, "0")[0], 16)).toBeLessThan(8);
      expect(BigInt(`0x${serial}`) > BigInt(0)).toBe(true);
    }
  });

  it("truncates an over-long common name to the X.520 limit", () => {
    const ca = authority({ commonName: "x".repeat(100) });
    expect(new X509Certificate(ca.cert).subject).toBe(`CN=${"x".repeat(64)}`);
  });

  it("writes GeneralizedTime from 2050 on and UTCTime before", () => {
    const ca = authority({
      notBefore: at("2049-12-31T23:59:59Z"),
      notAfter: at("2050-01-01T00:00:00Z"),
    });
    const x509 = new X509Certificate(ca.cert);
    expect(new Date(x509.validFrom).toISOString()).toBe("2049-12-31T23:59:59.000Z");
    expect(new Date(x509.validTo).toISOString()).toBe("2050-01-01T00:00:00.000Z");
  });

  it("refuses a validity that ends before it starts", () => {
    expect(() =>
      authority({ notBefore: at("2030-01-01T00:00:00Z"), notAfter: at("2030-01-01T00:00:00Z") }),
    ).toThrow(/notAfter/);
  });

  it("encodes a subject longer than 127 bytes (long-form DER length)", () => {
    // 64 three-byte characters: the name alone is 192 bytes.
    const ca = authority({ commonName: "日".repeat(64) });
    const x509 = new X509Certificate(ca.cert);
    expect(x509.verify(x509.publicKey)).toBe(true);
    // And a server certificate can still copy that subject as its issuer.
    const leaf = new X509Certificate(server(ca).cert);
    expect(leaf.checkIssued(x509)).toBe(true);
    expect(leaf.verify(x509.publicKey)).toBe(true);
  });
});

describe("createServerCertificate", () => {
  it("is issued by the CA, for server authentication, and is not a CA", () => {
    const ca = authority();
    const caX509 = new X509Certificate(ca.cert);
    const leaf = new X509Certificate(server(ca).cert);
    expect(leaf.ca).toBe(false);
    expect(leaf.subject).toBe("CN=Filament DB (test)");
    expect(leaf.issuer).toBe(caX509.subject);
    expect(leaf.checkIssued(caX509)).toBe(true);
    expect(leaf.verify(caX509.publicKey)).toBe(true);
    expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]); // extKeyUsage: serverAuth
    // basicConstraints critical with CA absent (FALSE); keyUsage critical:
    // digitalSignature only.
    expect(leaf.raw.toString("hex")).toContain("0603551d130101ff04023000");
    expect(leaf.raw.toString("hex")).toContain("0603551d0f0101ff040403020780");
  });

  it("is not accepted as issued by a different CA", () => {
    const leaf = new X509Certificate(server(authority()).cert);
    const other = new X509Certificate(authority().cert);
    expect(leaf.verify(other.publicKey)).toBe(false);
  });

  it("carries every DNS name and IP address in the subjectAltName", () => {
    const leaf = new X509Certificate(server(authority()).cert);
    expect(leaf.subjectAltName).toBe(
      "DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, " +
        "IP Address:192.168.1.20, DNS:studio.local",
    );
    expect(leaf.checkHost("studio.local")).toBe("studio.local");
    expect(leaf.checkHost("other.local")).toBeUndefined();
    expect(leaf.checkIP("192.168.1.20")).toBe("192.168.1.20");
    expect(leaf.checkIP("::1")).toBeDefined();
    expect(leaf.checkIP("192.168.1.21")).toBeUndefined();
  });

  it("skips names that cannot be written and fails when none is left", () => {
    const ca = authority();
    const leaf = new X509Certificate(
      server(ca, { names: ["", "fe80::1%en0", "::ffff:1.2.3.4", "bad name", "ok.example"] }).cert,
    );
    expect(leaf.subjectAltName).toBe("DNS:ok.example");
    expect(() => server(ca, { names: ["", "not a host"] })).toThrow(/at least one/);
  });

  it("keeps the validity it was given", () => {
    const leaf = new X509Certificate(server(authority()).cert);
    const days = (new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime()) / DAY;
    expect(days).toBe(396);
  });

  it("completes a verified TLS handshake against the CA", async () => {
    const ca = authority({
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + 10 * DAY),
    });
    const leaf = server(ca, {
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + 5 * DAY),
    });
    const srv = https.createServer({ cert: leaf.cert, key: leaf.key }, (_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as AddressInfo).port;
    try {
      const get = (options: https.RequestOptions) =>
        new Promise<number>((resolve, reject) => {
          https
            .get({ host: "127.0.0.1", port, agent: false, ...options }, (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            })
            .on("error", reject);
        });
      // Trusted through the CA, by IP and by name.
      expect(await get({ ca: ca.cert })).toBe(200);
      expect(await get({ ca: ca.cert, servername: "studio.local" })).toBe(200);
      // A name the certificate does not carry is refused.
      await expect(get({ ca: ca.cert, servername: "other.local" })).rejects.toMatchObject({
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      });
      // Without the CA nothing vouches for it.
      await expect(get({})).rejects.toThrow();
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});

describe("subjectAltNameEntry", () => {
  const hex = (name: string) => subjectAltNameEntry(name)?.toString("hex") ?? null;

  it("writes an IPv4 address as four octets", () => {
    expect(hex("192.168.1.20")).toBe("8704c0a80114");
  });

  it("writes an IPv6 address as sixteen octets, expanding ::", () => {
    expect(hex("::1")).toBe("8710" + "0".repeat(31) + "1");
    expect(hex("fe80::a:1")).toBe("8710fe80" + "0".repeat(20) + "000a0001");
    expect(hex("2001:db8:0:1:2:3:4:5")).toBe("871020010db8000000010002000300040005");
    expect(hex("::")).toBe("8710" + "0".repeat(32));
    expect(hex("[::1]")).toBe(hex("::1"));
  });

  it("writes a host name as a lower-case dNSName, punycoding non-ASCII", () => {
    expect(hex("Studio.Local")).toBe("820c" + Buffer.from("studio.local").toString("hex"));
    expect(subjectAltNameEntry("bücher.example")?.subarray(2).toString()).toBe(
      "xn--bcher-kva.example",
    );
    expect(subjectAltNameEntry("*.example.com")?.subarray(2).toString()).toBe("*.example.com");
  });

  it("returns null for what a certificate cannot name", () => {
    for (const name of ["", "  ", "fe80::1%en0", "::ffff:1.2.3.4", "has space", "-lead.example", "trail-", "a_b"]) {
      expect(subjectAltNameEntry(name)).toBeNull();
    }
  });
});

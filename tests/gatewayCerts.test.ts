import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CA_CERT_FILE,
  CA_KEY_FILE,
  CA_VALIDITY_DAYS,
  RENEW_BEFORE_DAYS,
  SERVER_CERT_FILE,
  SERVER_KEY_FILE,
  SERVER_VALIDITY_DAYS,
  desiredCertificateNames,
  ensureSelfSignedTls,
  loadCustomTls,
} from "@/lib/gatewayCerts";
import { createCertificateAuthority, createServerCertificate } from "@/lib/x509";

/** TLS material for the secure gateway: a generated CA + server certificate,
 * reissued only when needed, or the operator's own certificate. */

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const NAMES = ["192.168.1.20", "studio.local", "localhost", "127.0.0.1", "::1"];

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdb-tls-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ensure = (over: Partial<Parameters<typeof ensureSelfSignedTls>[0]> = {}) =>
  ensureSelfSignedTls({ dir, names: NAMES, label: "studio", now: NOW, ...over });
const file = (name: string) => path.join(dir, name);

describe("desiredCertificateNames", () => {
  const interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    utun3: [{ address: "100.64.0.2", family: "IPv4", internal: false }],
    bridge0: [{ address: "169.254.10.1", family: "IPv4", internal: false }],
  };

  it("lists extra hosts, LAN addresses, the host name, then loopback", () => {
    expect(
      desiredCertificateNames({ hostname: "Studio-Mac.local", interfaces, extraHosts: ["NAS.lan", " 10.0.0.5 "] }),
    ).toEqual(["nas.lan", "10.0.0.5", "192.168.1.20", "100.64.0.2", "studio-mac.local", "localhost", "127.0.0.1", "::1"]);
  });

  it("adds a .local form for a bare host name", () => {
    expect(desiredCertificateNames({ hostname: "raspberrypi", interfaces: {}, extraHosts: [] })).toEqual([
      "raspberrypi",
      "raspberrypi.local",
      "localhost",
      "127.0.0.1",
      "::1",
    ]);
  });

  it("drops duplicates and names a certificate cannot carry", () => {
    expect(
      desiredCertificateNames({
        hostname: "",
        interfaces,
        extraHosts: ["192.168.1.20", "localhost", "bad host", "[::1]", "fe80::1%en0"],
      }),
    ).toEqual(["192.168.1.20", "localhost", "::1", "100.64.0.2", "127.0.0.1"]);
  });

  it("uses the ASCII form of a non-ASCII host name, so the certificate keeps matching it", () => {
    const names = desiredCertificateNames({ hostname: "Büro-PC", interfaces: {}, extraHosts: ["Küche.lan"] });
    expect(names).toEqual(["xn--kche-0ra.lan", "xn--bro-pc-3ya", "xn--bro-pc-3ya.local", "localhost", "127.0.0.1", "::1"]);
    // Issued once, then recognised as covering the same names.
    const first = ensure({ names });
    expect(ensure({ names }).fingerprint256).toBe(first.fingerprint256);
  });

  it("drops a host name that is not a DNS name (a container id is fine, a spaced name is not)", () => {
    expect(desiredCertificateNames({ hostname: "My Mac.", interfaces: {}, extraHosts: [] })).toEqual([
      "localhost",
      "127.0.0.1",
      "::1",
    ]);
    expect(desiredCertificateNames({ hostname: "3f2a9c1d4b5e", interfaces: {}, extraHosts: [] })[0]).toBe(
      "3f2a9c1d4b5e",
    );
  });
});

describe("ensureSelfSignedTls", () => {
  it("creates a CA and a server certificate for the names", () => {
    const tls = ensure();
    const ca = new X509Certificate(tls.caCert!);
    const server = new X509Certificate(tls.cert);
    expect(tls.mode).toBe("self-signed");
    expect(ca.ca).toBe(true);
    expect(ca.subject).toBe("CN=Filament DB Local CA (studio)");
    expect(server.subject).toBe("CN=Filament DB (studio)");
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(tls.fingerprint256).toBe(server.fingerprint256);
    expect(tls.caFingerprint256).toBe(ca.fingerprint256);
    expect(tls.names).toEqual(["192.168.1.20", "studio.local", "localhost", "127.0.0.1", "0:0:0:0:0:0:0:1"]);
    for (const name of [CA_CERT_FILE, CA_KEY_FILE, SERVER_CERT_FILE, SERVER_KEY_FILE]) {
      expect(fs.existsSync(file(name))).toBe(true);
    }
  });

  it("backdates the start by an hour and uses the documented lifetimes", () => {
    const tls = ensure();
    const ca = new X509Certificate(tls.caCert!);
    const server = new X509Certificate(tls.cert);
    expect(new Date(server.validFrom).getTime()).toBe(NOW - 3_600_000);
    expect(new Date(ca.validFrom).getTime()).toBe(NOW - 3_600_000);
    expect(tls.notAfter).toBe(new Date(NOW + SERVER_VALIDITY_DAYS * DAY).toISOString());
    expect(new Date(ca.validTo).getTime()).toBe(NOW + CA_VALIDITY_DAYS * DAY);
    // Apple refuses a server certificate from a user-installed CA beyond 825 days.
    expect(SERVER_VALIDITY_DAYS).toBeLessThanOrEqual(825);
  });

  it.runIf(process.platform !== "win32")("keeps the private keys owner-readable only", () => {
    ensure();
    expect(fs.statSync(file(CA_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file(SERVER_KEY_FILE)).mode & 0o777).toBe(0o600);
  });

  it("returns the same material while it is still good", () => {
    const first = ensure();
    const again = ensure({ now: NOW + 100 * DAY });
    expect(again).toEqual(first);
  });

  it("reissues only the server certificate when a name is added", () => {
    const first = ensure();
    const next = ensure({ names: [...NAMES, "10.0.0.7"] });
    expect(next.caFingerprint256).toBe(first.caFingerprint256);
    expect(next.fingerprint256).not.toBe(first.fingerprint256);
    expect(next.names).toContain("10.0.0.7");
    // A device that trusts the CA trusts the new certificate too.
    expect(new X509Certificate(next.cert).verify(new X509Certificate(first.caCert!).publicKey)).toBe(true);
  });

  it("keeps the certificate when a name goes away", () => {
    const first = ensure();
    expect(ensure({ names: NAMES.slice(1) }).fingerprint256).toBe(first.fingerprint256);
  });

  it("reissues the server certificate inside the renewal window, keeping the CA", () => {
    const first = ensure();
    const justBefore = NOW + (SERVER_VALIDITY_DAYS - RENEW_BEFORE_DAYS) * DAY - 1000;
    expect(ensure({ now: justBefore }).fingerprint256).toBe(first.fingerprint256);
    const renewed = ensure({ now: justBefore + 2000 });
    expect(renewed.fingerprint256).not.toBe(first.fingerprint256);
    expect(renewed.caFingerprint256).toBe(first.caFingerprint256);
  });

  it("replaces the CA, and with it the server certificate, when the CA nears expiry", () => {
    const first = ensure();
    const later = ensure({ now: NOW + (CA_VALIDITY_DAYS - RENEW_BEFORE_DAYS) * DAY + 1000 });
    expect(later.caFingerprint256).not.toBe(first.caFingerprint256);
    expect(new X509Certificate(later.cert).verify(new X509Certificate(later.caCert!).publicKey)).toBe(true);
  });

  it("recovers from a missing, damaged or mismatched file", () => {
    const first = ensure();

    fs.rmSync(file(SERVER_KEY_FILE));
    const afterMissingKey = ensure();
    expect(afterMissingKey.fingerprint256).not.toBe(first.fingerprint256);
    expect(afterMissingKey.caFingerprint256).toBe(first.caFingerprint256);

    fs.writeFileSync(file(SERVER_CERT_FILE), "not a certificate");
    expect(ensure().caFingerprint256).toBe(first.caFingerprint256);

    // A key that belongs to some other certificate.
    const stray = createCertificateAuthority({
      commonName: "stray",
      notBefore: new Date(NOW - DAY),
      notAfter: new Date(NOW + 365 * DAY),
    });
    fs.writeFileSync(file(CA_KEY_FILE), stray.key);
    const afterBadCaKey = ensure();
    expect(afterBadCaKey.caFingerprint256).not.toBe(first.caFingerprint256);
    expect(new X509Certificate(afterBadCaKey.cert).verify(new X509Certificate(afterBadCaKey.caCert!).publicKey)).toBe(true);
  });

  it("does not adopt a server certificate signed by another CA", () => {
    const first = ensure();
    const otherCa = createCertificateAuthority({
      commonName: "Filament DB Local CA (studio)",
      notBefore: new Date(NOW - DAY),
      notAfter: new Date(NOW + 3650 * DAY),
    });
    const foreign = createServerCertificate({
      caCert: otherCa.cert,
      caKey: otherCa.key,
      commonName: "Filament DB (studio)",
      names: NAMES,
      notBefore: new Date(NOW - DAY),
      notAfter: new Date(NOW + 300 * DAY),
    });
    fs.writeFileSync(file(SERVER_CERT_FILE), foreign.cert);
    fs.writeFileSync(file(SERVER_KEY_FILE), foreign.key);
    const tls = ensure();
    expect(tls.caFingerprint256).toBe(first.caFingerprint256);
    expect(tls.fingerprint256).not.toBe(new X509Certificate(foreign.cert).fingerprint256);
    expect(new X509Certificate(tls.cert).verify(new X509Certificate(first.caCert!).publicKey)).toBe(true);
  });

  it("does not use a non-CA certificate as the CA", () => {
    const first = ensure();
    // Put the server certificate + key where the CA belongs.
    fs.copyFileSync(file(SERVER_CERT_FILE), file(CA_CERT_FILE));
    fs.copyFileSync(file(SERVER_KEY_FILE), file(CA_KEY_FILE));
    const tls = ensure();
    expect(new X509Certificate(tls.caCert!).ca).toBe(true);
    expect(tls.caFingerprint256).not.toBe(first.fingerprint256);
  });

  it("labels the certificates 'local' when there is no host name", () => {
    expect(new X509Certificate(ensure({ label: "  " }).cert).subject).toBe("CN=Filament DB (local)");
  });
});

describe("loadCustomTls", () => {
  function ownCertificate() {
    const ca = createCertificateAuthority({
      commonName: "Home CA",
      notBefore: new Date(NOW - DAY),
      notAfter: new Date(NOW + 3650 * DAY),
    });
    const server = createServerCertificate({
      caCert: ca.cert,
      caKey: ca.key,
      commonName: "filament.example.net",
      names: ["filament.example.net", "*.home.example.net", "10.0.0.5"],
      notBefore: new Date(NOW - DAY),
      notAfter: new Date(NOW + 90 * DAY),
    });
    return { ca, server };
  }

  it("loads a certificate and key, reporting its names and expiry", () => {
    const { ca, server } = ownCertificate();
    // A full chain file: the server certificate first, then its issuer.
    fs.writeFileSync(file("fullchain.pem"), server.cert + ca.cert);
    fs.writeFileSync(file("privkey.pem"), server.key);
    const tls = loadCustomTls(file("fullchain.pem"), file("privkey.pem"));
    expect(tls).toMatchObject({
      mode: "custom",
      cert: server.cert + ca.cert,
      key: server.key,
      caCert: null,
      caFingerprint256: null,
      fingerprint256: new X509Certificate(server.cert).fingerprint256,
      notAfter: new Date(NOW + 90 * DAY).toISOString(),
      names: ["filament.example.net", "*.home.example.net", "10.0.0.5"],
    });
  });

  it("reports a missing file without echoing its path", () => {
    expect(() => loadCustomTls(file("missing.pem"), file("missing.key"))).toThrow(
      "Could not read the TLS certificate or key file (ENOENT).",
    );
  });

  it("reports content that is not PEM", () => {
    const { server } = ownCertificate();
    fs.writeFileSync(file("cert.pem"), "garbage");
    fs.writeFileSync(file("key.pem"), server.key);
    expect(() => loadCustomTls(file("cert.pem"), file("key.pem"))).toThrow(/not valid PEM/);
    fs.writeFileSync(file("cert.pem"), server.cert);
    fs.writeFileSync(file("key.pem"), "garbage");
    expect(() => loadCustomTls(file("cert.pem"), file("key.pem"))).toThrow(/not valid PEM/);
  });

  it("reports a key that belongs to another certificate", () => {
    const { ca, server } = ownCertificate();
    fs.writeFileSync(file("cert.pem"), server.cert);
    fs.writeFileSync(file("key.pem"), ca.key);
    expect(() => loadCustomTls(file("cert.pem"), file("key.pem"))).toThrow(
      "The TLS key does not belong to the TLS certificate.",
    );
  });

  it("reports no names for a certificate without a subjectAltName", () => {
    const { ca } = ownCertificate();
    fs.writeFileSync(file("cert.pem"), ca.cert);
    fs.writeFileSync(file("key.pem"), ca.key);
    expect(loadCustomTls(file("cert.pem"), file("key.pem")).names).toEqual([]);
  });
});

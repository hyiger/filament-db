import { describe, it, expect } from "vitest";
import {
  caCertificateUrl,
  normalizeServerAddress,
  parseServerAddress,
  sameServer,
  withScheme,
} from "../packages/mobile/src/lib/serverAddress";

/**
 * The mobile app's server-address parsing. `sameServer` is what decides
 * whether a saved API key may be reused for the address in the form, so its
 * edges are pinned here rather than left to `URL`'s behaviour on Hermes.
 */
describe("normalizeServerAddress", () => {
  it("trims, drops trailing slashes and reads a blank as not set", () => {
    expect(normalizeServerAddress("  https://192.168.1.50:3457//  ")).toBe("https://192.168.1.50:3457");
    expect(normalizeServerAddress("")).toBeNull();
    expect(normalizeServerAddress("   ")).toBeNull();
    expect(normalizeServerAddress(null)).toBeNull();
    expect(normalizeServerAddress(undefined)).toBeNull();
  });
});

describe("parseServerAddress", () => {
  it("reads a secure-gateway address", () => {
    expect(parseServerAddress("https://192.168.1.50:3457")).toEqual({
      scheme: "https",
      host: "192.168.1.50",
      port: 3457,
      origin: "https://192.168.1.50:3457",
    });
  });

  it("still reads the http address of a desktop older than the gateway", () => {
    expect(parseServerAddress("http://192.168.1.50:3456")).toEqual({
      scheme: "http",
      host: "192.168.1.50",
      port: 3456,
      origin: "http://192.168.1.50:3456",
    });
  });

  it("fills in the scheme's default port", () => {
    expect(parseServerAddress("https://filament.example.com")?.port).toBe(443);
    expect(parseServerAddress("http://nas.local")?.port).toBe(80);
  });

  it("normalizes case, a trailing dot and a path", () => {
    expect(parseServerAddress("HTTPS://Studio-Mac.LOCAL.:3457/")?.origin).toBe(
      "https://studio-mac.local:3457",
    );
    expect(parseServerAddress("https://host.example/filament-db")?.origin).toBe(
      "https://host.example:443",
    );
  });

  it("reads a bracketed IPv6 literal", () => {
    expect(parseServerAddress("https://[fd00::1]:3457")).toEqual({
      scheme: "https",
      host: "[fd00::1]",
      port: 3457,
      origin: "https://[fd00::1]:3457",
    });
    expect(parseServerAddress("http://[::1]")?.port).toBe(80);
  });

  it("refuses anything that is not an http(s) address with a host", () => {
    for (const bad of [
      "",
      "192.168.1.50:3457",
      "ftp://192.168.1.50",
      "javascript:alert(1)",
      "https://",
      "https:///api",
      "https://:3457",
      "https://host:",
      "https://host:0",
      "https://host:65536",
      "https://host:34a7",
      "https://host:1:2",
      "https://ho st:3457",
      "https://[fd00::1",
      "https://[fd00::1]x",
      "https://[fd00::1]:",
      "https://[not-v6]:3457",
    ]) {
      expect(parseServerAddress(bad), bad).toBeNull();
    }
  });

  it("refuses credentials in the address", () => {
    // Reads as "192.168.1.50" while the request would go to evil.example.
    expect(parseServerAddress("https://192.168.1.50:3457@evil.example")).toBeNull();
    expect(parseServerAddress("https://user:pass@192.168.1.50:3457")).toBeNull();
  });
});

describe("sameServer", () => {
  it("is true only for the same scheme, host and port", () => {
    expect(sameServer("https://192.168.1.50:3457", "https://192.168.1.50:3457/")).toBe(true);
    expect(sameServer("https://Host.local:443", "https://host.local")).toBe(true);
    // Scheme: the https gateway and a plain-http listener are different servers.
    expect(sameServer("https://192.168.1.50:3457", "http://192.168.1.50:3457")).toBe(false);
    // Host.
    expect(sameServer("https://192.168.1.50:3457", "https://192.168.1.51:3457")).toBe(false);
    // Port: another process on the same machine.
    expect(sameServer("https://192.168.1.50:3457", "https://192.168.1.50:3458")).toBe(false);
  });

  it("is false when either side is missing or unparseable", () => {
    expect(sameServer(null, null)).toBe(false);
    expect(sameServer("https://192.168.1.50:3457", null)).toBe(false);
    expect(sameServer("https://192.168.1.5", "https://192.168.1.50")).toBe(false);
    expect(sameServer("nonsense", "nonsense")).toBe(false);
  });
});

describe("caCertificateUrl", () => {
  it("is the plain-HTTP download on the HTTPS port", () => {
    expect(caCertificateUrl("https://192.168.1.50:3457")).toBe(
      "http://192.168.1.50:3457/__filamentdb/ca.crt",
    );
    expect(caCertificateUrl("https://nas.local/")).toBe("http://nas.local:443/__filamentdb/ca.crt");
    expect(caCertificateUrl("https://[fd00::1]:3457")).toBe(
      "http://[fd00::1]:3457/__filamentdb/ca.crt",
    );
  });

  it("is null when there is nothing to trust", () => {
    expect(caCertificateUrl("http://192.168.1.50:3456")).toBeNull();
    expect(caCertificateUrl("nonsense")).toBeNull();
    expect(caCertificateUrl(null)).toBeNull();
  });
});

describe("withScheme", () => {
  it("keeps host and port and swaps the scheme", () => {
    expect(withScheme("http://192.168.1.50:3457", "https")).toBe("https://192.168.1.50:3457");
    expect(withScheme("https://192.168.1.50:3456/", "http")).toBe("http://192.168.1.50:3456");
    expect(withScheme("nonsense", "https")).toBeNull();
  });
});

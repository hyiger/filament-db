import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLookup } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
}));

// Stub dns.lookup so the IPv4/IPv6 matrix tests don't depend on the host
// being able to resolve example.com / RFC2606 names. Real DNS would be
// flaky in CI sandboxes anyway.
vi.mock("node:dns/promises", () => ({
  lookup: mockLookup,
}));

import { isPrivateIp, assertExternalUrl } from "@/lib/externalUrlGuard";

/**
 * SSRF guard tests. The module is security-critical (used by the TDS
 * extractor and the iframe-embed checker) and previously had zero
 * dedicated tests — caught by the v1.12.6 audit. Coverage focuses on
 * the IP-block list and the `assertExternalUrl` resolution path.
 */

describe("isPrivateIp — IPv4 block list", () => {
  // Cloud-metadata + RFC1918 + loopback + link-local + CG-NAT + multicast.
  // Each row mirrors a real adversary surface; if any of these stops
  // returning true an SSRF gap opens up immediately.
  const blocked = [
    ["0.0.0.0", "0.0.0.0/8 wildcard"],
    ["10.0.0.1", "10.0.0.0/8 RFC1918"],
    ["10.255.255.254", "10.0.0.0/8 upper bound"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "127.0.0.0/8 upper bound"],
    ["169.254.169.254", "AWS/GCP/Azure metadata service"],
    ["169.254.0.1", "link-local lower bound"],
    ["172.16.0.1", "172.16/12 lower"],
    ["172.31.255.254", "172.16/12 upper"],
    ["192.168.0.1", "RFC1918"],
    ["192.168.1.1", "RFC1918 home routers"],
    ["100.64.0.1", "CG-NAT (RFC6598)"],
    ["100.127.255.254", "CG-NAT upper bound"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast upper"],
    ["240.0.0.1", "240/4 reserved"],
    ["255.255.255.255", "broadcast"],
  ] as const;

  it.each(blocked)("%s — %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  // Public IPs that must pass through (otherwise legitimate fetches break).
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255", // just below 172.16/12
    "172.32.0.1", // just above 172.16/12
    "172.31.255.255", // exact upper of 172.16/12 — wait, this is actually blocked (in range)
    "100.63.255.254", // just below CG-NAT
    "100.128.0.1", // just above CG-NAT
    "192.169.0.1", // just above 192.168/16
    "11.0.0.1", // just above 10/8
    "9.255.255.255", // just below 10/8
    "169.253.0.1", // just below link-local
    "169.255.0.1", // just above link-local
    "126.255.255.255", // just below loopback /8
    "128.0.0.1", // just above loopback /8
  ];

  for (const ip of allowed) {
    if (ip === "172.31.255.255") continue; // genuinely private, exclude from "allowed"
    it(`${ip} — public, must not be blocked`, () => {
      expect(isPrivateIp(ip)).toBe(false);
    });
  }

  // Unparseable input should fail closed.
  it("returns true (block) for unparseable IPv4 strings", () => {
    expect(isPrivateIp("999.999.999.999")).toBe(true);
    expect(isPrivateIp("1.2.3")).toBe(true);
    expect(isPrivateIp("1.2.3.4.5")).toBe(true);
    expect(isPrivateIp("a.b.c.d")).toBe(true);
  });
});

describe("isPrivateIp — IPv6 block list", () => {
  const blocked = [
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fe80:0000:0000:0000:0000:0000:0000:0001", "expanded link-local"],
    ["fc00::1", "unique-local lower"],
    ["fd00::1", "unique-local upper"],
    ["ff00::1", "multicast"],
    ["ff02::1", "all-nodes multicast"],
  ] as const;

  it.each(blocked)("%s — %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it("recurses into IPv4-mapped IPv6 (::ffff:10.0.0.1 must be blocked)", () => {
    // RFC4291 IPv4-mapped form. An attacker-controlled DNS that returns
    // this would otherwise smuggle an RFC1918 address past a v6-only check.
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("::FFFF:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
  });

  it("allows public IPv6 (Google / Cloudflare DNS)", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertExternalUrl", () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it("rejects invalid URL strings", async () => {
    await expect(assertExternalUrl("not a url")).rejects.toThrow(/Invalid URL/);
  });

  it("rejects file:// scheme", async () => {
    await expect(assertExternalUrl("file:///etc/passwd")).rejects.toThrow(/scheme/);
  });

  it("rejects gopher:// scheme", async () => {
    await expect(assertExternalUrl("gopher://example.com/")).rejects.toThrow(/scheme/);
  });

  it("rejects ftp:// scheme", async () => {
    await expect(assertExternalUrl("ftp://example.com/")).rejects.toThrow(/scheme/);
  });

  it("rejects javascript: scheme", async () => {
    await expect(assertExternalUrl("javascript:alert(1)")).rejects.toThrow(/scheme/);
  });

  it("rejects data: scheme", async () => {
    await expect(assertExternalUrl("data:text/html,<script>alert(1)</script>")).rejects.toThrow(/scheme/);
  });

  it("rejects URLs without a hostname", async () => {
    // file: was already rejected by the scheme check; build a valid-but-
    // hostnameless URL via the URL parser. Empty host on http is rejected
    // by URL itself, so the closest we can hit is via the http: path
    // when the URL parses to an empty hostname.
    await expect(assertExternalUrl("http://")).rejects.toThrow();
  });

  it("rejects literal RFC1918 IPv4 address", async () => {
    await expect(assertExternalUrl("http://10.0.0.1/foo")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("rejects literal AWS metadata IP", async () => {
    await expect(assertExternalUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("rejects literal IPv6 loopback", async () => {
    await expect(assertExternalUrl("http://[::1]/foo")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("rejects hostname that resolves to a private IP", async () => {
    // Classic DNS-resolution SSRF: attacker registers
    // example.com → A record 192.168.0.1. Without resolving, a
    // string-only check would let it through.
    mockLookup.mockResolvedValue([{ address: "192.168.0.1", family: 4 }]);
    await expect(assertExternalUrl("https://attacker.example/")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("rejects hostname that resolves to multiple IPs if ANY is private", async () => {
    // dual-stack attacker: returns a public v4 + a private v6 to bypass
    // a naive "first record only" check.
    mockLookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "fd00::1", family: 6 },
    ]);
    await expect(assertExternalUrl("https://mixed.example/")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("rejects hostname that does not resolve at all", async () => {
    mockLookup.mockResolvedValue([]);
    await expect(assertExternalUrl("https://nonexistent.invalid/")).rejects.toThrow(
      /does not resolve/,
    );
  });

  it("returns the parsed URL for a public hostname", async () => {
    mockLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const url = await assertExternalUrl("https://example.com/path?q=1");
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("example.com");
    expect(url.pathname).toBe("/path");
  });

  it("does not call DNS for a literal public IPv4 address", async () => {
    const url = await assertExternalUrl("http://8.8.8.8/");
    expect(url.hostname).toBe("8.8.8.8");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("does not call DNS for a literal public IPv6 address", async () => {
    const url = await assertExternalUrl("http://[2001:4860:4860::8888]/");
    expect(url.hostname).toBe("[2001:4860:4860::8888]");
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

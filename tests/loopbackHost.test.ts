import { describe, it, expect } from "vitest";
import { isLoopbackHostname } from "../src/lib/loopbackHost";

/**
 * Pin every loopback hostname shape we care about, so a future
 * refactor of the label-printer public-URL validator can't silently
 * accept "http://[::1]:3456" again (the Codex P2 round 2 catch on
 * PR #487).
 */

describe("isLoopbackHostname — should return true for", () => {
  const cases = [
    // Name forms
    "localhost",
    "Localhost", // case-insensitive
    "LOCALHOST",

    // IPv4 loopback range — anything in 127.0.0.0/8
    "127.0.0.1",
    "127.0.0.0",
    "127.255.255.255",
    "127.1.2.3",

    // The all-zeros bind address (humans type this to mean "this machine")
    "0.0.0.0",

    // IPv6 unspecified address — the v6 analog of 0.0.0.0 (Codex P2
    // round 10 on PR #487)
    "::",
    "[::]",
    "0:0:0:0:0:0:0:0",
    "[0:0:0:0:0:0:0:0]",

    // IPv6 loopback, every representation URL.hostname can produce
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "[0:0:0:0:0:0:0:1]",

    // IPv4-mapped IPv6 loopback
    "::ffff:127.0.0.1",
    "[::ffff:127.0.0.1]",
    "::ffff:127.42.13.9",
    "::FFFF:127.0.0.1", // mixed case

    // IPv4-mapped IPv6 unspecified — the v6-mapped form of 0.0.0.0
    // (Codex P2 round 12 on PR #487)
    "::ffff:0.0.0.0",
    "[::ffff:0.0.0.0]",
    "::ffff:0:0", // Node's URL parser normalises the dotted form here
    "::ffff:0000:0000", // padded hex
    "[::ffff:0:0]",

    // DNS absolute-name notation (trailing dot) — same meaning, but
    // URL.hostname preserves it, so any equality-based check has to
    // strip first. (Codex P2 round 3 on PR #487.)
    "localhost.",
    "localhost..", // multiple trailing dots
    "127.0.0.1.",
    "0.0.0.0.",
  ];

  for (const hostname of cases) {
    it(`"${hostname}"`, () => {
      expect(isLoopbackHostname(hostname)).toBe(true);
    });
  }
});

describe("isLoopbackHostname — should return false for", () => {
  const cases = [
    // Real public addresses
    "filament-db.local",
    "example.com",
    "subdomain.example.com",

    // Real private LAN addresses (not loopback — scanners on the same
    // LAN CAN reach these, so we don't gate on them)
    "192.168.1.10",
    "10.0.0.5",
    "172.16.0.1",

    // Public IPv4 that happens to start with 1 but isn't 127.x
    "128.0.0.1",
    "126.0.0.1",
    "12.7.0.0.1", // not a valid address shape

    // Empty / nonsense
    "",
    "not a host",
  ];

  for (const hostname of cases) {
    it(`"${hostname}"`, () => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    });
  }
});

describe("isLoopbackHostname — matches the URL.hostname output for common loopback URLs", () => {
  // This is the user's most common typo path — they paste
  // http://localhost:3456 into Settings → Label Printer. The
  // validator runs `new URL(value).hostname` then this function.
  // Pin the end-to-end so a regression there gets caught loudly.
  const urls = [
    "http://localhost:3456",
    "https://localhost",
    "http://127.0.0.1:3456",
    "http://127.0.0.1",
    "http://[::1]:3456",
    "https://[::1]/",
    "http://[0:0:0:0:0:0:0:1]:3456",
    "http://[::ffff:127.0.0.1]:3456",
    "http://0.0.0.0:3456",
    // DNS absolute-name forms — what a user would paste if they
    // copy-pasted from a DNS tool or made a typo. (Codex P2 round 3
    // on PR #487.)
    "http://localhost.:3456",
    "https://localhost./",
    "http://127.0.0.1.:3456",
    // IPv6 unspecified bind address (Codex P2 round 10 on PR #487)
    "http://[::]:3456",
    "http://[0:0:0:0:0:0:0:0]:3456",
    // IPv4-mapped IPv6 unspecified (Codex P2 round 12 on PR #487)
    "http://[::ffff:0.0.0.0]:3456",
    "http://[::ffff:0:0]:3456",
  ];
  for (const url of urls) {
    it(url, () => {
      const hostname = new URL(url).hostname;
      expect(isLoopbackHostname(hostname)).toBe(true);
    });
  }
});

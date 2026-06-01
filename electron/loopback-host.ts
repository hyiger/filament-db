/**
 * True when `hostname` (as returned by URL.hostname) addresses the
 * local machine. Used by the label-printer public-URL validator to
 * reject any base URL that scanners on other devices wouldn't be able
 * to resolve.
 *
 * Handles every shape we've seen URL.hostname produce:
 *   - "localhost"
 *   - IPv4 loopback: 127.0.0.0/8 (commonly 127.0.0.1)
 *   - IPv6 loopback bare:      "::1"
 *   - IPv6 loopback bracketed: "[::1]"  ← URL.hostname keeps the
 *     brackets for IPv6 literals, which the original PR-487 round-1
 *     check missed (Codex P2 round 2 on PR #487)
 *   - IPv6 loopback uncompressed: "0:0:0:0:0:0:0:1" (+ bracketed)
 *   - IPv4-mapped IPv6 loopback: "::ffff:127.0.0.1" (+ bracketed)
 *   - The all-zeros bind: "0.0.0.0" (functionally listens-anywhere
 *     but typed in by humans to mean "this machine")
 *
 * Lives in its own file so tests in tests/loopback-host.test.ts can
 * exercise it without importing electron/main.ts (which has heavy
 * import-time side effects).
 */
export function isLoopbackHostname(hostname: string): boolean {
  // Strip IPv6 literal brackets if present.
  let h = hostname;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.toLowerCase();

  // DNS absolute-name notation appends a trailing dot — `localhost.`,
  // `127.0.0.1.`, etc. — and the URL parser preserves it. They still
  // address the local machine, so trim before comparing. Multiple
  // trailing dots are also valid per DNS; strip them all. (Codex P2
  // round 3 on PR #487.)
  h = h.replace(/\.+$/, "");

  if (h === "localhost" || h === "0.0.0.0") return true;

  // IPv6 unspecified address `::` is the v6 analog of 0.0.0.0 —
  // bind-anywhere — and means the same thing for our purposes
  // (the QR scanner would route to its own machine). Brackets are
  // already stripped above. (Codex P2 round 10 on PR #487.)
  if (h === "::") return true;
  if (/^0+(:0+){7}$/.test(h)) return true; // "0:0:0:0:0:0:0:0" etc

  // IPv4 loopback range 127.0.0.0/8 — anything 127.x.x.x.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;

  // IPv6 loopback in any of its representations.
  if (h === "::1") return true;
  if (/^(0+:){7}0*1$/.test(h)) return true; // "0:0:0:0:0:0:0:1" etc

  // IPv4-mapped IPv6 loopback, dotted form: ::ffff:127.x.x.x
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // ...and the hex-encoded form Node's URL parser normalises it to:
  // `new URL("http://[::ffff:127.0.0.1]").hostname` returns
  // "[::ffff:7f00:1]" (or "[::ffff:7f00:0001]"). 127.x.x.x → first
  // octet is 0x7f, so the prefix `::ffff:7fNN:YYYY` covers all of
  // 127/8 in hex form. Brackets already stripped above.
  if (/^::ffff:7f[0-9a-f]{0,2}:[0-9a-f]{1,4}$/.test(h)) return true;

  return false;
}

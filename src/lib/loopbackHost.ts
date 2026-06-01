/**
 * True when `hostname` (as returned by URL.hostname) addresses the
 * local machine. Used by the label-printer public-URL validator
 * (electron/main.ts) and by the PrintLabelDialog's UX-gate for
 * URL-mode QRs (src/components/PrintLabelDialog.tsx) — both sides
 * must agree, so the helper is shared from src/lib/ rather than
 * duplicated. (Codex P2 round 11 on PR #487 caught the original
 * drift when the renderer was using a much weaker regex.)
 *
 * Pure regex / string ops — no Node OR browser deps, so the same
 * function runs in:
 *   - Electron main (validator at write time, security boundary)
 *   - Renderer (UX gate at preview time, prevents printing an
 *     unscannable QR before the user clicks Print)
 *   - Vitest tests in tests/loopbackHost.test.ts
 *
 * Handles every shape URL.hostname can produce:
 *   - "localhost" (case-insensitive)
 *   - DNS absolute-name notation with trailing dot ("localhost.",
 *     "127.0.0.1.", etc.) — Codex P2 round 3 on PR #487
 *   - IPv4 loopback: 127.0.0.0/8 (commonly 127.0.0.1)
 *   - IPv4 unspecified bind: "0.0.0.0"
 *   - IPv6 loopback bare:      "::1"
 *   - IPv6 loopback bracketed: "[::1]"  ← URL.hostname keeps the
 *     brackets for IPv6 literals (Codex P2 round 2)
 *   - IPv6 loopback uncompressed: "0:0:0:0:0:0:0:1" (+ bracketed)
 *   - IPv4-mapped IPv6 loopback: "::ffff:127.0.0.1" (+ bracketed)
 *   - ...and the hex-normalised form Node's URL parser produces:
 *     "::ffff:7fNN:YYYY"
 *   - IPv6 unspecified bind: "::" (+ "[::]", "0:0:0:0:0:0:0:0") —
 *     the v6 analog of "0.0.0.0" (Codex P2 round 10)
 */
export function isLoopbackHostname(hostname: string): boolean {
  // Strip IPv6 literal brackets if present.
  let h = hostname;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.toLowerCase();

  // DNS absolute-name notation appends a trailing dot — `localhost.`,
  // `127.0.0.1.`, etc. — and the URL parser preserves it. They still
  // address the local machine, so trim before comparing. Multiple
  // trailing dots are also valid per DNS; strip them all.
  h = h.replace(/\.+$/, "");

  if (h === "localhost" || h === "0.0.0.0") return true;

  // IPv6 unspecified address — the v6 analog of 0.0.0.0.
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
  // 127.x.x.x → first octet is 0x7f, so the prefix `::ffff:7fNN:YYYY`
  // covers all of 127/8 in hex form.
  if (/^::ffff:7f[0-9a-f]{0,2}:[0-9a-f]{1,4}$/.test(h)) return true;

  // IPv4-mapped IPv6 unspecified (the v6-mapped form of 0.0.0.0).
  // Dotted: `::ffff:0.0.0.0`. Hex-normalised by Node's URL parser:
  // `::ffff:0:0` (or with leading zeros `::ffff:0000:0000`). Same
  // bind-anywhere semantic as bare 0.0.0.0 / ::. (Codex P2 round 12
  // on PR #487.)
  if (h === "::ffff:0.0.0.0") return true;
  if (/^::ffff:0+:0+$/.test(h)) return true;

  return false;
}

/**
 * Parse a URL string and return true when its origin addresses the
 * local machine. Convenience wrapper around `isLoopbackHostname` that
 * the renderer uses on `window.location.origin` to decide whether
 * URL-mode QRs are safe to enable.
 *
 * Returns false on unparseable input — better to let the user try
 * than to silently disable the option on a parser quirk.
 */
export function isLoopbackUrl(urlString: string): boolean {
  try {
    return isLoopbackHostname(new URL(urlString).hostname);
  } catch {
    return false;
  }
}

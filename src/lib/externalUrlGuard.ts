/**
 * Shared SSRF guard for any code path that fetches a user-supplied URL.
 *
 * Used by:
 *   - src/lib/tdsExtractor.ts — TDS document fetcher
 *   - src/app/api/embed-check/route.ts — iframe-embeddability probe
 *
 * Two layers of defence:
 *   1. `assertExternalUrl` — a pre-flight scheme + resolved-IP check.
 *   2. `ssrfDispatcher` — an undici dispatcher that re-validates the IP
 *      at *connection* time. The pre-flight check alone is defeated by
 *      DNS rebinding (the guard resolves one IP, then `fetch` resolves
 *      again and may get a different, private one — GH #256); the
 *      dispatcher closes that TOCTOU by pinning the connection to the
 *      exact IP it validated. Callers fetching user URLs MUST pass
 *      `dispatcher: ssrfDispatcher`.
 */

import dns from "node:dns";
import { lookup } from "node:dns/promises";
import { Agent, interceptors } from "undici";

/** Range-check a dotted-quad IPv4 string. Conservative on parse failure. */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // unparseable → block conservatively
  }
  const [a, b, c] = parts;
  if (a === 0) return true;                              // 0.0.0.0/8
  if (a === 10) return true;                             // 10.0.0.0/8 (RFC1918)
  if (a === 127) return true;                            // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 (link-local + cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 (CG-NAT, RFC6598)
  if (a === 192 && b === 0 && c === 0) return true;      // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 198 && (b === 18 || b === 19)) return true;  // 198.18.0.0/15 (network benchmark)
  if (a >= 224) return true;                             // 224.0.0.0/4 multicast + 240/4 reserved
  return false;
}

/**
 * Expand an IPv6 literal to its 8 numeric 16-bit groups, or null if it
 * isn't a parseable IPv6 address. Handles `::` zero-compression and a
 * trailing embedded IPv4 dotted-quad (`::ffff:1.2.3.4`).
 */
function expandIpv6(ip: string): number[] | null {
  // Drop a zone id (fe80::1%eth0) before parsing.
  let s = ip.toLowerCase().trim().split("%")[0];

  // A trailing embedded IPv4 dotted-quad → fold into two hex groups.
  const v4Match = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const quad = v4Match[2].split(".").map(Number);
    if (quad.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const h1 = ((quad[0] << 8) | quad[1]).toString(16);
    const h2 = ((quad[2] << 8) | quad[3]).toString(16);
    s = `${v4Match[1]}${h1}:${h2}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // `::` must stand for at least one group
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

/**
 * Block-list for SSRF defence: loopback, RFC1918 private, link-local,
 * cloud-metadata IPs, multicast, and the IPv6 equivalents. Returns true
 * when an address must NOT be fetched. Conservative on parse failure.
 *
 * GH #257: IPv4-mapped IPv6 is canonicalised to its embedded IPv4 and
 * range-checked there — covering the dotted form (`::ffff:127.0.0.1`),
 * the hex-group form (`::ffff:7f00:1`) and the fully-expanded form
 * (`0:0:0:0:0:ffff:7f00:1`), all of which the old string-prefix check
 * let through.
 */
export function isPrivateIp(ip: string): boolean {
  const cleaned = ip.trim().replace(/^\[|\]$/g, "");

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleaned)) {
    return isPrivateIpv4(cleaned);
  }

  const groups = expandIpv6(cleaned);
  if (!groups) return true; // unparseable → block conservatively

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96, deprecated):
  // the address is really IPv4 — range-check the embedded quad. This is
  // what closes the hex-group bypass (e.g. ::ffff:a9fe:a9fe → metadata).
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 &&
    (groups[5] === 0xffff || groups[5] === 0)
  ) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPrivateIpv4(v4);
  }

  // NAT64 (64:ff9b::/96) carries an embedded IPv4 in the low 32 bits — a
  // NAT64-wrapped metadata/private address (e.g. 64:ff9b::a9fe:a9fe →
  // 169.254.169.254) must be range-checked, not treated as a public IPv6 (#673).
  if (
    groups[0] === 0x0064 && groups[1] === 0xff9b &&
    groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0
  ) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPrivateIpv4(v4);
  }

  // 6to4 (2002::/16) embeds the destination IPv4 in groups 1-2; block when that
  // embedded address is private (e.g. 2002:c0a8:0101:: → 192.168.1.1) (#673).
  if (groups[0] === 0x2002) {
    const v4 = `${groups[1] >> 8}.${groups[1] & 0xff}.${groups[2] >> 8}.${groups[2] & 0xff}`;
    return isPrivateIpv4(v4);
  }

  const first = groups[0];
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Validate a user-supplied URL for outbound fetch. Throws on:
 *   - non-http(s) schemes (file:, gopher:, ftp:, …)
 *   - hostnames that resolve to loopback / private / link-local / metadata IPs
 *
 * Returns the parsed URL on success so callers don't need to parse twice.
 * This is the pre-flight check; the fetch itself must still go through
 * `ssrfDispatcher` to be safe against DNS rebinding (GH #256).
 */
export async function assertExternalUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Tag the message so the apiErrorHandler 400-classifier matches THIS
    // path specifically. The bare `new URL(...)` constructor (used by the
    // TDS redirect-resolver in src/lib/tdsExtractor.ts) also throws
    // "Invalid URL" when an upstream Location header is malformed; that
    // case is an upstream/bad-gateway condition, not user input, so it
    // must NOT be mapped to 400 (Codex review on PR #167).
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Disallowed URL scheme "${parsed.protocol}" — only http(s) is supported.`);
  }
  if (!parsed.hostname) throw new Error("URL has no hostname");

  // GH #955: the IPv6 alternative requires a colon (every real IPv6 literal has
  // one), so a colon-less hex label like "cafe" or "deadbeef" is no longer
  // misclassified as an IP literal — it falls through to DNS resolution +
  // per-address isPrivateIp (the stronger check), not weaker. The dot in the
  // class covers the embedded-IPv4 forms (::ffff:127.0.0.1).
  const looksLikeIp = /^(\d+\.){3}\d+$|^\[?[\da-f.:]*:[\da-f.:]*\]?$/i.test(parsed.hostname);
  let ips: string[];
  if (looksLikeIp) {
    ips = [parsed.hostname.replace(/^\[|\]$/g, "")];
  } else {
    const records = await lookup(parsed.hostname, { all: true }).catch(() => []);
    if (records.length === 0) {
      throw new Error(`URL hostname does not resolve: ${parsed.hostname}`);
    }
    ips = records.map((r) => r.address);
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new Error("URL resolves to a private/internal address — only public hosts are allowed.");
    }
  }
  return parsed;
}

/**
 * GH #256: a DNS `lookup` that resolves the host AND rejects the request
 * if any returned address is private/internal. undici's DNS interceptor
 * pins the connection to the address this returns, so validating here —
 * rather than in a separate pre-flight resolve — eliminates the rebinding
 * TOCTOU: the IP that is checked is the exact IP that is connected to.
 */
function ssrfValidatingLookup(
  origin: { hostname: string },
  _opts: unknown,
  cb: (err: Error | null, addresses?: dns.LookupAddress[]) => void,
): void {
  dns.lookup(
    origin.hostname,
    { all: true, family: 0, order: "ipv4first" },
    (err, addresses) => {
      if (err) {
        cb(err);
        return;
      }
      for (const addr of addresses) {
        if (isPrivateIp(addr.address)) {
          cb(
            new Error(
              `Blocked SSRF: ${origin.hostname} resolved to a private/internal address (${addr.address}).`,
            ),
          );
          return;
        }
      }
      cb(null, addresses);
    },
  );
}

/**
 * undici dispatcher for fetching user-supplied URLs. The DNS interceptor
 * resolves the host through `ssrfValidatingLookup` and pins the socket to
 * that validated IP — so `fetch(url, { dispatcher: ssrfDispatcher })`
 * cannot be rebound onto a private address between guard and connect.
 *
 * GH #258 (Codex P1): `maxItems` bounds the interceptor's per-hostname
 * DNS cache. It defaults to `Infinity`, and this is a process-wide
 * singleton fed user-controlled hosts (embed-check / TDS) — so without
 * a cap an attacker could trigger endless distinct lookups and grow
 * the cache until the process is OOM-killed. 256 is far above any
 * legitimate working set; `maxTTL` (10s default) also ages entries out.
 *
 * The `lookup` cast bridges a known undici quirk: at runtime the
 * interceptor invokes `lookup` with an origin OBJECT (it reads
 * `origin.hostname`), but the published `.d.ts` types the first
 * parameter as a bare string.
 */
type DnsInterceptorLookup = NonNullable<
  NonNullable<Parameters<typeof interceptors.dns>[0]>["lookup"]
>;
export const ssrfDispatcher = new Agent().compose(
  interceptors.dns({
    lookup: ssrfValidatingLookup as unknown as DnsInterceptorLookup,
    maxItems: 256,
  }),
);

/**
 * Read a `fetch` Response body as text with a hard byte budget, aborting
 * the stream once the budget is exceeded. A `content-length` header is
 * advisory — a hostile host can omit or lie about it — so the cap is
 * enforced on the bytes actually received (GH #258).
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(
            `Response body exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
          );
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Shared SSRF guard for any code path that fetches a user-supplied URL.
 *
 * Used by:
 *   - src/lib/tdsExtractor.ts — TDS document fetcher
 *   - src/app/api/embed-check/route.ts — iframe-embeddability probe
 *
 * Both validate the *initial* URL only. Catching redirect-based SSRF
 * requires `redirect: "manual"` plus per-hop validation; intentionally
 * out of scope here to avoid breaking shorteners/CDNs. Callers that
 * need stronger guarantees should also re-check the response URL after
 * following redirects.
 */

import { lookup } from "node:dns/promises";

/**
 * Block-list for SSRF defence: loopback, RFC1918 private, link-local,
 * cloud-metadata IPs, multicast, and the IPv6 equivalents. Returns true
 * when an address must NOT be fetched.
 *
 * Conservative on parse failure (treat unparseable as private). Relies on
 * the OS DNS resolver to expand hostnames; does not attempt to defeat DNS
 * rebinding, which would require re-resolving and comparing against the
 * connection's actual peer address.
 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(".")) {
    const parts = ip.split(".").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true; // unparseable → block conservatively
    }
    const [a, b] = parts;
    if (a === 0) return true;                              // 0.0.0.0/8
    if (a === 10) return true;                             // 10.0.0.0/8 (RFC1918)
    if (a === 127) return true;                            // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true;               // 169.254.0.0/16 (link-local + AWS/GCP/Azure metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 168) return true;               // 192.168.0.0/16 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 (CG-NAT, RFC6598)
    if (a >= 224) return true;                             // 224.0.0.0/4 multicast + 240/4 reserved
    return false;
  }
  // IPv6
  const lc = ip.toLowerCase();
  if (lc === "::" || lc === "::1") return true;
  if (lc.startsWith("fe80:")) return true;                 // link-local
  if (lc.startsWith("fc") || lc.startsWith("fd")) return true; // unique-local fc00::/7
  if (lc.startsWith("ff")) return true;                    // multicast
  if (lc.startsWith("::ffff:")) {
    return isPrivateIp(lc.slice(7)); // IPv4-mapped IPv6 → recurse on the v4 form
  }
  return false;
}

/**
 * Validate a user-supplied URL for outbound fetch. Throws on:
 *   - non-http(s) schemes (file:, gopher:, ftp:, …)
 *   - hostnames that resolve to loopback / private / link-local / metadata IPs
 *
 * Returns the parsed URL on success so callers don't need to parse twice.
 */
export async function assertExternalUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Disallowed URL scheme "${parsed.protocol}" — only http(s) is supported.`);
  }
  if (!parsed.hostname) throw new Error("URL has no hostname");

  const looksLikeIp = /^(\d+\.){3}\d+$|^\[?[\da-f:]+\]?$/i.test(parsed.hostname);
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

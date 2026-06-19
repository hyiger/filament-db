import { isLoopbackUrl } from "@/lib/loopbackHost";

export interface ShareLanInfo {
  ips: string[];
  port: number;
}

export interface ShareBase {
  /** The base URL to build `/share/<slug>` links from. */
  base: string;
  /** True when the origin is loopback and no reachable LAN base is available —
   *  the link only works on this machine, so the UI should warn. */
  warnLocalOnly: boolean;
}

/**
 * GH #780 — choose a reachable base URL for shared-catalog links.
 *
 * On a packaged desktop install the embedded server is reached at
 * `http://localhost:3456`, so a link built from `window.location.origin` is
 * loopback-only and isn't actually shareable. When the instance is genuinely
 * exposed on the LAN (the `exposeToLan` toggle is on) and a LAN IP is known,
 * upgrade the base to `http://<lan-ip>:<port>`. Otherwise leave the origin
 * unchanged — a web/Docker user who browsed in via a real LAN/public address
 * is never rewritten or warned (only a literal loopback origin triggers either).
 *
 * `exposeToLan` is required for the upgrade because `get-lan-ip` reports the
 * host's addresses even when the server is still bound to loopback — handing
 * out an IP that refuses connections would be worse than warning.
 */
export function pickShareBase(
  origin: string,
  lanInfo: ShareLanInfo | null,
  exposeToLan: boolean,
): ShareBase {
  // Empty origin (SSR) or a real, non-loopback origin: use it as-is.
  if (origin === "" || !isLoopbackUrl(origin)) {
    return { base: origin, warnLocalOnly: false };
  }
  // Loopback origin — upgrade to the LAN IP only when the server is actually
  // exposed and an address is known.
  if (exposeToLan && lanInfo && lanInfo.ips.length > 0) {
    return { base: `http://${lanInfo.ips[0]}:${lanInfo.port}`, warnLocalOnly: false };
  }
  return { base: origin, warnLocalOnly: true };
}

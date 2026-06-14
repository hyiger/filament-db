import os from "os";

/**
 * Shape of a single entry in the `os.networkInterfaces()` result. We only
 * read the three fields we care about so the pure picker can be unit-tested
 * with hand-written fixtures instead of the host's real network config.
 */
export interface NetworkAddress {
  address: string;
  /** Node reports "IPv4"/"IPv6" (string) historically and 4/6 (number) on
   *  newer runtimes — accept both. */
  family: string | number;
  internal: boolean;
}

function isPrivateIpv4(ip: string): boolean {
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("10.")) return true;
  // 172.16.0.0 – 172.31.255.255
  const m = /^172\.(\d{1,3})\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

/**
 * Pick the LAN-facing IPv4 addresses from a network-interfaces map. Used to
 * tell the user which URL to point a phone at when "Share on local network"
 * is enabled.
 *
 * - Skips internal/loopback interfaces and IPv6.
 * - Skips link-local 169.254.x.x (APIPA — assigned when DHCP fails; not a
 *   real routable LAN address).
 * - Orders RFC1918 private ranges (192.168/16, 10/8, 172.16–31/12) first, so
 *   a real home/office LAN address sorts ahead of VPN / virtual NICs
 *   (Tailscale 100.64/10, Docker bridges, etc.) when several are present.
 *   Array.prototype.sort is stable in modern V8, so original order is kept
 *   within each group.
 *
 * Pure (takes the interfaces map) for testability; `listLanIpv4()` is the
 * os-backed wrapper the Electron main process calls.
 */
export function pickLanIpv4(
  interfaces: Record<string, NetworkAddress[] | undefined>,
): string[] {
  const candidates: string[] = [];
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const a of addrs) {
      const isV4 = a.family === "IPv4" || a.family === 4;
      if (!isV4 || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue; // link-local APIPA
      candidates.push(a.address);
    }
  }
  candidates.sort((x, y) => (isPrivateIpv4(x) ? 0 : 1) - (isPrivateIpv4(y) ? 0 : 1));
  return candidates;
}

/** os-backed wrapper around {@link pickLanIpv4}. */
export function listLanIpv4(): string[] {
  return pickLanIpv4(
    os.networkInterfaces() as Record<string, NetworkAddress[] | undefined>,
  );
}

import os from "os";
import { Bonjour, type Service, type ServiceConfig } from "bonjour-service";

/**
 * mDNS / Bonjour advertisement for LAN auto-discovery.
 *
 * Advertises this desktop instance as `_filamentdb._tcp` on the local network
 * so the Filament DB mobile scanner app can find it without the user typing an
 * IP address. Only advertised while "Share on local network" is enabled — the
 * embedded server is loopback-only otherwise, so there'd be nothing for a phone
 * to reach (see syncMdnsAdvertisement in electron/main.ts).
 *
 * Uses `bonjour-service` (pure JS, no native dependency).
 */
const SERVICE_TYPE = "filamentdb"; // → `_filamentdb._tcp`
const SERVICE_NAME = "Filament DB";

/** Leading label of the host name the advertisement owns (see advertisedHostName). */
const HOST_PREFIX = "filamentdb";
/** RFC 1035 §2.3.4: a DNS label is at most 63 octets. */
const MAX_DNS_LABEL = 63;

let bonjour: Bonjour | null = null;
let service: Service | null = null;

/** `os.hostname()`, or "" when the OS call throws. */
function readHostname(): string {
  try {
    return os.hostname();
  } catch {
    return "";
  }
}

/**
 * A per-machine instance name. mDNS instance names must be unique on a LAN —
 * two desktops publishing the bare "Filament DB" would collide and bonjour-
 * service would suppress the second on probe, hiding it from discovery (#723).
 * Suffix the hostname so each host is distinct.
 */
export function instanceName(hostname: string): string {
  const host = hostname.replace(/\.local$/i, "").trim();
  return host ? `${SERVICE_NAME} (${host})` : SERVICE_NAME;
}

/**
 * The `.local` host name the advertisement's SRV record points at, and the
 * name its A/AAAA records are published under.
 *
 * It must NOT be the machine's own `<hostname>.local`. bonjour-service
 * defaults `host` to `os.hostname()` and publishes an A/AAAA record under it
 * for every non-loopback interface address (llw0/awdl0 link-locals, temporary
 * IPv6, VPN tunnels, VM bridges). The OS responder (mDNSResponder on macOS,
 * avahi on Linux) already owns that name and advertises a different address
 * set for it, so it reads the second responder's records as a conflict
 * (RFC 6762 §9) and renames the computer: macOS shows "This computer's local
 * hostname … is already in use on this network" on every app start. A name
 * only this process answers for can't conflict with anyone.
 *
 * The name is `filamentdb-<hostname>.local`: the same hostname the instance
 * name carries (without `.local`), sanitized to one DNS label (lowercase
 * letters, digits and inner hyphens, so dots become hyphens; at most 63
 * octets). Built from the same string as the instance name, it stays unique
 * on the LAN wherever the instance name is (#723): `mac.lan` and `mac.home`
 * get different names, not a shared `filamentdb-mac`. An empty or unusable
 * hostname yields `filamentdb.local`.
 */
export function advertisedHostName(hostname: string): string {
  const sanitized = hostname
    .trim()
    .replace(/\.+$/, "")
    .replace(/\.local$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const label = sanitized
    ? `${HOST_PREFIX}-${sanitized}`.slice(0, MAX_DNS_LABEL).replace(/-+$/, "")
    : HOST_PREFIX;
  return `${label}.local`;
}

/** The bonjour-service publish options for this machine. Pure. */
export function advertisementConfig(
  port: number,
  version: string,
  hostname: string,
): ServiceConfig {
  return {
    name: instanceName(hostname),
    type: SERVICE_TYPE,
    port,
    host: advertisedHostName(hostname),
    txt: { app: "filament-db", version },
  };
}

/** Start (or restart) advertising the server on `port`. Idempotent and
 *  best-effort — a failure to advertise must never crash the app. */
export function startMdnsAdvertisement(port: number, version: string): void {
  stopMdnsAdvertisement();
  try {
    // The responder's default errorCallback THROWS — a transient multicast
    // socket error must not crash the main process for a best-effort
    // advertiser (#723). service.on("error") below only covers publish
    // errors, not responder-level ones.
    bonjour = new Bonjour(undefined, (err: unknown) => {
      console.error("mDNS responder error:", err);
    });
    service = bonjour.publish(advertisementConfig(port, version, readHostname()));
    service.on("error", (err: unknown) => {
      console.error("mDNS service error:", err);
    });
  } catch (err) {
    console.error("Failed to start mDNS advertisement:", err);
    stopMdnsAdvertisement();
  }
}

/** Stop advertising and tear down the responder. Safe to call when not running.
 *  Module refs are cleared FIRST, before the (async-goodbye) teardown, so a
 *  re-entrant start/stop can never reuse a stale handle. */
export function stopMdnsAdvertisement(): void {
  const svc = service;
  const responder = bonjour;
  service = null;
  bonjour = null;
  try {
    svc?.stop?.();
  } catch (err) {
    console.error("Failed to stop mDNS service:", err);
  }
  try {
    responder?.unpublishAll?.();
    responder?.destroy?.();
  } catch (err) {
    console.error("Failed to destroy mDNS responder:", err);
  }
}

import { createHash } from "crypto";
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
/** Hex digits of the hostname digest that keeps sanitized host names distinct. */
const HOST_DIGEST_HEX = 8;

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

/** The machine name both advertised names are built from: the hostname
 *  without surrounding whitespace, trailing dots or a `.local` suffix. */
function hostIdentity(hostname: string): string {
  return hostname.trim().replace(/\.+$/, "").replace(/\.local$/i, "").trim();
}

/**
 * A per-machine instance name. mDNS instance names must be unique on a LAN —
 * two desktops publishing the bare "Filament DB" would collide and bonjour-
 * service would suppress the second on probe, hiding it from discovery (#723).
 * Suffix the hostname so each host is distinct.
 */
export function instanceName(hostname: string): string {
  const host = hostIdentity(hostname);
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
 * The name is `filamentdb-<hostname>-<digest>.local`, one DNS label of at
 * most 63 octets. `<hostname>` is the readable part: the machine name the
 * instance name carries, lowercased, with anything outside letters, digits
 * and hyphens turned into a hyphen (dots included) and cut to fit. That
 * sanitizing and cutting can merge distinct hostnames (`my_host` and
 * `my-host`, two long names sharing their first 43 characters, two non-ASCII
 * names), and two desktops under one host name would each answer with their
 * own addresses, so a phone could resolve one instance to the other machine.
 * `<digest>` is a SHA-256 prefix of the unsanitized machine name (lowercased,
 * as DNS compares names), which keeps the host name as distinct as the
 * instance name (#723) and stable across restarts. No hostname at all yields
 * `filamentdb.local`, matching the bare "Filament DB" instance name.
 */
export function advertisedHostName(hostname: string): string {
  const identity = hostIdentity(hostname).toLowerCase();
  if (!identity) return `${HOST_PREFIX}.local`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, HOST_DIGEST_HEX);
  // Two hyphens join the prefix, the readable part and the digest.
  const readableBudget = MAX_DNS_LABEL - HOST_PREFIX.length - HOST_DIGEST_HEX - 2;
  const readable = identity
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, readableBudget)
    .replace(/-+$/, "");
  return `${[HOST_PREFIX, readable, digest].filter(Boolean).join("-")}.local`;
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

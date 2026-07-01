import os from "os";
import { Bonjour, type Service } from "bonjour-service";

/**
 * mDNS / Bonjour advertisement for LAN auto-discovery.
 *
 * Advertises this desktop instance as `_filamentdb._tcp` on the local network
 * so the Filament DB mobile scanner app can find it without the user typing an
 * IP address. Only advertised while "Share on local network" is enabled — the
 * embedded server is loopback-only otherwise, so there'd be nothing for a phone
 * to reach (see syncMdnsAdvertisement in electron/main.ts).
 *
 * Uses `bonjour-service` (pure JS, no native dependency — consistent with the
 * post-#588 "no native modules beyond pcsclite" stance).
 */
const SERVICE_TYPE = "filamentdb"; // → `_filamentdb._tcp`
const SERVICE_NAME = "Filament DB";

let bonjour: Bonjour | null = null;
let service: Service | null = null;

/**
 * A per-machine instance name. mDNS instance names must be unique on a LAN —
 * two desktops publishing the bare "Filament DB" would collide and bonjour-
 * service would suppress the second on probe, hiding it from discovery
 * (Codex #723). Suffix the hostname so each host is distinct and recognisable
 * in the mobile picker.
 */
function instanceName(): string {
  let host = "";
  try {
    host = os.hostname().replace(/\.local$/i, "").trim();
  } catch {
    host = "";
  }
  return host ? `${SERVICE_NAME} (${host})` : SERVICE_NAME;
}

/** Start (or restart) advertising the server on `port`. Idempotent and
 *  best-effort — a failure to advertise must never crash the app. */
export function startMdnsAdvertisement(port: number, version: string): void {
  stopMdnsAdvertisement();
  try {
    // Pass an errorCallback so the underlying responder routes async multicast
    // send/respond errors here instead of its default (which THROWS when no
    // callback is given) — a transient socket error must not crash the main
    // process for a best-effort advertiser (Codex #723). service.on("error")
    // below only covers publish errors, not responder-level ones.
    bonjour = new Bonjour(undefined, (err: unknown) => {
      console.error("mDNS responder error:", err);
    });
    service = bonjour.publish({
      name: instanceName(),
      type: SERVICE_TYPE,
      port,
      txt: { app: "filament-db", version },
    });
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

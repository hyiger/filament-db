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

/** Start (or restart) advertising the server on `port`. Idempotent and
 *  best-effort — a failure to advertise must never crash the app. */
export function startMdnsAdvertisement(port: number, version: string): void {
  stopMdnsAdvertisement();
  try {
    bonjour = new Bonjour();
    service = bonjour.publish({
      name: SERVICE_NAME,
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

/** Stop advertising and tear down the responder. Safe to call when not running. */
export function stopMdnsAdvertisement(): void {
  try {
    service?.stop?.();
  } catch (err) {
    console.error("Failed to stop mDNS service:", err);
  }
  service = null;
  try {
    bonjour?.unpublishAll?.();
    bonjour?.destroy?.();
  } catch (err) {
    console.error("Failed to destroy mDNS responder:", err);
  }
  bonjour = null;
}

/** Whether an advertisement is currently published. */
export function isMdnsAdvertising(): boolean {
  return service !== null;
}

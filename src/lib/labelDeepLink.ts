/**
 * Build the deep-link URL a label's QR encodes in "URL" mode (GH #595).
 *
 * Pure + unit-tested. When a specific spool is chosen, the link carries
 * `?spool=<spoolId>` so scanning the QR opens the filament page with that
 * spool highlighted (the detail page reads the param and scrolls to it).
 * Without a spool it's the plain filament link — the previous behaviour.
 */
export function buildFilamentDeepLink(
  base: string,
  filamentId: string,
  spoolId?: string | null,
): string {
  // Trim a trailing slash on the base so we don't emit `//filaments`.
  const root = base.replace(/\/+$/, "");
  const url = `${root}/filaments/${encodeURIComponent(filamentId)}`;
  const spool = (spoolId ?? "").trim();
  return spool ? `${url}?spool=${encodeURIComponent(spool)}` : url;
}

/**
 * Deep link a dry-box label's QR encodes — the /inventory page filtered to
 * one location.
 *
 * Deliberately NOT a dedicated location page: there is no location VIEW
 * route (only /locations/{id}/edit), and /inventory already answers the
 * question a scanned box label asks — "what is in this box right now" —
 * live from the by-location aggregation. The page reads `?location=` and
 * expands + scrolls to that group.
 */
export function buildLocationDeepLink(base: string, locationId: string): string {
  const root = base.replace(/\/+$/, "");
  return `${root}/inventory?location=${encodeURIComponent(locationId)}`;
}

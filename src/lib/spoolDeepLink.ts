/**
 * GH #595 spool deep links, made SELF-HEALING.
 *
 * A printed label's QR encodes `/filaments/<filamentId>?spool=<spoolId>`
 * permanently (buildFilamentDeepLink — src/lib/labelDeepLink.ts). Any
 * operation that moves a spool onto a different document makes the printed
 * filament id stale while the spool subdocument id stays valid — a GH #605
 * parent promotion preserves spool `_id`s verbatim today, and any future
 * move would too. Printed history can't be fixed, so the link heals at
 * RESOLUTION time instead: when the addressed filament doesn't carry the
 * spool, the detail page resolves the spool's true owner globally
 * (GET /api/spools/{spoolId} — the same `spools._id` lookup the mobile
 * scanner uses) and replaces the route with the owner's page, spool still
 * selected. This heals ALL stale labels, not just promotion-moved ones.
 *
 * The decision logic lives here, pure and unit-tested — the page itself is
 * a client component the node test environment can't render. Behavior when
 * nothing is stale is unchanged: spool on the addressed doc → highlight it;
 * spool nowhere → the pre-existing quiet not-found posture (the addressed
 * page simply shows, nothing scrolls).
 */

export type SpoolDeepLinkDecision =
  /** No `?spool=` param — nothing to do. */
  | { action: "none" }
  /** The spool is on the addressed filament — scroll + highlight, no
   *  redirect (the fresh-label fast path). */
  | { action: "highlight"; spoolId: string }
  /** The addressed filament doesn't carry the spool — a stale label (or a
   *  bad id). Resolve the true owner globally and redirect if one exists. */
  | { action: "resolve"; spoolId: string };

/**
 * Classify the page's `?spool=` state against the spool ids the addressed
 * filament actually carries. `search` is `window.location.search` verbatim.
 */
export function decideSpoolDeepLink(
  search: string,
  spoolIdsOnDoc: readonly string[],
): SpoolDeepLinkDecision {
  const spoolId = new URLSearchParams(search).get("spool");
  if (!spoolId) return { action: "none" };
  return spoolIdsOnDoc.includes(spoolId)
    ? { action: "highlight", spoolId }
    : { action: "resolve", spoolId };
}

/**
 * The healed route for a stale label: the TRUE owner's detail page with the
 * ORIGINAL query string carried over verbatim — `?spool=` itself rides
 * along (so the remounted page highlights the spool) and so does any other
 * param a future label mode might add.
 *
 * Returns null when no redirect should happen:
 *   - no owner (the spool exists nowhere → keep the current not-found
 *     posture: stay on the addressed page, no navigation), or
 *   - the owner IS the addressed document (nothing to heal — and a loop
 *     guard, should a racing edit put the spool back mid-resolve).
 */
export function healedSpoolDeepLinkHref(
  addressedFilamentId: string,
  ownerFilamentId: string | null | undefined,
  search: string,
): string | null {
  const owner = (ownerFilamentId ?? "").trim();
  if (!owner || owner === addressedFilamentId) return null;
  return `/filaments/${encodeURIComponent(owner)}${search}`;
}

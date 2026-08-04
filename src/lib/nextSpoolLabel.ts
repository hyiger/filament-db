/**
 * Next-roll-number suggestion for spool labels (GH #1060).
 *
 * The spool `label` is a free-form string, but the community convention —
 * and the reporter's 200+ spool inventory, migrated from Spoolman — uses it
 * as an incrementing PHYSICAL roll number, often written on the spool
 * itself. This computes the suggestion the "Next #" button pre-fills:
 * max(numeric labels) + 1, or 1 when no numeric label exists.
 *
 * Pure and DB-free; the route flattens `spools[].label` across every
 * filament (including trashed/purged docs and retired spools — the
 * never-reuse invariant lives in the ROUTE's query, documented there) and
 * hands the strings here.
 */

export interface NextSpoolLabel {
  /** The suggested next roll number: `(max ?? 0) + 1`. */
  next: number;
  /** The highest numeric label found, or null when none parse. */
  max: number | null;
}

/**
 * Compute the suggestion from raw label strings.
 *
 * A label counts as numeric only when, after trimming, it is ALL digits
 * (`/^\d+$/`) — so "A12", "12a", "1.5", "-3" and "1e3" are ignored rather
 * than half-parsed. Leading zeros are stripped before parsing ("0042" is
 * the number 42).
 *
 * Acceptance is judged by VALUE — `Number.isSafeInteger` — not by digit
 * count (PR #1061 review). A digit-count cap made the generator and the
 * parser disagree at the boundary: with max 999999999999999 the suggestion
 * was the 16-digit 1000000000000000, which the 15-digit guard then REJECTED
 * on the next request — so after creating that spool the same number was
 * suggested again, forever. Value-based acceptance means every suggestion
 * this function emits is re-accepted by this function; a 200-digit "number"
 * still can't poison the max (it parses past the safe range and is
 * skipped). `next` is capped at MAX_SAFE_INTEGER — beyond it increments
 * stop being representable at all, and nine quadrillion spools is a data
 * problem, not a numbering problem.
 */
export function computeNextSpoolLabel(
  labels: Iterable<string | null | undefined>,
): NextSpoolLabel {
  let max: number | null = null;
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const value = Number(trimmed.replace(/^0+(?=\d)/, ""));
    if (!Number.isSafeInteger(value)) continue;
    if (max === null || value > max) max = value;
  }
  return {
    next: max === null ? 1 : Math.min(max + 1, Number.MAX_SAFE_INTEGER),
    max,
  };
}

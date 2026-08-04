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

/** Digit-count cap on labels considered numeric. Fifteen digits keeps every
 *  accepted value inside Number's exact-integer range — the label field
 *  allows 200 characters, and a 200-digit "number" must not poison the max
 *  (or produce a `next` that no longer round-trips through JSON intact). */
const MAX_NUMERIC_LABEL_DIGITS = 15;

/**
 * Compute the suggestion from raw label strings.
 *
 * A label counts as numeric only when, after trimming, it is ALL digits
 * (`/^\d+$/`) — so "A12", "12a", "1.5", "-3" and "1e3" are ignored rather
 * than half-parsed. Leading zeros are stripped before both the length guard
 * and the comparison ("0042" is the number 42, and "0…0-padded" zeros must
 * not trip the digit cap).
 */
export function computeNextSpoolLabel(
  labels: Iterable<string | null | undefined>,
): NextSpoolLabel {
  let max: number | null = null;
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const stripped = trimmed.replace(/^0+(?=\d)/, "");
    if (stripped.length > MAX_NUMERIC_LABEL_DIGITS) continue;
    const value = Number(stripped);
    if (max === null || value > max) max = value;
  }
  return { next: (max ?? 0) + 1, max };
}

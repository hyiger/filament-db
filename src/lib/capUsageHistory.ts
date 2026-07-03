/**
 * Undo-aware cap on a spool's embedded `usageHistory` array (GH #954 finding #6).
 *
 * The cap exists to stop a client looping usage POSTs from growing a filament
 * document toward MongoDB's 16 MiB limit (GH #304). The obvious implementation —
 * `entries.slice(-max)` — evicts the OLDEST entries, which is exactly the set
 * most likely to include a still-live `source:"job"`/`"slicer"` entry.
 *
 * That matters because `DELETE /api/print-history/{id}` refunds spool weight
 * ONLY when it finds and removes the job's matching `usageHistory` entry (the
 * GH #621 idempotency guard: "entry gone ⇒ already refunded ⇒ skip"). Evicting a
 * live job's entry makes its later DELETE silently skip the refund → a permanent
 * inventory undercount.
 *
 * So this trim keeps the array at `max` entries but preferentially evicts entries
 * that NO undo path needs — manual/nfc logs (jobId null, source `manual`/`nfc`) —
 * oldest-first. Undo-relevant entries (a `jobId`, or the legacy `job`/`slicer`
 * sources the DELETE handler still matches on) are evicted only as a last resort,
 * when the array is ENTIRELY undo-relevant — a pathological 1000-live-jobs-on-one-
 * spool case a real physical spool never reaches. Chronological order (the append
 * order the array is built in) is preserved throughout, and the caller's freshly
 * pushed job entries — always the newest and always undo-relevant — are never
 * evicted.
 */

/** Hard cap on a spool's `usageHistory` length. Far above any realistic
 * per-spool history; a backstop against unbounded document growth (GH #304). */
export const MAX_SPOOL_HISTORY = 1000;

/** The subset of an `IUsageEntry` this cap reasons about. Kept structural (and
 * dependency-free) so the helper stays a pure, fast unit-testable module usable
 * over both hydrated Mongoose subdocuments and plain objects. */
type CappableEntry = {
  jobId?: unknown;
  source?: string;
};

/**
 * An entry is "undo-relevant" when a `DELETE /api/print-history/{id}` could still
 * need it to refund spool weight. That's any entry carrying a `jobId`, plus the
 * legacy pre-jobId `job`/`slicer` entries the DELETE handler falls back to
 * matching by `(grams, startedAt)`. Manual/NFC logs (jobId null, source
 * `manual`/`nfc`) are never refunded by the undo path, so they're safe to evict.
 */
function isUndoRelevant(entry: CappableEntry): boolean {
  return Boolean(entry.jobId) || entry.source === "job" || entry.source === "slicer";
}

/**
 * Trim `entries` to at most `max`, evicting non-undo entries (oldest-first)
 * before any undo-relevant entry. Returns the SAME array reference when nothing
 * needs trimming (length already within `max`), so a caller can cheaply detect a
 * no-op; otherwise returns a new, filtered array in the original order.
 */
export function capUsageHistory<T extends CappableEntry>(
  entries: T[],
  max: number = MAX_SPOOL_HISTORY,
): T[] {
  if (!Array.isArray(entries) || entries.length <= max) return entries;

  const excess = entries.length - max;
  const drop = new Set<number>();

  // Pass 1: evict non-undo (manual/nfc) entries, oldest → newest.
  for (let i = 0; i < entries.length && drop.size < excess; i++) {
    if (!isUndoRelevant(entries[i])) drop.add(i);
  }
  // Pass 2 (last resort): the array is short of `max` even after dropping every
  // non-undo entry, i.e. it's entirely undo-relevant. Evict undo-relevant
  // entries oldest → newest to honour the hard cap; the caller's just-pushed
  // entries are the newest so they're kept, but an old live job's entry may be
  // lost here (its later DELETE then skips the refund — accepted, and only
  // reachable on a spool carrying 1000+ live jobs).
  for (let i = 0; i < entries.length && drop.size < excess; i++) {
    if (!drop.has(i)) drop.add(i);
  }

  return entries.filter((_, i) => !drop.has(i));
}

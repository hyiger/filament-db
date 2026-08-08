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
 * order the array is built in) is preserved throughout.
 *
 * CONTRACT: callers push-then-cap, so the LAST entry is the row just recorded —
 * it is never evicted. Without that guard, a spool already full of undo-relevant
 * entries would drop the freshly appended manual/nfc row (the only non-undo
 * entry) while the caller has already debited weight and returned 201 — a silent
 * loss of the just-logged use (Codex P2 on PR #961). Protecting the newest row
 * means the last-resort eviction can sacrifice an OLD undo entry to keep it; that
 * only bites on the same pathological all-undo spool, where losing what the user
 * just did is worse than a rare refund gap on a decade-deep history.
 */

/** Hard cap on a spool's `usageHistory` length. Far above any realistic
 * per-spool history; a backstop against unbounded document growth (GH #304). */
export const MAX_SPOOL_HISTORY = 1000;

/**
 * Hard cap on the MAGNITUDE of a single usage entry, in grams (GH #1030).
 *
 * `MAX_SPOOL_HISTORY` bounds how MANY entries a spool can hold; nothing bounded
 * how BIG one could be. Both write boundaries validated only `Number.isFinite`
 * + a floor, and `Number.isFinite` excludes just `Infinity`/`NaN` — so
 * `JSON.parse('{"grams":1e308}')` produced a finite value that cast, validated
 * and persisted. Analytics then sums raw doubles, and once a day's sum
 * overflows to `Infinity` the per-day apportionment computes
 * `ideal = (raw / Infinity) * Infinity` = `0 * Infinity` = **NaN for every
 * segment of that day** — so an unrelated, correctly-sized filament that merely
 * printed on the same UTC day also serializes as JSON `null` (JSON.stringify
 * renders both Infinity and NaN as null), violating the numeric response
 * contract `public/openapi.json` declares.
 *
 * 1 tonne: 1000x a standard 1 kg spool and ~50x the largest FDM spool sold
 * (20 kg), so no real entry can approach it — while still making overflow
 * structurally unreachable. A spool's ledger is capped at
 * MAX_SPOOL_HISTORY (1000) x 1e6 = 1e9 g, and the largest plausible window
 * total stays exactly integer-representable (< Number.MAX_SAFE_INTEGER,
 * ~9.007e15), so no aggregate can lose precision, let alone overflow.
 *
 * Deliberately NOT tightened to catch unit-confusion bugs (a fork posting mm
 * of filament, ~330,000 mm/kg, or mm^3, ~806,000 mm^3/kg, would land just
 * under this cap). A tighter 100 kg bound would catch those but is close
 * enough to plausible bulk backfill logging to risk rejecting a real entry.
 * This constant exists for overflow safety; unit validation is a separate
 * concern and should not be smuggled in by lowering it.
 */
export const MAX_USAGE_GRAMS = 1_000_000;

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

  // The last entry is the row the caller just recorded (push-then-cap) and is
  // never a candidate — see CONTRACT above. Everything before it is evictable.
  const evictableEnd = entries.length - 1;

  // Pass 1: evict non-undo (manual/nfc) entries, oldest → newest.
  for (let i = 0; i < evictableEnd && drop.size < excess; i++) {
    if (!isUndoRelevant(entries[i])) drop.add(i);
  }
  // Pass 2 (last resort): the array is short of `max` even after dropping every
  // older non-undo entry, i.e. it's (near-)entirely undo-relevant. Evict
  // undo-relevant entries oldest → newest to honour the hard cap; an old live
  // job's entry may be lost here (its later DELETE then skips the refund —
  // accepted, and only reachable on a spool carrying ~1000 live jobs).
  for (let i = 0; i < evictableEnd && drop.size < excess; i++) {
    if (!drop.has(i)) drop.add(i);
  }

  return entries.filter((_, i) => !drop.has(i));
}

/**
 * GH #1030: clamp one stored `grams` value to a sane, finite, non-negative
 * number before it enters ANY aggregate.
 *
 * The write boundaries reject `grams > MAX_USAGE_GRAMS`, but rows that
 * predate that cap — or arrive through a path that doesn't go through the
 * routes (snapshot restore, hybrid sync) — can still carry a pathological
 * magnitude. Sanitising at INGESTION rather than at each emit point keeps
 * every downstream invariant intact by construction: with all inputs finite
 * a summed total can no longer overflow to `Infinity` (which `JSON.stringify`
 * renders as `null`, violating the numeric response contract
 * `public/openapi.json` declares — and in analytics used to cascade the
 * Hamilton apportionment's `0 * Infinity` → NaN across every segment of the
 * affected day).
 *
 * A clamped row renders as MAX_USAGE_GRAMS rather than vanishing, so the
 * corruption stays visible in the UI instead of silently under-reporting; a
 * NaN/negative/missing value contributes 0.
 *
 * GH #1078: extracted from `src/app/api/analytics/route.ts` so the dashboard
 * route clamps `recentPrintHistory[].totalGrams` through the SAME sanitizer —
 * pre-fix the dashboard summed raw usage grams and could serialize `null` for
 * a job analytics reported sanely.
 */
export function safeGrams(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, MAX_USAGE_GRAMS);
}

/**
 * Sum a job's per-filament usage entries with each value clamped through
 * `safeGrams` (GH #1030/#1078). Tolerates a missing array (legacy rows).
 */
export function sumUsageGrams(usage: { grams: number }[] | undefined): number {
  return (usage || []).reduce((sum, u) => sum + safeGrams(u.grams), 0);
}

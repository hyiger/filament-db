import { describe, it, expect } from "vitest";
import {
  capUsageHistory,
  safeGrams,
  sumUsageGrams,
  MAX_SPOOL_HISTORY,
  MAX_USAGE_GRAMS,
} from "@/lib/capUsageHistory";

/**
 * Pure-helper coverage for the undo-aware usageHistory cap (GH #954 finding #6).
 *
 * The defining property: a plain `slice(-max)` evicts the OLDEST entries, but the
 * oldest entry is exactly the one most likely to be a still-live `source:"job"`
 * entry whose DELETE refund keys off it still being present (GH #621). This helper
 * evicts non-undo (manual/nfc) entries first and only touches undo-relevant
 * entries as a last resort — while preserving chronological order.
 */
describe("capUsageHistory", () => {
  type Entry = { grams: number; source: string; jobId: unknown };
  const manual = (id: number): Entry => ({ grams: id, source: "manual", jobId: null });
  const nfc = (id: number): Entry => ({ grams: id, source: "nfc", jobId: null });
  const job = (id: number): Entry => ({ grams: id, source: "job", jobId: `job-${id}` });
  const slicer = (id: number): Entry => ({ grams: id, source: "slicer", jobId: null });
  const ids = (arr: Entry[]) => arr.map((e) => e.grams);

  it("exports the shared cap constant", () => {
    expect(MAX_SPOOL_HISTORY).toBe(1000);
  });

  it("returns the SAME array reference when within the cap (cheap no-op)", () => {
    const arr = [manual(1), manual(2)];
    expect(capUsageHistory(arr, 1000)).toBe(arr);
  });

  it("returns the same reference when exactly at the cap", () => {
    const arr = [manual(1), manual(2), manual(3)];
    expect(capUsageHistory(arr, 3)).toBe(arr);
  });

  it("trims to exactly max when over", () => {
    const arr = [manual(1), manual(2), manual(3), manual(4)];
    const out = capUsageHistory(arr, 2);
    expect(out).toHaveLength(2);
    // oldest two manuals evicted → newest two kept, in order
    expect(ids(out)).toEqual([3, 4]);
  });

  it("evicts the oldest non-undo (manual) entry before any undo entry", () => {
    // job(1) is the OLDEST — a plain slice(-2) would drop it; the undo-aware
    // trim must keep it and drop the oldest manual instead.
    const arr = [job(1), manual(2), manual(3)];
    const out = capUsageHistory(arr, 2);
    expect(ids(out)).toEqual([1, 3]); // job(1) preserved, manual(2) evicted
  });

  it("treats source 'job' and 'slicer' as undo-relevant (evicted after manuals)", () => {
    // The oldest MANUAL rolls off; both the job and slicer entries are kept
    // because they're undo-relevant, and the newest entry is always kept.
    const arr = [manual(1), job(2), slicer(3), manual(4)];
    const out = capUsageHistory(arr, 3);
    expect(ids(out)).toEqual([2, 3, 4]);
  });

  it("never evicts the freshly appended (newest) entry, even sacrificing an old undo entry (#961 Codex P2)", () => {
    // Spool full of undo-relevant job entries; a new manual is appended. The
    // newest row must survive — dropping it while the caller has already
    // debited weight would silently lose the just-recorded use. An OLD job
    // entry is sacrificed instead (only reachable on a spool this deep in jobs).
    const arr = [job(1), job(2), manual(99)];
    const out = capUsageHistory(arr, 2);
    expect(ids(out)).toEqual([2, 99]); // oldest job evicted, new manual kept
    expect(out.some((e) => e.grams === 99 && e.source === "manual")).toBe(true);
  });

  it("treats 'nfc' entries as evictable like 'manual'", () => {
    const arr = [nfc(1), job(2)];
    const out = capUsageHistory(arr, 1);
    expect(ids(out)).toEqual([2]); // nfc evicted, job kept
  });

  it("preserves chronological order while dropping interior non-undo entries", () => {
    const arr = [manual(1), job(2), manual(3), job(4), manual(5)];
    const out = capUsageHistory(arr, 3);
    // excess 2 → drop the two oldest manuals (indices 0 and 2); order intact
    expect(ids(out)).toEqual([2, 4, 5]);
  });

  it("falls back to evicting oldest undo entries when the array is ALL undo-relevant", () => {
    const arr = [job(1), job(2), job(3)];
    const out = capUsageHistory(arr, 1);
    expect(ids(out)).toEqual([3]); // newest job kept, older jobs evicted last-resort
  });

  it("spends non-undo evictions first, then undo evictions, to meet a large excess", () => {
    // excess 2, only one manual available → drop it, then drop the oldest job.
    const arr = [manual(1), job(2), job(3)];
    const out = capUsageHistory(arr, 1);
    expect(ids(out)).toEqual([3]); // manual(1) + job(2) evicted, newest job(3) kept
  });

  it("honours a custom max", () => {
    const arr = [manual(1), manual(2), manual(3), manual(4), manual(5)];
    expect(capUsageHistory(arr, 4)).toHaveLength(4);
    expect(ids(capUsageHistory(arr, 1))).toEqual([5]);
  });

  it("defaults to MAX_SPOOL_HISTORY when max is omitted", () => {
    const arr = Array.from({ length: MAX_SPOOL_HISTORY + 5 }, (_, i) => manual(i));
    const out = capUsageHistory(arr);
    expect(out).toHaveLength(MAX_SPOOL_HISTORY);
    // oldest 5 evicted → the array now starts at grams=5
    expect(out[0].grams).toBe(5);
  });

  it("keeps an old live job entry even when the cap forces evicting many manuals", () => {
    // 1 old job + MAX manuals = MAX+1 → excess 1 → an old manual rolls off,
    // the old job survives so its DELETE refund can still find it.
    const arr = [job(0), ...Array.from({ length: MAX_SPOOL_HISTORY }, (_, i) => manual(i + 1))];
    const out = capUsageHistory(arr);
    expect(out).toHaveLength(MAX_SPOOL_HISTORY);
    expect(out.some((e) => e.source === "job" && e.grams === 0)).toBe(true);
  });

  it("returns a non-array input untouched (defensive)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(capUsageHistory(undefined as any, 10)).toBeUndefined();
  });
});

/**
 * GH #1030 / GH #1078: the ingestion sanitizer moved here from the analytics
 * route so the dashboard clamps `recentPrintHistory[].totalGrams` through the
 * SAME code path. Pin every branch: non-number, non-finite, non-positive → 0;
 * in-range → identity; over-cap → MAX_USAGE_GRAMS.
 */
describe("safeGrams (GH #1030/#1078)", () => {
  it("exports the shared magnitude cap", () => {
    expect(MAX_USAGE_GRAMS).toBe(1_000_000);
  });

  it("returns 0 for non-number inputs", () => {
    expect(safeGrams("50")).toBe(0);
    expect(safeGrams(null)).toBe(0);
    expect(safeGrams(undefined)).toBe(0);
    expect(safeGrams({})).toBe(0);
  });

  it("returns 0 for non-finite numbers (NaN / ±Infinity)", () => {
    expect(safeGrams(Number.NaN)).toBe(0);
    expect(safeGrams(Infinity)).toBe(0);
    expect(safeGrams(-Infinity)).toBe(0);
  });

  it("returns 0 for zero and negative values", () => {
    expect(safeGrams(0)).toBe(0);
    expect(safeGrams(-42)).toBe(0);
  });

  it("passes an in-range value through unchanged", () => {
    expect(safeGrams(37.5)).toBe(37.5);
    expect(safeGrams(MAX_USAGE_GRAMS)).toBe(MAX_USAGE_GRAMS);
  });

  it("clamps a pathological magnitude AT the cap (visible, not vanished)", () => {
    expect(safeGrams(1e308)).toBe(MAX_USAGE_GRAMS);
    expect(safeGrams(MAX_USAGE_GRAMS + 1)).toBe(MAX_USAGE_GRAMS);
  });
});

describe("sumUsageGrams (GH #1078)", () => {
  it("returns 0 for a missing usage array (legacy rows)", () => {
    expect(sumUsageGrams(undefined)).toBe(0);
    expect(sumUsageGrams([])).toBe(0);
  });

  it("sums entries with each value clamped through safeGrams", () => {
    expect(
      sumUsageGrams([{ grams: 10 }, { grams: -5 }, { grams: Number.NaN }, { grams: 2.5 }]),
    ).toBe(12.5);
  });

  it("two 1e308 entries sum to a FINITE total (2 × cap), not Infinity", () => {
    // Raw doubles: 1e308 + 1e308 = Infinity → JSON.stringify → null. The
    // per-entry clamp makes overflow structurally unreachable.
    const total = sumUsageGrams([{ grams: 1e308 }, { grams: 1e308 }]);
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBe(2 * MAX_USAGE_GRAMS);
  });
});

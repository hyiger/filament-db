/**
 * Inventory math for the filament list page (and any other consumer
 * that needs to render remaining %, gram totals, or spool counts the
 * same way).
 *
 * All three helpers exclude spools where `retired: true`. The helpers
 * have to agree on this rule — the low-stock badge already skipped
 * retired spools, but the percentage and the spool-count chip didn't,
 * so a filament with one active and one retired spool would render
 * as "2 spools, looking healthy" while the low-stock logic considered
 * it a single nearly-empty roll.
 */

export interface InventorySpool {
  totalWeight: number | null;
  retired?: boolean;
}

export interface InventoryFilament {
  spools?: InventorySpool[];
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  /** Legacy single-spool fallback used when `spools` is empty. */
  totalWeight: number | null;
}

/** Number of *active* (non-retired) spools. Falls back to the legacy
 * single-spool shape when `spools` is empty but `totalWeight` is set. */
export function getSpoolCount(f: InventoryFilament): number {
  if (f.spools && f.spools.length > 0) {
    return f.spools.filter((s) => !s.retired).length;
  }
  return f.totalWeight != null ? 1 : 0;
}

/** Grams of filament remaining across all non-retired spools. Returns
 * null when the filament isn't weight-tracked.
 *
 * GH #310: the gram math is purely `sum(max(0, totalWeight - spoolWeight))`
 * — `netFilamentWeight` is never referenced here (it's the denominator for
 * the *percentage*, not the grams). Requiring it would suppress a
 * perfectly computable grams figure for filaments that have `spoolWeight`
 * set but `netFilamentWeight` blank, so the guard checks only the inputs
 * the calculation actually uses. */
export function getRemainingGrams(f: InventoryFilament): number | null {
  if (f.spools && f.spools.length > 0) {
    // GH #954: fall back to a 0g tare when spoolWeight is unset, matching the
    // 0-tare posture the by-location / dashboard / locations surfaces already
    // use — so a legacy null-spoolWeight filament reports remaining grams (and
    // can trip the home-list low-stock badge) instead of reading as "not
    // weight-tracked" on the home list while every other surface counts it.
    const tare = f.spoolWeight ?? 0;
    let grams = 0;
    let any = false;
    for (const s of f.spools) {
      if (s.retired) continue;
      if (s.totalWeight != null) {
        grams += Math.max(0, s.totalWeight - tare);
        any = true;
      }
    }
    return any ? grams : null;
  }
  // GH #524.3: legacy single-spool fallback — same shape getSpoolCount and
  // getRemainingPct already honour. Without this branch the home page's
  // isLowStock helper never lights up for a pre-migration filament with a
  // top-level `totalWeight`. GH #1118: 0-tare fallback here too, matching
  // the spools branch — otherwise the legacy path is the lone surface that
  // returns null without a tare while the dashboard computes `totalWeight -
  // 0` for the same row.
  if (f.totalWeight == null) return null;
  return Math.max(0, f.totalWeight - (f.spoolWeight ?? 0));
}

/** Three-tier decision for a "remaining" table cell (GH #1048).
 *
 * The home list used to branch only on `getRemainingPct` and rendered a
 * bare em-dash whenever the percentage was null — but the percentage
 * needs `netFilamentWeight` as a denominator while the gram math does
 * not (see the #310 note on `getRemainingGrams`). A legacy record like
 * { totalWeight: 1035, spoolWeight: 184, netFilamentWeight: null }
 * therefore showed "851 g" on the detail page and "—" on the list.
 *
 * Tiers, matching the inventory page's cell:
 *   1. pct computable        → "bar"   (percentage bar)
 *   2. only grams computable → "grams" (plain gram figure)
 *   3. neither               → "none"  (em-dash)
 *
 * Extracted here (rather than inlined in the client page) so the
 * decision is unit-testable — the home page is a `use client` component
 * the node-only vitest env can't render. */
export type RemainingDisplay =
  | { kind: "bar"; pct: number }
  | { kind: "grams"; grams: number; missing: RemainingPctMissing }
  | { kind: "none" };

/** Which percentage-only input(s) block the bar tier while the grams
 * tier still renders. `getRemainingGrams` tolerates a null `spoolWeight`
 * in the spools-array branch (0 g tare fallback, GH #954) but
 * `getRemainingPct` needs BOTH weights, so the grams tier can be
 * blocked by the net weight, the tare, or both — the tooltip has to
 * name the right one(s), not always "set net weight". */
export type RemainingPctMissing = "net" | "tare" | "both";

export function getRemainingDisplay(f: InventoryFilament): RemainingDisplay {
  const pct = getRemainingPct(f);
  if (pct != null) return { kind: "bar", pct };
  const grams = getRemainingGrams(f);
  if (grams != null) {
    // Derived from getRemainingPct's own guards, per branch:
    //   spools-array: needs spoolWeight != null AND netFilamentWeight > 0
    //     (≥1 active weighted spool is already guaranteed here — grams
    //     being non-null in that branch means one exists, so validCount
    //     can't be the blocker);
    //   legacy: getRemainingPct still needs BOTH weights, but since GH #1118
    //     getRemainingGrams tolerates a null tare here too (0-tare fallback),
    //     so the legacy path can now reach this tier with the tare missing —
    //     exactly like the spools branch. The flags below read the raw fields,
    //     so they were already correct for that case.
    // Hence at least one of the two flags is set whenever this tier is
    // reached, in either branch.
    const netMissing = f.netFilamentWeight == null || f.netFilamentWeight <= 0;
    const tareMissing = f.spoolWeight == null;
    const missing: RemainingPctMissing =
      netMissing && tareMissing ? "both" : tareMissing ? "tare" : "net";
    return { kind: "grams", grams, missing };
  }
  return { kind: "none" };
}

/** Percentage remaining (0-100, integer). Excludes retired spools so
 * the bar matches the low-stock chip. Falls back to legacy
 * single-spool math when `spools` is empty. */
export function getRemainingPct(f: InventoryFilament): number | null {
  if (
    f.spools &&
    f.spools.length > 0 &&
    f.spoolWeight != null &&
    f.netFilamentWeight != null &&
    f.netFilamentWeight > 0
  ) {
    let totalRemaining = 0;
    let validCount = 0;
    for (const spool of f.spools) {
      if (spool.retired) continue;
      if (spool.totalWeight != null) {
        totalRemaining += Math.max(0, spool.totalWeight - f.spoolWeight);
        validCount++;
      }
    }
    if (validCount === 0) return null;
    const totalNet = f.netFilamentWeight * validCount;
    return Math.min(100, Math.max(0, Math.round((totalRemaining / totalNet) * 100)));
  }
  if (
    f.totalWeight == null ||
    f.spoolWeight == null ||
    f.netFilamentWeight == null ||
    f.netFilamentWeight <= 0
  ) {
    return null;
  }
  return Math.min(
    100,
    Math.max(0, Math.round(((f.totalWeight - f.spoolWeight) / f.netFilamentWeight) * 100)),
  );
}

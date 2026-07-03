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
    // GH #954: a null `spoolWeight` (legacy rolls tracked before the tare field
    // existed) falls back to a 0g tare — matching /api/dashboard, /api/locations,
    // and /api/spools/by-location, which all use `?? 0` for the same shape.
    // Previously this returned null, so the home page's low-stock badge + quick
    // filter (isLowStock needs a non-null grams) never fired for those filaments
    // even near-empty, while every other surface counted them. 0g-tare
    // over-reports by the empty-spool mass (gross, not net), a documented
    // trade-off preferred here for cross-surface consistency.
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
  // GH #524.3: legacy single-spool fallback — same shape getSpoolCount
  // and getRemainingPct already honour. Without this branch, the home
  // page's isLowStock helper (which calls getRemainingGrams and treats
  // null as "not low") never lights up the badge for a pre-migration
  // filament with a top-level `totalWeight`, even though the same row's
  // remaining-% bar renders correctly via getRemainingPct's legacy path.
  if (f.totalWeight == null) return null;
  return Math.max(0, f.totalWeight - (f.spoolWeight ?? 0)); // GH #954: 0g-tare fallback
}

/** Percentage remaining (0-100, integer). Excludes retired spools so
 * the bar matches the low-stock chip. Falls back to legacy
 * single-spool math when `spools` is empty. */
export function getRemainingPct(f: InventoryFilament): number | null {
  if (
    f.spools &&
    f.spools.length > 0 &&
    f.netFilamentWeight != null &&
    f.netFilamentWeight > 0
  ) {
    // GH #954: 0g-tare fallback for a null spoolWeight, in lockstep with
    // getRemainingGrams so the bar and the low-stock badge agree. The result
    // still clamps to [0, 100] below, so a gross-weight over-report caps at 100%.
    const tare = f.spoolWeight ?? 0;
    let totalRemaining = 0;
    let validCount = 0;
    for (const spool of f.spools) {
      if (spool.retired) continue;
      if (spool.totalWeight != null) {
        totalRemaining += Math.max(0, spool.totalWeight - tare);
        validCount++;
      }
    }
    if (validCount === 0) return null;
    const totalNet = f.netFilamentWeight * validCount;
    return Math.min(100, Math.max(0, Math.round((totalRemaining / totalNet) * 100)));
  }
  if (
    f.totalWeight == null ||
    f.netFilamentWeight == null ||
    f.netFilamentWeight <= 0
  ) {
    return null;
  }
  return Math.min(
    100,
    Math.max(0, Math.round(((f.totalWeight - (f.spoolWeight ?? 0)) / f.netFilamentWeight) * 100)),
  );
}

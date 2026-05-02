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
 * null when the filament isn't weight-tracked. */
export function getRemainingGrams(f: InventoryFilament): number | null {
  if (
    !f.spools ||
    f.spools.length === 0 ||
    f.spoolWeight == null ||
    f.netFilamentWeight == null
  ) {
    return null;
  }
  let grams = 0;
  let any = false;
  for (const s of f.spools) {
    if (s.retired) continue;
    if (s.totalWeight != null) {
      grams += Math.max(0, s.totalWeight - f.spoolWeight);
      any = true;
    }
  }
  return any ? grams : null;
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

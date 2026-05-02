/**
 * Sorting helpers for the home filament list.
 *
 * Extracted from src/app/page.tsx so the comparator + handleSort
 * contract can be unit-tested without mounting the React component.
 * GH #165 reported a (non-reproducible) "Cost column sorts desc on
 * first click" bug; this module exists so any future refactor that
 * accidentally introduces a per-column polarity bias gets caught
 * by tests/sortFilamentList.test.ts.
 *
 * Behaviour locked in here:
 *   - Clicking a *new* column always sets sortDir = "asc" (no
 *     per-column override — same rule for every column).
 *   - Clicking the *same* column toggles asc ↔ desc.
 *   - getSortValue uses -1 as the sentinel for null on numeric
 *     columns, so nulls sort *first* in asc and *last* in desc.
 */

import type { FilamentSummary } from "@/types/filament";
import { getRemainingPct, type InventoryFilament } from "@/lib/inventoryStats";

export type SortKey = "name" | "vendor" | "type" | "nozzle" | "bed" | "cost" | "remaining";
export type SortDir = "asc" | "desc";

/** Subset of FilamentSummary the comparator actually reads. Keeps tests
 * lightweight without forcing every fixture to spell out unrelated fields
 * (spools, color, etc). */
export type SortableFilament = Pick<
  FilamentSummary,
  "name" | "vendor" | "type" | "cost" | "temperatures" | "spools" | "spoolWeight" | "netFilamentWeight" | "totalWeight"
>;

export function getSortValue(f: SortableFilament, key: SortKey): string | number {
  switch (key) {
    case "name":
      return f.name.toLowerCase();
    case "vendor":
      return f.vendor.toLowerCase();
    case "type":
      return f.type.toLowerCase();
    case "nozzle":
      return f.temperatures.nozzle ?? -1;
    case "bed":
      return f.temperatures.bed ?? -1;
    case "cost":
      return f.cost ?? -1;
    case "remaining":
      return getRemainingPct(f as unknown as InventoryFilament) ?? -1;
  }
}

/**
 * Comparator factory. Returns a `(a, b) => number` that sorts
 * filaments by `key` in `dir` direction. Symmetric across every key
 * so the user gets the same first-click behaviour everywhere.
 */
export function compareFilaments(key: SortKey, dir: SortDir) {
  return (a: SortableFilament, b: SortableFilament): number => {
    const aVal = getSortValue(a, key);
    const bVal = getSortValue(b, key);
    if (aVal < bVal) return dir === "asc" ? -1 : 1;
    if (aVal > bVal) return dir === "asc" ? 1 : -1;
    return 0;
  };
}

/**
 * Compute the next sort state when the user clicks a column header.
 * Same column → toggle direction. Different column → reset to asc.
 */
export function nextSortState(
  prev: { sortKey: SortKey; sortDir: SortDir },
  clicked: SortKey,
): { sortKey: SortKey; sortDir: SortDir } {
  if (prev.sortKey === clicked) {
    return { sortKey: clicked, sortDir: prev.sortDir === "asc" ? "desc" : "asc" };
  }
  return { sortKey: clicked, sortDir: "asc" };
}

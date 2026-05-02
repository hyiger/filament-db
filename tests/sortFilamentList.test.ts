import { describe, it, expect } from "vitest";
import {
  compareFilaments,
  getSortValue,
  nextSortState,
  type SortKey,
  type SortableFilament,
} from "@/lib/sortFilamentList";

/**
 * GH #165 regression guard.
 *
 * Issue #165 reported the Cost column header sorted desc on first click
 * while every other column sorted asc. An empirical UI test against
 * v1.13.1 (and current main) showed all six numeric/text columns behave
 * identically: a fresh click on a column the user wasn't already
 * sorting by sets sortDir = "asc". The "Cost = desc" observation was a
 * misread (likely after an intermediate click had already toggled the
 * direction).
 *
 * The comparator + sort-state logic was extracted from src/app/page.tsx
 * into src/lib/sortFilamentList.ts so this file can lock the symmetric
 * behaviour into the test suite. Any future refactor that introduces a
 * per-column polarity bias will fail the cross-product test below.
 */

function f(overrides: Partial<SortableFilament>): SortableFilament {
  return {
    name: "Filament",
    vendor: "Vendor",
    type: "PLA",
    cost: null,
    temperatures: { nozzle: null, bed: null },
    spools: [],
    spoolWeight: null,
    netFilamentWeight: null,
    totalWeight: null,
    ...overrides,
  };
}

const fixtures: SortableFilament[] = [
  f({ name: "Aardvark", vendor: "Acme", type: "PLA", cost: 10, temperatures: { nozzle: 200, bed: 60 } }),
  f({ name: "Zebra", vendor: "Zoo", type: "ABS", cost: 82, temperatures: { nozzle: 250, bed: 90 } }),
  f({ name: "Mango", vendor: "Mango Co", type: "PETG", cost: null, temperatures: { nozzle: null, bed: null } }),
  f({ name: "Bear", vendor: "BearCorp", type: "TPU", cost: 22, temperatures: { nozzle: 220, bed: 50 } }),
];

describe("getSortValue — null-safe sentinel for numeric columns", () => {
  it("returns -1 for null cost so nulls sort first in asc", () => {
    expect(getSortValue(f({ cost: null }), "cost")).toBe(-1);
  });

  it("returns -1 for null nozzle/bed temperatures (same shape as cost)", () => {
    expect(getSortValue(f({ temperatures: { nozzle: null, bed: null } }), "nozzle")).toBe(-1);
    expect(getSortValue(f({ temperatures: { nozzle: null, bed: null } }), "bed")).toBe(-1);
  });

  it("lowercases text columns for case-insensitive sort", () => {
    expect(getSortValue(f({ name: "Zebra" }), "name")).toBe("zebra");
    expect(getSortValue(f({ vendor: "ACME" }), "vendor")).toBe("acme");
  });
});

describe("compareFilaments — Cost behaves identically to other numeric columns (GH #165)", () => {
  it("Cost asc: nulls first (-1), then ascending price", () => {
    const sorted = [...fixtures].sort(compareFilaments("cost", "asc"));
    expect(sorted.map((x) => x.cost)).toEqual([null, 10, 22, 82]);
  });

  it("Cost desc: highest price first, nulls last", () => {
    const sorted = [...fixtures].sort(compareFilaments("cost", "desc"));
    expect(sorted.map((x) => x.cost)).toEqual([82, 22, 10, null]);
  });

  it("Nozzle asc behaves identically to Cost asc (nulls first)", () => {
    const sorted = [...fixtures].sort(compareFilaments("nozzle", "asc"));
    expect(sorted.map((x) => x.temperatures.nozzle)).toEqual([null, 200, 220, 250]);
  });

  it("Bed asc behaves identically to Cost asc (nulls first)", () => {
    const sorted = [...fixtures].sort(compareFilaments("bed", "asc"));
    expect(sorted.map((x) => x.temperatures.bed)).toEqual([null, 50, 60, 90]);
  });

  it("Name asc sorts case-insensitively", () => {
    const sorted = [...fixtures].sort(compareFilaments("name", "asc"));
    expect(sorted.map((x) => x.name)).toEqual(["Aardvark", "Bear", "Mango", "Zebra"]);
  });
});

describe("nextSortState — clicking a different column always resets to asc (GH #165)", () => {
  // Symmetric cross-product: from every prior column, clicking each other
  // column must reset to asc, regardless of the prior direction. Locks in
  // the behavior across all combinations so a per-column override (the
  // bug the issue suspected) gets caught.
  const cols: SortKey[] = ["name", "vendor", "type", "nozzle", "bed", "cost", "remaining"];

  for (const prev of cols) {
    for (const next of cols) {
      if (prev === next) continue;
      it(`from ${prev}/asc → click ${next} → ${next}/asc`, () => {
        expect(nextSortState({ sortKey: prev, sortDir: "asc" }, next)).toEqual({ sortKey: next, sortDir: "asc" });
      });
      it(`from ${prev}/desc → click ${next} → ${next}/asc (does not inherit prior dir)`, () => {
        expect(nextSortState({ sortKey: prev, sortDir: "desc" }, next)).toEqual({ sortKey: next, sortDir: "asc" });
      });
    }
  }

  it("clicking the same column toggles asc → desc", () => {
    expect(nextSortState({ sortKey: "cost", sortDir: "asc" }, "cost")).toEqual({ sortKey: "cost", sortDir: "desc" });
  });

  it("clicking the same column toggles desc → asc", () => {
    expect(nextSortState({ sortKey: "cost", sortDir: "desc" }, "cost")).toEqual({ sortKey: "cost", sortDir: "asc" });
  });
});

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

describe("getSortValue — null for missing numeric columns", () => {
  it("returns null for null cost so the comparator can sink it last", () => {
    expect(getSortValue(f({ cost: null }), "cost")).toBe(null);
  });

  it("returns null for null nozzle/bed temperatures (same shape as cost)", () => {
    expect(getSortValue(f({ temperatures: { nozzle: null, bed: null } }), "nozzle")).toBe(null);
    expect(getSortValue(f({ temperatures: { nozzle: null, bed: null } }), "bed")).toBe(null);
  });

  it("lowercases text columns for case-insensitive sort", () => {
    expect(getSortValue(f({ name: "Zebra" }), "name")).toBe("zebra");
    expect(getSortValue(f({ vendor: "ACME" }), "vendor")).toBe("acme");
    expect(getSortValue(f({ type: "PETG" }), "type")).toBe("petg");
  });

  it("computes the remaining percentage for a weight-tracked filament", () => {
    // spools present + spoolWeight + netFilamentWeight all set → real %.
    // remaining grams = 750 - 250 = 500; net = 1000 → 50%.
    const value = getSortValue(
      f({
        spools: [{ totalWeight: 750, retired: false }] as SortableFilament["spools"],
        spoolWeight: 250,
        netFilamentWeight: 1000,
      }),
      "remaining",
    );
    expect(value).toBe(50);
  });

  it("returns null for remaining when the filament isn't weight-tracked", () => {
    // No spools and no legacy weights → getRemainingPct returns null, and
    // the `?? null` fallback keeps it null for the comparator to sink last.
    expect(getSortValue(f({ spools: [], spoolWeight: null, netFilamentWeight: null }), "remaining")).toBe(
      null,
    );
  });
});

describe("compareFilaments — nulls always sort last, regardless of direction (#575.6)", () => {
  it("Cost asc: ascending price first, nulls last", () => {
    const sorted = [...fixtures].sort(compareFilaments("cost", "asc"));
    expect(sorted.map((x) => x.cost)).toEqual([10, 22, 82, null]);
  });

  it("Cost desc: highest price first, nulls still last", () => {
    const sorted = [...fixtures].sort(compareFilaments("cost", "desc"));
    expect(sorted.map((x) => x.cost)).toEqual([82, 22, 10, null]);
  });

  it("Nozzle asc: ascending temp first, nulls last", () => {
    const sorted = [...fixtures].sort(compareFilaments("nozzle", "asc"));
    expect(sorted.map((x) => x.temperatures.nozzle)).toEqual([200, 220, 250, null]);
  });

  it("Bed asc: ascending temp first, nulls last", () => {
    const sorted = [...fixtures].sort(compareFilaments("bed", "asc"));
    expect(sorted.map((x) => x.temperatures.bed)).toEqual([50, 60, 90, null]);
  });

  it("Name asc sorts case-insensitively", () => {
    const sorted = [...fixtures].sort(compareFilaments("name", "asc"));
    expect(sorted.map((x) => x.name)).toEqual(["Aardvark", "Bear", "Mango", "Zebra"]);
  });

  it("two blank values compare as equal (stable, both sink together)", () => {
    // Both costs null → the aBlank && bBlank arm returns 0 (order preserved).
    const cmp = compareFilaments("cost", "asc");
    expect(cmp(f({ cost: null }), f({ cost: null }))).toBe(0);
  });

  it("a real value ranks above a blank one regardless of argument order", () => {
    const cmp = compareFilaments("cost", "asc");
    const real = f({ cost: 10 });
    const blank = f({ cost: null });
    // blank as `a` → sinks below (returns 1); blank as `b` → real stays above (returns -1).
    expect(cmp(blank, real)).toBe(1);
    expect(cmp(real, blank)).toBe(-1);
  });

  it("equal non-blank values compare as 0 (neither > nor <)", () => {
    const cmp = compareFilaments("cost", "asc");
    expect(cmp(f({ cost: 22 }), f({ cost: 22 }))).toBe(0);
  });

  it("desc direction inverts the greater-than branch for real values", () => {
    // Exercises the `aVal > bVal` arm returning 1 under asc and -1 under desc.
    const higher = f({ cost: 82 });
    const lower = f({ cost: 10 });
    expect(compareFilaments("cost", "asc")(higher, lower)).toBe(1);
    expect(compareFilaments("cost", "desc")(higher, lower)).toBe(-1);
  });

  it("Remaining asc: higher remaining % last under asc, weight-untracked sinks to the end", () => {
    const spoolsAt = (totalWeight: number): SortableFilament["spools"] =>
      [{ totalWeight, retired: false }] as SortableFilament["spools"];
    const remainingFixtures: SortableFilament[] = [
      f({ name: "Full", spools: spoolsAt(1000), spoolWeight: 0, netFilamentWeight: 1000 }), // 100%
      f({ name: "Half", spools: spoolsAt(500), spoolWeight: 0, netFilamentWeight: 1000 }), // 50%
      f({ name: "Untracked", spools: [], spoolWeight: null, netFilamentWeight: null }), // null
      f({ name: "Low", spools: spoolsAt(100), spoolWeight: 0, netFilamentWeight: 1000 }), // 10%
    ];
    const sorted = [...remainingFixtures].sort(compareFilaments("remaining", "asc"));
    expect(sorted.map((x) => x.name)).toEqual(["Low", "Half", "Full", "Untracked"]);
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

/**
 * Color facet — tests for src/lib/homeListVisibility.ts. Pure, no DB / DOM.
 *
 * Two jobs:
 *  1. Regression guards for moving the home list's `visibleFilaments` memo
 *     out of `src/app/page.tsx`. `legacyVisible` / `legacyOutOfStockCount`
 *     below are the page's pre-move code, verbatim apart from the closure
 *     variables becoming arguments; every fixture × option combination must
 *     agree with them when no color is active.
 *  2. The color chip contract: a chip's `shown` equals the matching rows the
 *     list renders with that facet active, for every facet.
 */
import { describe, it, expect } from "vitest";
import {
  colorFacetCounts,
  colorRowVisible,
  computeVisibleFilaments,
  countBlankDefaultColor,
  countOutOfStockHidden,
  inStockPredicate,
  isLowStock,
  type HomeListRow,
} from "@/lib/homeListVisibility";
import {
  COLOR_FACET_VALUES,
  matchesColorFacet,
  scopeByColorFacet,
} from "@/lib/colorFamily";
import { QUICK_FILTERS, type QuickFilter } from "@/components/QuickFilterChips";
import { getRemainingGrams, getSpoolCount } from "@/lib/inventoryStats";

type Row = HomeListRow & { _id: string; parentId: string | null; name: string; type: string };

let seq = 0;
function row(p: Partial<Row> & { spoolsSpec?: string }): Row {
  const { spoolsSpec, ...rest } = p;
  const spools = (spoolsSpec ?? "").split("").map((c, i) => ({
    _id: `s${seq}-${i}`,
    totalWeight: c === "E" ? null : 1000,
    retired: c === "R",
  }));
  return {
    _id: `r${seq++}`,
    parentId: null,
    name: "Row",
    vendor: "Acme",
    type: "PLA",
    color: "#FF8000",
    secondaryColors: [],
    optTags: [],
    hasVariants: false,
    spools,
    totalWeight: null,
    spoolWeight: null,
    netFilamentWeight: null,
    lowStockThreshold: null,
    hasCalibrations: true,
    ...rest,
  };
}

// --- the page's pre-move code -------------------------------------------------

function legacyIsLowStock(f: Row): boolean {
  const threshold = f.lowStockThreshold;
  if (!threshold || threshold <= 0) return false;
  const remaining = getRemainingGrams(f);
  return remaining !== null && remaining < threshold;
}

function legacyVisible(
  filaments: Row[],
  quickFilter: QuickFilter,
  showOutOfStock: boolean,
  debouncedSearch: string,
  typeFilter: string,
  vendorFilter: string,
): Row[] {
  const inventoryFilaments = filaments.filter((f) => !f.hasVariants);
  const parentsWithStock = new Set<string>();
  for (const f of filaments) {
    if (f.parentId && getSpoolCount(f) > 0) parentsWithStock.add(f.parentId);
  }
  const inStock = (f: Row) => getSpoolCount(f) > 0 || parentsWithStock.has(f._id);
  if (quickFilter === "all") {
    const filterActive = !!debouncedSearch || !!typeFilter || !!vendorFilter;
    if (showOutOfStock || filterActive) return filaments;
    const inStockList = filaments.filter(inStock);
    return inStockList.length === 0 ? filaments : inStockList;
  }
  if (quickFilter === "hasSpools") {
    return filaments.filter((f) => getSpoolCount(f) > 0);
  }
  return inventoryFilaments.filter((f) => {
    if (quickFilter === "lowStock") return legacyIsLowStock(f);
    if (quickFilter === "noCalibration") return !f.hasCalibrations;
    return true;
  });
}

function legacyOutOfStockCount(filaments: Row[]): number {
  const parentsWithStock = new Set<string>();
  for (const f of filaments) {
    if (f.parentId && getSpoolCount(f) > 0) parentsWithStock.add(f.parentId);
  }
  const inStock = (f: Row) => getSpoolCount(f) > 0 || parentsWithStock.has(f._id);
  const shownParents = new Set(
    filaments.filter((f) => f.hasVariants && inStock(f)).map((f) => f._id),
  );
  return filaments.filter((f) => {
    if (f.hasVariants) return false;
    if (getSpoolCount(f) > 0) return false;
    if (f.parentId && shownParents.has(f.parentId)) return false;
    return true;
  }).length;
}

// --- fixtures -----------------------------------------------------------------

function library(): Row[] {
  const tplOrange = row({ name: "Pro PCTG", type: "PCTG", color: null, hasVariants: true });
  const tplDead = row({ name: "Old PETG", type: "PETG", color: null, hasVariants: true });
  return [
    // Standalone orange, legacy single-spool roll (no subdocs).
    row({ name: "Atomic PCTG PRO", type: "PCTG", color: "#FF4D06", totalWeight: 1258 }),
    // Template with an in-stock orange, an out-of-stock orange and a black.
    tplOrange,
    row({ name: "Pro PCTG Tangerine Orange", type: "PCTG", parentId: tplOrange._id, color: "#F28500" }),
    row({ name: "Pro PCTG Orange", type: "PCTG", parentId: tplOrange._id, color: "#FF8000", spoolsSpec: "A" }),
    row({ name: "Pro PCTG Midnight Black", type: "PCTG", parentId: tplOrange._id, color: "#3A3A3A", spoolsSpec: "AR" }),
    // Template whose only variant is retired-only → out of stock family.
    tplDead,
    row({ name: "Old PETG Blue", type: "PETG", parentId: tplDead._id, color: "#1E63D6", spoolsSpec: "R" }),
    // Legacy parent still holding its OWN spool, with a variant.
    row({ _id: "legacy", name: "Legacy PLA", color: "#FFFFFF", hasVariants: true, spoolsSpec: "A" }),
    row({ name: "Legacy PLA Red", parentId: "legacy", color: "#D32F2F", spoolsSpec: "" }),
    // Low stock + no calibration.
    row({
      name: "Nearly empty ASA Orange",
      type: "ASA",
      color: "#F57C00",
      spoolsSpec: "A",
      spoolWeight: 950,
      lowStockThreshold: 100,
      hasCalibrations: false,
    }),
    // The blank default gray, and a real gray on the same hex.
    row({ name: "Overture PLA Original", color: "#808080", spoolsSpec: "A" }),
    row({ name: "Overture PETG Grey", type: "PETG", color: "#808080", spoolsSpec: "A" }),
    // No-weight spool still counts as in stock.
    row({ name: "CHCKX PCTG Orange", type: "PCTG", color: "#FF8000", spoolsSpec: "E" }),
  ];
}

const nothingInStock = (): Row[] => [
  row({ name: "A Orange", spoolsSpec: "" }),
  row({ name: "B Black", color: "#000000", spoolsSpec: "R" }),
];

const serverFilterShapes: [string, string, string][] = [
  ["", "", ""],
  ["pla", "", ""],
  ["", "PCTG", ""],
  ["", "", "Acme"],
];

// --- tests --------------------------------------------------------------------

describe("isLowStock", () => {
  it("needs a positive threshold and computable grams below it", () => {
    expect(isLowStock(row({ spoolsSpec: "A", spoolWeight: 950, lowStockThreshold: 100 }))).toBe(true);
    expect(isLowStock(row({ spoolsSpec: "A", spoolWeight: 800, lowStockThreshold: 100 }))).toBe(false);
    expect(isLowStock(row({ spoolsSpec: "A", spoolWeight: 950, lowStockThreshold: 0 }))).toBe(false);
    expect(isLowStock(row({ spoolsSpec: "A", spoolWeight: 950, lowStockThreshold: null }))).toBe(false);
    expect(isLowStock(row({ spoolsSpec: "E", lowStockThreshold: 100 }))).toBe(false);
  });
});

describe("inStockPredicate", () => {
  it("counts a parent as in stock when any variant is", () => {
    const lib = library();
    const inStock = inStockPredicate(lib);
    const tpl = lib.find((f) => f.name === "Pro PCTG")!;
    const dead = lib.find((f) => f.name === "Old PETG")!;
    expect(inStock(tpl)).toBe(true);
    expect(inStock(dead)).toBe(false);
    // Legacy roll + a no-weight spool both count (GH #1107 / getSpoolCount).
    expect(inStock(lib.find((f) => f.name === "Atomic PCTG PRO")!)).toBe(true);
    expect(inStock(lib.find((f) => f.name === "CHCKX PCTG Orange")!)).toBe(true);
  });
});

describe("computeVisibleFilaments — no color (regression guard for the move)", () => {
  it("matches the page's pre-move memo for every quick filter × toggle × server filter", () => {
    for (const lib of [library(), nothingInStock(), []]) {
      for (const quickFilter of QUICK_FILTERS) {
        for (const showOutOfStock of [false, true]) {
          for (const [q, type, vendor] of serverFilterShapes) {
            const expected = legacyVisible(lib, quickFilter, showOutOfStock, q, type, vendor);
            const actual = computeVisibleFilaments(lib, {
              quickFilter,
              showOutOfStock,
              serverFilterActive: !!q || !!type || !!vendor,
              colorActive: false,
            });
            expect(actual.map((f) => f._id)).toEqual(expected.map((f) => f._id));
          }
        }
      }
    }
  });

  it("#712: the out-of-stock hide runs only on the unfiltered view, and returns the same array otherwise", () => {
    const lib = library();
    const base = { quickFilter: "all" as const, colorActive: false };
    const hidden = computeVisibleFilaments(lib, { ...base, showOutOfStock: false, serverFilterActive: false });
    expect(hidden.map((f) => f.name)).not.toContain("Old PETG");
    expect(hidden.map((f) => f.name)).not.toContain("Pro PCTG Tangerine Orange");
    // A template stays when a variant is in stock.
    expect(hidden.map((f) => f.name)).toContain("Pro PCTG");
    expect(computeVisibleFilaments(lib, { ...base, showOutOfStock: false, serverFilterActive: true })).toBe(lib);
    expect(computeVisibleFilaments(lib, { ...base, showOutOfStock: true, serverFilterActive: false })).toBe(lib);
  });

  it("#847: never hides everything when nothing is in stock", () => {
    const lib = nothingInStock();
    expect(
      computeVisibleFilaments(lib, {
        quickFilter: "all",
        showOutOfStock: false,
        serverFilterActive: false,
        colorActive: false,
      }),
    ).toBe(lib);
  });

  it("#552/#1107: Has spools uses getSpoolCount over the full list, parents included", () => {
    const names = computeVisibleFilaments(library(), {
      quickFilter: "hasSpools",
      showOutOfStock: false,
      serverFilterActive: false,
      colorActive: false,
    }).map((f) => f.name);
    expect(names).toContain("Legacy PLA"); // parent with its own spool
    expect(names).toContain("Atomic PCTG PRO"); // legacy roll
    expect(names).not.toContain("Old PETG Blue"); // retired-only
  });

  it("low stock and no calibration resolve against inventory rows only", () => {
    const lib = library();
    lib.find((f) => f.name === "Legacy PLA")!.hasCalibrations = false;
    const opts = { showOutOfStock: false, serverFilterActive: false, colorActive: false };
    expect(computeVisibleFilaments(lib, { ...opts, quickFilter: "lowStock" }).map((f) => f.name)).toEqual([
      "Nearly empty ASA Orange",
    ]);
    const noCal = computeVisibleFilaments(lib, { ...opts, quickFilter: "noCalibration" }).map((f) => f.name);
    expect(noCal).toEqual(["Nearly empty ASA Orange"]);
  });
});

describe("computeVisibleFilaments — color active", () => {
  const opts = { quickFilter: "all" as const, showOutOfStock: false, serverFilterActive: false };

  it("keeps the out-of-stock hide on and drops out-of-stock matches from a family", () => {
    const lib = library();
    const scoped = scopeByColorFacet(lib, "orange");
    const names = computeVisibleFilaments(scoped, { ...opts, colorActive: true }).map((f) => f.name);
    expect(names).toContain("Pro PCTG");
    expect(names).toContain("Pro PCTG Orange");
    expect(names).not.toContain("Pro PCTG Tangerine Orange");
    expect(names).not.toContain("Pro PCTG Midnight Black");
  });

  it("skips the #847 show-everything fallback", () => {
    const lib = nothingInStock();
    const scoped = scopeByColorFacet(lib, "orange");
    expect(scoped).toHaveLength(1);
    expect(computeVisibleFilaments(scoped, { ...opts, colorActive: true })).toEqual([]);
    expect(computeVisibleFilaments(scoped, { ...opts, colorActive: false })).toBe(scoped);
  });

  it("a server filter still shows every match (#712)", () => {
    const scoped = scopeByColorFacet(library(), "orange");
    expect(
      computeVisibleFilaments(scoped, { ...opts, serverFilterActive: true, colorActive: true }),
    ).toBe(scoped);
  });
});

describe("countOutOfStockHidden", () => {
  it("matches the page's pre-move toggle badge", () => {
    for (const lib of [library(), nothingInStock(), []]) {
      expect(countOutOfStockHidden(lib)).toBe(legacyOutOfStockCount(lib));
    }
  });

  it("doesn't count an out-of-stock variant of a stocked family (#786)", () => {
    // Tangerine (stocked family) and Legacy PLA Red (its parent holds its own
    // spool, so the family is shown) are rendered; only Old PETG Blue is
    // hidden.
    expect(countOutOfStockHidden(library())).toBe(1);
  });
});

describe("colorFacetCounts", () => {
  const optionCombos = QUICK_FILTERS.flatMap((quickFilter) =>
    [false, true].flatMap((showOutOfStock) =>
      [false, true].map((serverFilterActive) => ({ quickFilter, showOutOfStock, serverFilterActive })),
    ),
  );

  it("shown equals the matching rows the list renders, for every facet and option", () => {
    for (const lib of [library(), nothingInStock()]) {
      for (const o of optionCombos) {
        const counts = colorFacetCounts(lib, o);
        expect(Object.keys(counts)).toHaveLength(COLOR_FACET_VALUES.length);
        for (const facet of COLOR_FACET_VALUES) {
          const rendered = computeVisibleFilaments(scopeByColorFacet(lib, facet), {
            ...o,
            colorActive: true,
          });
          const nonTemplate = rendered.filter((f) => matchesColorFacet(f, facet));
          expect(counts[facet].shown, `${facet} ${JSON.stringify(o)}`).toBe(nonTemplate.length);
          // The per-row form agrees, so relaxation suggestion counts can't
          // promise rows the list won't show.
          const perRow = lib.filter((f) => matchesColorFacet(f, facet) && colorRowVisible(f, o)).length;
          expect(perRow, `${facet} per-row ${JSON.stringify(o)}`).toBe(counts[facet].shown);
        }
      }
    }
  });

  it("hidden counts what the out-of-stock toggle reveals", () => {
    const lib = library();
    const counts = colorFacetCounts(lib, {
      quickFilter: "all",
      showOutOfStock: false,
      serverFilterActive: false,
    });
    // Atomic (legacy roll), Pro PCTG Orange, ASA, CHCKX (no-weight spool).
    expect(counts.orange).toEqual({ shown: 4, hidden: 1 });
    expect(counts.blue).toEqual({ shown: 0, hidden: 1 });
    expect(counts.purple).toEqual({ shown: 0, hidden: 0 });
    // Named black, dark-gray swatch: listed under both (additive membership).
    expect(counts.black.shown).toBe(1);
    expect(counts["gray-dark"].shown).toBe(1);
    // #808080: only the gray-named one is gray; the other is No color.
    expect(counts.gray.shown).toBe(2);
    expect(counts.unknown.shown).toBe(1);

    const revealed = colorFacetCounts(lib, {
      quickFilter: "all",
      showOutOfStock: true,
      serverFilterActive: false,
    });
    // The badge survives switching the toggle on.
    expect(revealed.orange).toEqual({ shown: 5, hidden: 1 });
    expect(
      colorFacetCounts(lib, { quickFilter: "hasSpools", showOutOfStock: false, serverFilterActive: false })
        .blue,
    ).toEqual({ shown: 0, hidden: 0 });
    expect(
      colorFacetCounts(lib, { quickFilter: "all", showOutOfStock: false, serverFilterActive: true }).orange,
    ).toEqual({ shown: 5, hidden: 0 });
  });

  it("never counts a template", () => {
    const tpl = row({ name: "Orange template", color: "#FF8000", hasVariants: true });
    const v = row({ name: "Variant", parentId: tpl._id, color: "#FF8000", spoolsSpec: "A" });
    const counts = colorFacetCounts([tpl, v], {
      quickFilter: "all",
      showOutOfStock: true,
      serverFilterActive: false,
    });
    expect(counts.orange.shown).toBe(1);
  });

  it("returns zeros for an empty list", () => {
    const counts = colorFacetCounts([], { quickFilter: "all", showOutOfStock: false, serverFilterActive: false });
    expect(Object.values(counts).every((c) => c.shown === 0 && c.hidden === 0)).toBe(true);
  });
});

describe("colorRowVisible", () => {
  it("applies each quick filter to a single matching row", () => {
    const o = { showOutOfStock: false, serverFilterActive: false };
    const stocked = row({ spoolsSpec: "A" });
    const empty = row({ spoolsSpec: "" });
    expect(colorRowVisible(stocked, { ...o, quickFilter: "all" })).toBe(true);
    expect(colorRowVisible(empty, { ...o, quickFilter: "all" })).toBe(false);
    expect(colorRowVisible(empty, { ...o, showOutOfStock: true, quickFilter: "all" })).toBe(true);
    expect(colorRowVisible(empty, { ...o, serverFilterActive: true, quickFilter: "all" })).toBe(true);
    expect(colorRowVisible(empty, { ...o, quickFilter: "hasSpools" })).toBe(false);
    const legacyParent = row({ spoolsSpec: "A", hasVariants: true, hasCalibrations: false });
    expect(colorRowVisible(legacyParent, { ...o, quickFilter: "noCalibration" })).toBe(false);
    expect(colorRowVisible(row({ hasCalibrations: false }), { ...o, quickFilter: "noCalibration" })).toBe(true);
    expect(
      colorRowVisible(row({ spoolsSpec: "A", spoolWeight: 950, lowStockThreshold: 100 }), {
        ...o,
        quickFilter: "lowStock",
      }),
    ).toBe(true);
  });
});

describe("countBlankDefaultColor", () => {
  it("counts the #808080 default, case- and whitespace-insensitively", () => {
    expect(
      countBlankDefaultColor([
        { color: "#808080" },
        { color: " #808080 " },
        { color: "#8080800" },
        { color: "#818181" },
        { color: null },
        {},
      ]),
    ).toBe(2);
  });
});

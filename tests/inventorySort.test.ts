import { describe, it, expect } from "vitest";
import {
  groupAndSortInventory,
  inventoryRemainingGrams,
  summarizeInventoryGroups,
  INVENTORY_NO_GROUP_KEY,
  INVENTORY_ALL_KEY,
  INVENTORY_COLOR_KEY_PREFIX,
  INVENTORY_GROUP_BYS,
  inventoryRowColorFamily,
  type InventoryRow,
  type InventorySourceGroup,
} from "@/lib/inventorySort";
import { COLOR_FAMILIES } from "@/lib/colorFamily";
import { INVENTORY_FILTER_SPEC, DEFAULT_INVENTORY_PREFS } from "@/lib/listFilterSpecs";
import {
  parseFilterParams,
  seedFilterState,
  serializeFilterParams,
} from "@/lib/listFilterParams";
import en from "@/i18n/locales/en.json";
import de from "@/i18n/locales/de.json";

/**
 * GH #795 — pure regroup + sort transforms for the /inventory page.
 */

type Row = InventoryRow & { id: string };

function row(id: string, over: Partial<InventoryRow> = {}): Row {
  return {
    id,
    filamentName: id,
    filamentType: "PLA",
    filamentVendor: "Acme",
    totalWeight: 1000,
    spoolWeight: 200,
    parentSpoolWeight: null,
    purchaseDate: null,
    openedDate: null,
    ...over,
  };
}

function loc(id: string, name: string) {
  return { _id: id, name, kind: "shelf", humidity: null, desiccantChangedAt: null, notes: "" };
}

describe("inventoryRemainingGrams", () => {
  it("subtracts the tare (own, else parent, else 0)", () => {
    expect(inventoryRemainingGrams(row("a", { totalWeight: 1000, spoolWeight: 200 }))).toBe(800);
    expect(
      inventoryRemainingGrams(row("b", { totalWeight: 1000, spoolWeight: null, parentSpoolWeight: 250 })),
    ).toBe(750);
    expect(
      inventoryRemainingGrams(row("c", { totalWeight: 1000, spoolWeight: null, parentSpoolWeight: null })),
    ).toBe(1000); // 0g fallback
  });

  it("clamps at 0 and returns null when no totalWeight", () => {
    expect(inventoryRemainingGrams(row("a", { totalWeight: 100, spoolWeight: 200 }))).toBe(0);
    expect(inventoryRemainingGrams(row("b", { totalWeight: null }))).toBeNull();
  });
});

describe("groupAndSortInventory — grouping", () => {
  const shelf = loc("L1", "Shelf A");
  const dry = loc("L2", "Drybox");
  const source: InventorySourceGroup<Row>[] = [
    {
      locationId: "L1",
      location: shelf,
      count: 2,
      totalGrams: 0,
      spools: [
        row("pla-shelf", { filamentType: "PLA", filamentVendor: "Acme", totalWeight: 1000, spoolWeight: 200 }),
        row("petg-shelf", { filamentType: "PETG", filamentVendor: "Globex", totalWeight: 900, spoolWeight: 200 }),
      ],
    },
    {
      locationId: null,
      location: null,
      count: 1,
      totalGrams: 0,
      spools: [row("pla-noloc", { filamentType: "PLA", filamentVendor: "Acme", totalWeight: 500, spoolWeight: 200 })],
    },
    {
      locationId: "L2",
      location: dry,
      count: 1,
      totalGrams: 0,
      spools: [row("blank-type", { filamentType: "", filamentVendor: "", totalWeight: 800, spoolWeight: 200 })],
    },
  ];

  it("location grouping keeps locations (ordered by name) and sinks the no-location bucket last", () => {
    const out = groupAndSortInventory(source, "location", "name", "asc");
    // Groups order alphabetically by location name: Drybox (L2) before Shelf A (L1).
    expect(out.map((g) => g.key)).toEqual(["L2", "L1", INVENTORY_NO_GROUP_KEY]);
    expect(out[0].location?.name).toBe("Drybox");
    expect(out[out.length - 1].key).toBe(INVENTORY_NO_GROUP_KEY);
  });

  it("type grouping re-buckets by type; blank type → one no-group bucket last", () => {
    const out = groupAndSortInventory(source, "type", "name", "asc");
    const keys = out.map((g) => g.key);
    expect(keys).toContain("PLA");
    expect(keys).toContain("PETG");
    expect(keys[keys.length - 1]).toBe(INVENTORY_NO_GROUP_KEY); // blank type last
    const pla = out.find((g) => g.key === "PLA")!;
    expect(pla.label).toBe("PLA");
    expect(pla.count).toBe(2); // pla-shelf + pla-noloc
    // remaining = gross − tare summed: 800 + 300 = 1100
    expect(pla.totalGrams).toBe(1100);
    expect(pla.location).toBeNull();
  });

  it("vendor grouping buckets by vendor", () => {
    const out = groupAndSortInventory(source, "vendor", "name", "asc");
    expect(out.map((g) => g.key)).toEqual(["Acme", "Globex", INVENTORY_NO_GROUP_KEY]);
  });

  it("none grouping collapses to a single group with every spool", () => {
    const out = groupAndSortInventory(source, "none", "name", "asc");
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe(INVENTORY_ALL_KEY);
    expect(out[0].count).toBe(4);
  });
});

describe("groupAndSortInventory — sorting", () => {
  const rows: Row[] = [
    row("full", { totalWeight: 1000, spoolWeight: 200 }), // 800
    row("near-empty", { totalWeight: 250, spoolWeight: 200 }), // 50
    row("unknown", { totalWeight: null }), // null
    row("mid", { totalWeight: 600, spoolWeight: 200 }), // 400
  ];
  const source: InventorySourceGroup<Row>[] = [
    { locationId: "L1", location: loc("L1", "Shelf"), count: rows.length, totalGrams: 0, spools: rows },
  ];

  it("remaining ascending puts the near-empty spool first and the unknown last", () => {
    const out = groupAndSortInventory(source, "none", "remaining", "asc");
    expect(out[0].spools.map((r) => r.id)).toEqual(["near-empty", "mid", "full", "unknown"]);
  });

  it("remaining descending reverses the known values but still sinks the unknown last", () => {
    const out = groupAndSortInventory(source, "none", "remaining", "desc");
    expect(out[0].spools.map((r) => r.id)).toEqual(["full", "mid", "near-empty", "unknown"]);
  });

  it("treats a no-tare row's remaining as unknown — sinks last in sort, but its gross still counts in the total (Codex P2)", () => {
    const rows: Row[] = [
      row("with-tare", { totalWeight: 1000, spoolWeight: 200 }), // 800 remaining
      row("no-tare", { totalWeight: 950, spoolWeight: null, parentSpoolWeight: null }), // unknown
      row("near-empty", { totalWeight: 250, spoolWeight: 200 }), // 50
    ];
    const g: InventorySourceGroup<Row>[] = [
      { locationId: null, location: null, count: rows.length, totalGrams: 0, spools: rows },
    ];
    const out = groupAndSortInventory(g, "none", "remaining", "asc");
    // no-tare sinks LAST despite a large gross weight; real values ascend before it
    expect(out[0].spools.map((r) => r.id)).toEqual(["near-empty", "with-tare", "no-tare"]);
    // ...but the group total still includes the no-tare gross (0g-tare fallback):
    // 800 + 950 + 50 = 1800
    expect(out[0].totalGrams).toBe(1800);
  });

  it("sorts by name and by date, nulls last either direction", () => {
    const dated: Row[] = [
      row("c", { purchaseDate: "2026-03-01" }),
      row("a", { purchaseDate: "2026-01-01" }),
      row("none", { purchaseDate: null }),
      row("b", { purchaseDate: "2026-02-01" }),
    ];
    const g: InventorySourceGroup<Row>[] = [
      { locationId: null, location: null, count: dated.length, totalGrams: 0, spools: dated },
    ];
    expect(groupAndSortInventory(g, "none", "purchase", "asc")[0].spools.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "none",
    ]);
    // desc: known dates reverse, null still last
    expect(groupAndSortInventory(g, "none", "purchase", "desc")[0].spools.map((r) => r.id)).toEqual([
      "c",
      "b",
      "a",
      "none",
    ]);
    expect(groupAndSortInventory(g, "none", "name", "asc")[0].spools.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "none",
    ]);
  });

  it("sorts by name with a blank name sinking last (isBlank guard)", () => {
    const named: Row[] = [
      row("charlie", { filamentName: "Charlie" }),
      row("blank", { filamentName: "   " }), // whitespace → blank → null → sinks
      row("alpha", { filamentName: "Alpha" }),
    ];
    const g: InventorySourceGroup<Row>[] = [
      { locationId: null, location: null, count: named.length, totalGrams: 0, spools: named },
    ];
    expect(groupAndSortInventory(g, "none", "name", "asc")[0].spools.map((r) => r.id)).toEqual([
      "alpha",
      "charlie",
      "blank",
    ]);
  });

  it("sorts by type, blank types sink last either direction", () => {
    const typed: Row[] = [
      row("petg", { filamentType: "PETG" }),
      row("blank", { filamentType: "  " }), // whitespace → blank → null → sinks
      row("abs", { filamentType: "ABS" }),
      row("pla", { filamentType: "PLA" }),
    ];
    const g: InventorySourceGroup<Row>[] = [
      { locationId: null, location: null, count: typed.length, totalGrams: 0, spools: typed },
    ];
    expect(groupAndSortInventory(g, "none", "type", "asc")[0].spools.map((r) => r.id)).toEqual([
      "abs",
      "petg",
      "pla",
      "blank",
    ]);
    // desc reverses the real values (case-insensitive) but the blank still sinks last
    expect(groupAndSortInventory(g, "none", "type", "desc")[0].spools.map((r) => r.id)).toEqual([
      "pla",
      "petg",
      "abs",
      "blank",
    ]);
  });

  it("sorts by vendor, case-insensitively, blank vendors sink last", () => {
    const vendored: Row[] = [
      row("globex", { filamentVendor: "globex" }), // lowercase — sort is case-insensitive
      row("acme", { filamentVendor: "Acme" }),
      row("blank", { filamentVendor: "" }), // blank → null → sinks
      row("zenith", { filamentVendor: "Zenith" }),
    ];
    const g: InventorySourceGroup<Row>[] = [
      { locationId: null, location: null, count: vendored.length, totalGrams: 0, spools: vendored },
    ];
    expect(groupAndSortInventory(g, "none", "vendor", "asc")[0].spools.map((r) => r.id)).toEqual([
      "acme",
      "globex",
      "zenith",
      "blank",
    ]);
  });

  it("sorts by opened date; missing and malformed dates both sink last", () => {
    const opened: Row[] = [
      row("later", { openedDate: "2026-05-01" }),
      row("missing", { openedDate: null }), // no date → null → sinks
      row("earlier", { openedDate: "2026-04-01" }),
      row("garbage", { openedDate: "not-a-date" }), // Date.parse → NaN → null → sinks
    ];
    const g: InventorySourceGroup<Row>[] = [
      { locationId: null, location: null, count: opened.length, totalGrams: 0, spools: opened },
    ];
    const out = groupAndSortInventory(g, "none", "opened", "asc")[0].spools.map((r) => r.id);
    // real dates ascend first; the two unknowns (null + NaN) sink to the end
    expect(out.slice(0, 2)).toEqual(["earlier", "later"]);
    expect(out.slice(2).sort()).toEqual(["garbage", "missing"]);
  });

  it("keeps two same-key unknowns stable relative to each other (both-null tie → 0)", () => {
    // Two rows whose sort value is null for the SAME key exercise the
    // `av == null && bv == null` tie path; the sort is stable so input order holds.
    const both: Row[] = [
      row("first", { totalWeight: null }), // remaining unknown
      row("second", { totalWeight: null }), // remaining unknown
      row("real", { totalWeight: 1000, spoolWeight: 200 }), // 800
    ];
    const g: InventorySourceGroup<Row>[] = [
      { locationId: null, location: null, count: both.length, totalGrams: 0, spools: both },
    ];
    const out = groupAndSortInventory(g, "none", "remaining", "asc")[0].spools.map((r) => r.id);
    expect(out).toEqual(["real", "first", "second"]);
  });
});

describe("groupAndSortInventory — group ordering edge cases", () => {
  it("orders location groups by name, tolerating a location with an empty name (|| '' fallback)", () => {
    // A real locationId but an empty-name Location reaches the `a.location?.name || ""`
    // fallback at the group comparator (it is NOT the no-location sentinel bucket).
    const source: InventorySourceGroup<Row>[] = [
      {
        locationId: "L1",
        location: loc("L1", "Shelf"),
        count: 1,
        totalGrams: 0,
        spools: [row("s1")],
      },
      {
        locationId: "L2",
        location: loc("L2", ""), // empty name → sorts first via "" localeCompare
        count: 1,
        totalGrams: 0,
        spools: [row("s2")],
      },
    ];
    const out = groupAndSortInventory(source, "location", "name", "asc");
    // "" < "Shelf", so the empty-named location group comes first; both are real
    // location groups (neither is the no-location sentinel), so the last comparator
    // arm with the `?.name || ""` fallback runs.
    expect(out.map((g) => g.key)).toEqual(["L2", "L1"]);
  });

  it("orders type groups by label", () => {
    const source: InventorySourceGroup<Row>[] = [
      {
        locationId: "L1",
        location: loc("L1", "Shelf"),
        count: 2,
        totalGrams: 0,
        spools: [row("z", { filamentType: "TPU" }), row("a", { filamentType: "ABS" })],
      },
    ];
    const out = groupAndSortInventory(source, "type", "name", "asc");
    // ABS before TPU (label localeCompare at the group comparator's last arm)
    expect(out.map((g) => g.label)).toEqual(["ABS", "TPU"]);
  });
});

describe("summarizeInventoryGroups (#1117 f)", () => {
  const group = (
    locationId: string | null,
    count: number,
    totalGrams: number,
  ): InventorySourceGroup => ({
    locationId,
    location: null,
    spools: [],
    count,
    totalGrams,
  });

  it("sums counts and grams across every group", () => {
    expect(summarizeInventoryGroups([group("a", 3, 1500), group("b", 2, 900)])).toEqual({
      spoolCount: 5,
      locationCount: 2,
      totalGrams: 2400,
    });
  });

  it("counts the synthetic no-location bucket as a location (#575.5)", () => {
    // Counting only real locations rendered "LOCATIONS 0" while spools sat
    // under "No location".
    expect(summarizeInventoryGroups([group(null, 13, 6000)]).locationCount).toBe(1);
  });

  it("returns zeros for an empty result rather than throwing", () => {
    expect(summarizeInventoryGroups([])).toEqual({
      spoolCount: 0,
      locationCount: 0,
      totalGrams: 0,
    });
  });

  it("reads the group's own count, not spools.length", () => {
    // The search path rebuilds groups with a recomputed `count`; the summary
    // must follow that, which is the whole point of #1117(f).
    const searched: InventorySourceGroup = {
      locationId: "a",
      location: null,
      spools: [],
      count: 1,
      totalGrams: 420,
    };
    expect(summarizeInventoryGroups([searched])).toEqual({
      spoolCount: 1,
      locationCount: 1,
      totalGrams: 420,
    });
  });
});

describe("groupAndSortInventory — color grouping (color facet)", () => {
  const shelf = loc("L1", "Shelf");
  const dry = loc("L2", "Drybox");

  // Hexes chosen well inside their families so this suite pins the GROUPING,
  // not the classifier's thresholds (tests/colorFamily.test.ts owns those).
  const source: InventorySourceGroup<Row>[] = [
    {
      locationId: "L1",
      location: shelf,
      count: 4,
      totalGrams: 0,
      spools: [
        row("blue-pla", { filamentColor: "#1E63D6", filamentType: "PLA", totalWeight: 700 }),
        row("orange-petg", { filamentColor: "#FF7A00", filamentType: "PETG", totalWeight: 900 }),
        // No color at all → the "unknown" family, sorted last by COLOR_FAMILIES.
        row("nocolor", { filamentColor: null }),
        // Coextruded: null primary, colors in secondaryColors + OPT tag 28.
        row("coex", { filamentColor: null, secondaryColors: ["#000000", "#FFFFFF"], optTags: [28] }),
      ],
    },
    {
      locationId: "L2",
      location: dry,
      count: 3,
      totalGrams: 0,
      spools: [
        row("orange-pctg", { filamentColor: "#FF7A00", filamentType: "PCTG", totalWeight: 400 }),
        // Transparent tag over a white swatch → Clear.
        row("clear", { filamentColor: "#FFFFFF", optTags: [2] }),
        row("black", { filamentColor: "#111111" }),
      ],
    },
  ];

  it("orders sections by COLOR_FAMILIES, not alphabetically or by count", () => {
    const out = groupAndSortInventory(source, "color", "name", "asc");
    expect(out.map((g) => g.colorFamily)).toEqual(["black", "orange", "blue", "clear", "multi", "unknown"]);
    // Two orange spools vs one of everything else — count doesn't reorder.
    expect(out.find((g) => g.colorFamily === "orange")!.count).toBe(2);
  });

  it("keys sections with the color prefix and leaves label/location null", () => {
    const out = groupAndSortInventory(source, "color", "name", "asc");
    for (const g of out) {
      expect(g.key).toBe(`${INVENTORY_COLOR_KEY_PREFIX}${g.colorFamily}`);
      expect(g.label).toBeNull();
      expect(g.location).toBeNull();
      expect(g.locationId).toBeNull();
    }
  });

  it("puts each spool in exactly one section, regrouping across locations", () => {
    const out = groupAndSortInventory(source, "color", "name", "asc");
    const all = out.flatMap((g) => g.spools.map((r) => r.id)).sort();
    expect(all).toEqual(source.flatMap((g) => g.spools.map((r) => r.id)).sort());
    const orange = out.find((g) => g.colorFamily === "orange")!;
    // Recomputed total across both locations: (900-200) + (400-200).
    expect(orange.totalGrams).toBe(900);
  });

  it("applies the within-group sort inside each color section", () => {
    const asc = groupAndSortInventory(source, "color", "type", "asc");
    expect(asc.find((g) => g.colorFamily === "orange")!.spools.map((r) => r.id)).toEqual([
      "orange-pctg",
      "orange-petg",
    ]);
    const desc = groupAndSortInventory(source, "color", "remaining", "desc");
    expect(desc.find((g) => g.colorFamily === "orange")!.spools.map((r) => r.id)).toEqual([
      "orange-petg",
      "orange-pctg",
    ]);
  });

  it("leaves colorFamily null in every non-color mode", () => {
    for (const mode of ["location", "type", "vendor", "none"] as const) {
      for (const g of groupAndSortInventory(source, mode, "name", "asc")) {
        expect(g.colorFamily).toBeNull();
      }
    }
  });
});

describe("inventoryRowColorFamily (color facet adapter)", () => {
  it("maps row fields onto the classifier's filament shape", () => {
    expect(inventoryRowColorFamily(row("a", { filamentColor: "#1E63D6" }))).toBe("blue");
    // A color word in the NAME is read through filamentName.
    expect(
      inventoryRowColorFamily(row("b", { filamentName: "Galaxy Black", filamentColor: "#3A3A3A" })),
    ).toBe("black");
    // Coextruded null primary → multi via secondaryColors + optTags.
    expect(
      inventoryRowColorFamily(
        row("c", { filamentColor: null, secondaryColors: ["#000000", "#FFFFFF"], optTags: [28] }),
      ),
    ).toBe("multi");
    // Null primary with one secondary paints (and classifies as) that secondary.
    expect(inventoryRowColorFamily(row("d", { filamentColor: null, secondaryColors: ["#D32F2F"] }))).toBe(
      "red",
    );
    expect(inventoryRowColorFamily(row("e", { filamentColor: "#FFFFFF", optTags: [2] }))).toBe("clear");
  });

  it("classifies a legacy/stale-shape row with no color fields as unknown", () => {
    // Pre-#1050 payloads (and legacySingleSpool rows from an old cache) carry
    // none of the three fields.
    expect(inventoryRowColorFamily(row("legacy"))).toBe("unknown");
  });

  it("never treats a spool row as a template, even for a variant-bearing parent's own spools", () => {
    // hasVariants is forced false by the adapter — a spool row IS inventory.
    expect(inventoryRowColorFamily(row("parent", { filamentColor: "#FF7A00" }))).toBe("orange");
  });

  it("memoizes per row object without leaking across different objects", () => {
    const r = row("m", { filamentColor: "#1E63D6" });
    expect(inventoryRowColorFamily(r)).toBe("blue");
    expect(inventoryRowColorFamily(r)).toBe("blue");
    // A replaced row (the refetch pattern) is classified afresh.
    expect(inventoryRowColorFamily({ ...r, filamentColor: "#FF7A00" })).toBe("orange");
  });
});

describe("group-by color — validation + persistence (color facet)", () => {
  it("accepts 'color' as a group-by value", () => {
    expect(INVENTORY_GROUP_BYS).toContain("color");
  });

  it("round-trips ?group=color through the URL spec", () => {
    const parsed = parseFilterParams("?group=color", INVENTORY_FILTER_SPEC);
    expect(parsed.groupBy).toBe("color");
    const qs = serializeFilterParams("", INVENTORY_FILTER_SPEC, parsed);
    expect(new URLSearchParams(qs).get("group")).toBe("color");
    // An unknown value still falls back.
    expect(parseFilterParams("?group=colour", INVENTORY_FILTER_SPEC).groupBy).toBe(
      DEFAULT_INVENTORY_PREFS.groupBy,
    );
  });

  it("seeds a persisted 'color' preference when the URL is silent, URL wins otherwise", () => {
    const persisted = { ...DEFAULT_INVENTORY_PREFS, groupBy: "color" as const };
    expect(seedFilterState("", INVENTORY_FILTER_SPEC, persisted).groupBy).toBe("color");
    expect(seedFilterState("?group=type", INVENTORY_FILTER_SPEC, persisted).groupBy).toBe("type");
  });

  it("has a translated header for every color family in en and de", () => {
    const enMap = en as Record<string, string>;
    const deMap = de as Record<string, string>;
    expect(enMap["inventory.groupBy.color"]).toBeTruthy();
    expect(deMap["inventory.groupBy.color"]).toBeTruthy();
    for (const f of COLOR_FAMILIES) {
      expect(enMap[`colorFacet.family.${f}`], f).toBeTruthy();
      expect(deMap[`colorFacet.family.${f}`], f).toBeTruthy();
    }
  });
});

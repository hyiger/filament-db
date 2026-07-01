import { describe, it, expect } from "vitest";
import {
  groupAndSortInventory,
  inventoryRemainingGrams,
  INVENTORY_NO_GROUP_KEY,
  INVENTORY_ALL_KEY,
  type InventoryRow,
  type InventorySourceGroup,
} from "@/lib/inventorySort";

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
  return { _id: id, name, kind: "shelf", humidity: null, notes: "" };
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

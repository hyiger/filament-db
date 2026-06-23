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
});

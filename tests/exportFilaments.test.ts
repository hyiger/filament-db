import { describe, it, expect, beforeEach } from "vitest";
import { getExportRows, EXPORT_COLUMNS } from "@/lib/exportFilaments";

describe("EXPORT_COLUMNS", () => {
  it("defines all expected columns", () => {
    const keys = EXPORT_COLUMNS.map((c) => c.key);
    expect(keys).toContain("name");
    expect(keys).toContain("vendor");
    expect(keys).toContain("type");
    expect(keys).toContain("color");
    expect(keys).toContain("diameter");
    expect(keys).toContain("cost");
    expect(keys).toContain("density");
    expect(keys).toContain("nozzleTemp");
    expect(keys).toContain("bedTemp");
    expect(keys).toContain("spoolWeight");
    expect(keys).toContain("netFilamentWeight");
    expect(keys).toContain("spoolCount");
    expect(keys).toContain("tdsUrl");
  });

  it("has human-readable headers for all columns", () => {
    for (const col of EXPORT_COLUMNS) {
      expect(col.header).toBeTruthy();
      expect(col.header.length).toBeGreaterThan(0);
    }
  });
});

describe("getExportRows", () => {
  let Filament: typeof import("@/models/Filament").default;

  beforeEach(async () => {
    Filament = (await import("@/models/Filament")).default;
  });

  it("returns empty array when no filaments exist", async () => {
    const rows = await getExportRows();
    expect(rows).toEqual([]);
  });

  it("exports filament fields correctly", async () => {
    await Filament.create({
      name: "Test PLA",
      vendor: "TestVendor",
      type: "PLA",
      color: "#ff0000",
      cost: 25.99,
      density: 1.24,
      diameter: 1.75,
      temperatures: { nozzle: 210, nozzleFirstLayer: 215, bed: 60, bedFirstLayer: 65 },
      maxVolumetricSpeed: 15,
      spoolWeight: 230,
      netFilamentWeight: 1000,
      tdsUrl: "https://example.com/tds.pdf",
    });

    const rows = await getExportRows();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.name).toBe("Test PLA");
    expect(row.vendor).toBe("TestVendor");
    expect(row.type).toBe("PLA");
    expect(row.color).toBe("#ff0000");
    expect(row.cost).toBe(25.99);
    expect(row.density).toBe(1.24);
    expect(row.diameter).toBe(1.75);
    expect(row.nozzleTemp).toBe(210);
    expect(row.nozzleFirstLayerTemp).toBe(215);
    expect(row.bedTemp).toBe(60);
    expect(row.bedFirstLayerTemp).toBe(65);
    expect(row.maxVolumetricSpeed).toBe(15);
    expect(row.spoolWeight).toBe(230);
    expect(row.netFilamentWeight).toBe(1000);
    expect(row.tdsUrl).toBe("https://example.com/tds.pdf");
  });

  it("returns null for missing optional fields", async () => {
    await Filament.create({
      name: "Minimal",
      vendor: "V",
      type: "PLA",
    });

    const rows = await getExportRows();
    const row = rows[0];
    expect(row.cost).toBeNull();
    expect(row.density).toBeNull();
    expect(row.nozzleTemp).toBeNull();
    expect(row.bedTemp).toBeNull();
    expect(row.tdsUrl).toBeNull();
  });

  it("excludes soft-deleted filaments", async () => {
    await Filament.create({
      name: "Active",
      vendor: "V",
      type: "PLA",
    });
    await Filament.create({
      name: "Deleted",
      vendor: "V",
      type: "PLA",
      _deletedAt: new Date(),
    });

    const rows = await getExportRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Active");
  });

  it("resolves variant fields from parent", async () => {
    const parent = await Filament.create({
      name: "Parent PLA",
      vendor: "TestVendor",
      type: "PLA",
      color: "#ffffff",
      cost: 30,
      density: 1.24,
      temperatures: { nozzle: 210, bed: 60 },
    });

    await Filament.create({
      name: "Variant Red",
      vendor: "TestVendor",
      type: "PLA",
      color: "#ff0000",
      cost: null,
      density: null,
      temperatures: { nozzle: null, bed: null },
      parentId: parent._id,
    });

    const rows = await getExportRows();
    const variant = rows.find((r) => r.name === "Variant Red");
    expect(variant).toBeDefined();
    expect(variant!.color).toBe("#ff0000");
    // Inherited from parent (variant has null values)
    expect(variant!.cost).toBe(30);
    expect(variant!.density).toBe(1.24);
    expect(variant!.nozzleTemp).toBe(210);
    expect(variant!.bedTemp).toBe(60);
  });

  it("returns rows sorted by name", async () => {
    await Filament.create({ name: "Zebra", vendor: "V", type: "PLA" });
    await Filament.create({ name: "Alpha", vendor: "V", type: "PLA" });
    await Filament.create({ name: "Middle", vendor: "V", type: "PLA" });

    const rows = await getExportRows();
    expect(rows.map((r) => r.name)).toEqual(["Alpha", "Middle", "Zebra"]);
  });

  it("exports instanceId field", async () => {
    await Filament.create({
      name: "Instance Export",
      vendor: "V",
      type: "PLA",
      instanceId: "abc123def",
    });

    const rows = await getExportRows();
    const row = rows.find((r: Record<string, unknown>) => r.name === "Instance Export");
    expect(row!.instanceId).toBe("abc123def");
  });

  it("exports empty string for missing instanceId", async () => {
    // Use collection.insertOne to bypass pre-save hook
    const Filament2 = (await import("@/models/Filament")).default;
    await Filament2.collection.insertOne({
      name: "No Instance Export",
      vendor: "V",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      _deletedAt: null,
    });

    const rows = await getExportRows();
    const row = rows.find((r: Record<string, unknown>) => r.name === "No Instance Export");
    expect(row!.instanceId).toBe("");
  });

  it("counts spools correctly", async () => {
    await Filament.create({
      name: "Multi Spool",
      vendor: "V",
      type: "PLA",
      spools: [
        { label: "Spool 1", totalWeight: 1200 },
        { label: "Spool 2", totalWeight: 800 },
      ],
    });

    await Filament.create({
      name: "Legacy Spool",
      vendor: "V",
      type: "PLA",
      totalWeight: 1100,
    });

    await Filament.create({
      name: "No Spool",
      vendor: "V",
      type: "PLA",
    });

    const rows = await getExportRows();
    const multi = rows.find((r) => r.name === "Multi Spool");
    const legacy = rows.find((r) => r.name === "Legacy Spool");
    const none = rows.find((r) => r.name === "No Spool");

    expect(multi!.spoolCount).toBe(2);
    expect(legacy!.spoolCount).toBe(1);
    expect(none!.spoolCount).toBe(0);
  });
});

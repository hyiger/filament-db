import { describe, it, expect, beforeEach } from "vitest";
import { mapHeaders, rowToImport, upsertImportRows } from "@/lib/importFilaments";

describe("mapHeaders", () => {
  it("maps standard export headers", () => {
    const headers = ["Name", "Vendor", "Type", "Color", "Diameter (mm)", "Cost"];
    const result = mapHeaders(headers);
    expect(result).toEqual(["name", "vendor", "type", "color", "diameter", "cost"]);
  });

  it("maps case-insensitive variations", () => {
    const headers = ["name", "VENDOR", "Nozzle Temp", "Bed Temp", "TDS URL"];
    const result = mapHeaders(headers);
    expect(result).toEqual(["name", "vendor", "nozzleTemp", "bedTemp", "tdsUrl"]);
  });

  it("maps headers with units", () => {
    const headers = [
      "Density (g/cm³)",
      "Nozzle Temp (°C)",
      "Bed Temp (°C)",
      "Max Vol. Speed (mm³/s)",
      "Spool Weight (g)",
      "Net Filament Weight (g)",
    ];
    const result = mapHeaders(headers);
    expect(result).toEqual([
      "density",
      "nozzleTemp",
      "bedTemp",
      "maxVolumetricSpeed",
      "spoolWeight",
      "netFilamentWeight",
    ]);
  });

  it("returns null for unknown headers", () => {
    const headers = ["Name", "Unknown Column", "Vendor"];
    const result = mapHeaders(headers);
    expect(result).toEqual(["name", null, "vendor"]);
  });

  it("skips Spools column (computed, not importable)", () => {
    const headers = ["Name", "Spools", "Vendor"];
    const result = mapHeaders(headers);
    expect(result).toEqual(["name", null, "vendor"]);
  });

  it("handles headers with extra whitespace", () => {
    const headers = ["  Name  ", " Vendor ", "  Type  "];
    const result = mapHeaders(headers);
    expect(result).toEqual(["name", "vendor", "type"]);
  });
});

describe("rowToImport", () => {
  it("maps string and numeric values correctly", () => {
    const mapping = mapHeaders(["Name", "Vendor", "Type", "Cost", "Nozzle Temp"]);
    const values = ["PLA Basic", "Generic", "PLA", "25.99", "210"];
    const row = rowToImport(values, mapping);
    expect(row).toEqual({
      name: "PLA Basic",
      vendor: "Generic",
      type: "PLA",
      cost: 25.99,
      nozzleTemp: 210,
    });
  });

  it("returns null for empty numeric values", () => {
    const mapping = mapHeaders(["Name", "Cost", "Density"]);
    const values = ["Test Filament", "", ""];
    const row = rowToImport(values, mapping);
    expect(row.name).toBe("Test Filament");
    expect(row.cost).toBeNull();
    expect(row.density).toBeNull();
  });

  it("returns null for non-numeric values in numeric fields", () => {
    const mapping = mapHeaders(["Name", "Cost"]);
    const values = ["Test", "not-a-number"];
    const row = rowToImport(values, mapping);
    expect(row.cost).toBeNull();
  });

  it("handles null and undefined values", () => {
    const mapping = mapHeaders(["Name", "Color", "Cost"]);
    const values = ["Test", null, undefined];
    const row = rowToImport(values, mapping);
    expect(row.name).toBe("Test");
    expect(row.color).toBeNull();
    expect(row.cost).toBeNull();
  });

  it("skips unmapped columns", () => {
    const mapping = mapHeaders(["Name", "Unknown", "Vendor"]);
    const values = ["Test", "ignored", "TestVendor"];
    const row = rowToImport(values, mapping);
    expect(row.name).toBe("Test");
    expect(row.vendor).toBe("TestVendor");
    expect(Object.keys(row)).not.toContain("Unknown");
  });
});

describe("upsertImportRows", () => {
  // These tests use the in-memory MongoDB from setup.ts
  let Filament: typeof import("@/models/Filament").default;

  beforeEach(async () => {
    Filament = (await import("@/models/Filament")).default;
  });

  it("creates new filaments", async () => {
    const result = await upsertImportRows([
      { name: "Test PLA", vendor: "TestVendor", type: "PLA", color: "#ff0000" },
      { name: "Test PETG", vendor: "TestVendor", type: "PETG" },
    ]);

    expect(result.total).toBe(2);
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);

    const all = await Filament.find({ _deletedAt: null });
    expect(all).toHaveLength(2);
  });

  it("updates existing filaments by name", async () => {
    await Filament.create({
      name: "Test PLA",
      vendor: "OldVendor",
      type: "PLA",
    });

    const result = await upsertImportRows([
      { name: "Test PLA", vendor: "NewVendor", type: "PLA", cost: 29.99 },
    ]);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);

    const updated = await Filament.findOne({ name: "Test PLA" });
    expect(updated!.vendor).toBe("NewVendor");
    expect(updated!.cost).toBe(29.99);
  });

  it("resurrects soft-deleted filaments", async () => {
    await Filament.create({
      name: "Deleted PLA",
      vendor: "TestVendor",
      type: "PLA",
      _deletedAt: new Date(),
    });

    const result = await upsertImportRows([
      { name: "Deleted PLA", vendor: "TestVendor", type: "PLA" },
    ]);

    expect(result.updated).toBe(1);
    const resurrected = await Filament.findOne({ name: "Deleted PLA" });
    expect(resurrected!._deletedAt).toBeNull();
  });

  it("skips rows missing required fields and returns skip report", async () => {
    const result = await upsertImportRows([
      { name: "Has Name Only", vendor: "", type: "" },
      { name: "", vendor: "HasVendor", type: "PLA" },
      { vendor: "NoName", type: "PLA" },
    ]);

    expect(result.skipped).toBe(3);
    expect(result.created).toBe(0);
    expect(result.skippedRows).toHaveLength(3);

    // Row 2: vendor and type empty
    expect(result.skippedRows[0].row).toBe(2);
    expect(result.skippedRows[0].name).toBe("Has Name Only");
    expect(result.skippedRows[0].reason).toContain("vendor");
    expect(result.skippedRows[0].reason).toContain("type");

    // Row 3: name empty
    expect(result.skippedRows[1].row).toBe(3);
    expect(result.skippedRows[1].reason).toContain("name");

    // Row 4: name undefined
    expect(result.skippedRows[2].row).toBe(4);
    expect(result.skippedRows[2].reason).toContain("name");
  });

  it("applies default values for optional fields", async () => {
    await upsertImportRows([
      { name: "Defaults Test", vendor: "V", type: "PLA" },
    ]);

    const doc = await Filament.findOne({ name: "Defaults Test" });
    expect(doc!.color).toBe("#808080");
    expect(doc!.diameter).toBe(1.75);
    expect(doc!.cost).toBeNull();
    expect(doc!.temperatures.nozzle).toBeNull();
  });

  it("updates temperature fields using dot-notation without overwriting others", async () => {
    // Create with all temp fields
    await Filament.create({
      name: "Temp Update",
      vendor: "V",
      type: "PLA",
      temperatures: { nozzle: 200, nozzleFirstLayer: 205, bed: 55, bedFirstLayer: 60 },
    });

    // Update only nozzle temp - should NOT overwrite bed temps
    const result = await upsertImportRows([
      { name: "Temp Update", vendor: "V", type: "PLA", nozzleTemp: 210 },
    ]);

    expect(result.updated).toBe(1);
    const doc = await Filament.findOne({ name: "Temp Update" });
    expect(doc!.temperatures.nozzle).toBe(210);
    // These should remain unchanged
    expect(doc!.temperatures.bed).toBe(55);
    expect(doc!.temperatures.bedFirstLayer).toBe(60);
  });

  it("imports temperature fields correctly", async () => {
    await upsertImportRows([
      {
        name: "Temp Test",
        vendor: "V",
        type: "PLA",
        nozzleTemp: 210,
        nozzleFirstLayerTemp: 215,
        bedTemp: 60,
        bedFirstLayerTemp: 65,
      },
    ]);

    const doc = await Filament.findOne({ name: "Temp Test" });
    expect(doc!.temperatures.nozzle).toBe(210);
    expect(doc!.temperatures.nozzleFirstLayer).toBe(215);
    expect(doc!.temperatures.bed).toBe(60);
    expect(doc!.temperatures.bedFirstLayer).toBe(65);
  });
});

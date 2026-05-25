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

  it("maps the Parent column for round-trip variant import (GH #379)", () => {
    const headers = ["Name", "Vendor", "Type", "Parent", "Variant Count"];
    const result = mapHeaders(headers);
    // Parent → parentName, "Variant Count" is derived/read-only and skipped.
    expect(result).toEqual(["name", "vendor", "type", "parentName", null]);
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
  }, 15_000);

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

  it("does NOT reset color/diameter on existing filaments when those columns are absent (GH #183)", async () => {
    // Seed a filament with explicit non-default color + diameter.
    const seeded = await Filament.create({
      name: "Existing PETG",
      vendor: "Vendor",
      type: "PETG",
      color: "#123ABC",
      diameter: 2.85,
    });

    // Re-import with only the required columns — same name/vendor/type
    // but neither color nor diameter present in the row. Pre-fix the
    // importer would silently overwrite color → "#808080" and diameter
    // → 1.75 because they were always included with defaults.
    const result = await upsertImportRows([
      { name: "Existing PETG", vendor: "Vendor", type: "PETG" },
    ]);

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    const fresh = await Filament.findById(seeded._id);
    expect(fresh!.color).toBe("#123ABC");   // preserved
    expect(fresh!.diameter).toBe(2.85);     // preserved
  });

  it("still applies provided color/diameter on update (GH #183)", async () => {
    const seeded = await Filament.create({
      name: "Updatable PLA",
      vendor: "Vendor",
      type: "PLA",
      color: "#000000",
      diameter: 1.75,
    });

    const result = await upsertImportRows([
      { name: "Updatable PLA", vendor: "Vendor", type: "PLA", color: "#FF00FF", diameter: 2.85 },
    ]);

    expect(result.updated).toBe(1);
    const fresh = await Filament.findById(seeded._id);
    expect(fresh!.color).toBe("#FF00FF");
    expect(fresh!.diameter).toBe(2.85);
  });

  it("falls back to schema defaults for color/diameter when creating a new filament without them (GH #183)", async () => {
    // Create-path defaults still apply via the Mongoose schema even after
    // the fix removed the explicit defaults from the importer's `doc`.
    const result = await upsertImportRows([
      { name: "Defaults New PLA", vendor: "Vendor", type: "PLA" },
    ]);

    expect(result.created).toBe(1);
    const created = await Filament.findOne({ name: "Defaults New PLA" });
    expect(created!.color).toBe("#808080");  // schema default
    expect(created!.diameter).toBe(1.75);    // schema default
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

  it("imports nozzleRangeMin, nozzleRangeMax, and standby temps on create", async () => {
    await upsertImportRows([
      {
        name: "Range Temp Test",
        vendor: "V",
        type: "PLA",
        nozzleTemp: 210,
        nozzleRangeMin: 190,
        nozzleRangeMax: 230,
        standbyTemp: 150,
      },
    ]);

    const doc = await Filament.findOne({ name: "Range Temp Test" });
    expect(doc!.temperatures.nozzle).toBe(210);
    expect(doc!.temperatures.nozzleRangeMin).toBe(190);
    expect(doc!.temperatures.nozzleRangeMax).toBe(230);
    expect(doc!.temperatures.standby).toBe(150);
  });

  it("updates nozzleRangeMin/Max/standby via dot-notation without overwriting other temps", async () => {
    await Filament.create({
      name: "Range Update Test",
      vendor: "V",
      type: "PLA",
      temperatures: { nozzle: 200, bed: 55, nozzleRangeMin: 180, nozzleRangeMax: 220, standby: 140 },
    });

    // Update only nozzleRangeMin -- others should remain
    const result = await upsertImportRows([
      { name: "Range Update Test", vendor: "V", type: "PLA", nozzleRangeMin: 185 },
    ]);

    expect(result.updated).toBe(1);
    const doc = await Filament.findOne({ name: "Range Update Test" });
    expect(doc!.temperatures.nozzleRangeMin).toBe(185);
    expect(doc!.temperatures.nozzleRangeMax).toBe(220);
    expect(doc!.temperatures.standby).toBe(140);
    expect(doc!.temperatures.nozzle).toBe(200);
    expect(doc!.temperatures.bed).toBe(55);
  });
});

/**
 * GH #379: Parent-column round-trip on the filament importer.
 *
 * The filament CSV/XLSX export added a `Parent` column in #378 so the
 * variant relationship is visible. The re-import side now reads it so the
 * round-trip preserves the cluster (parent + its variants), instead of
 * flattening every row to a standalone filament.
 *
 * Rules under test:
 *   - CREATE path: parentName resolves against existing + in-batch active
 *     filaments. Missing / variant / self-referential Parent → skip with
 *     named reason.
 *   - UPDATE path: parentName is silently ignored (re-parenting via
 *     re-import is too lossy a UX).
 */
describe("upsertImportRows — Parent column (GH #379)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    Filament = (await import("@/models/Filament")).default;
  });

  it("creates a variant with the correct parentId when Parent references an existing active filament", async () => {
    const parent = await Filament.create({
      name: "Universal PLA",
      vendor: "Generic",
      type: "PLA",
    });

    const result = await upsertImportRows([
      {
        name: "Galaxy Black PLA",
        vendor: "Sunlu",
        type: "PLA",
        color: "#000000",
        parentName: "Universal PLA",
      },
    ]);

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    const variant = await Filament.findOne({ name: "Galaxy Black PLA" });
    expect(variant.parentId?.toString()).toBe(parent._id.toString());
  });

  it("creates a parent + variant in the same batch when the variant row comes BEFORE the parent row", async () => {
    // Real exports sort by name, so "Galaxy Black PLA" lands before
    // "Universal PLA" alphabetically — the two-pass driver must still
    // resolve the in-batch parent.
    const result = await upsertImportRows([
      {
        name: "Galaxy Black PLA",
        vendor: "Sunlu",
        type: "PLA",
        parentName: "Universal PLA",
      },
      {
        name: "Universal PLA",
        vendor: "Generic",
        type: "PLA",
      },
    ]);

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    const parent = await Filament.findOne({ name: "Universal PLA" });
    const variant = await Filament.findOne({ name: "Galaxy Black PLA" });
    expect(parent.parentId).toBeFalsy();
    expect(variant.parentId.toString()).toBe(parent._id.toString());
  });

  it("skips a row whose Parent does not exist among active filaments", async () => {
    const result = await upsertImportRows([
      {
        name: "Orphan Variant",
        vendor: "V",
        type: "PLA",
        parentName: "Does Not Exist",
      },
    ]);

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedRows[0].name).toBe("Orphan Variant");
    expect(result.skippedRows[0].reason).toContain("Does Not Exist");
    expect(result.skippedRows[0].reason).toContain("not found");
  });

  it("skips a row whose Parent is itself a variant (variants-of-variants forbidden)", async () => {
    const grandparent = await Filament.create({
      name: "Top PLA",
      vendor: "V",
      type: "PLA",
    });
    await Filament.create({
      name: "Middle PLA",
      vendor: "V",
      type: "PLA",
      parentId: grandparent._id,
    });

    const result = await upsertImportRows([
      {
        name: "Leaf PLA",
        vendor: "V",
        type: "PLA",
        parentName: "Middle PLA",
      },
    ]);

    expect(result.skipped).toBe(1);
    expect(result.skippedRows[0].reason).toContain("Middle PLA");
    expect(result.skippedRows[0].reason).toContain("itself a variant");

    const leaf = await Filament.findOne({ name: "Leaf PLA" });
    expect(leaf).toBeNull();
  });

  it("skips a row that references its own name as Parent", async () => {
    const result = await upsertImportRows([
      {
        name: "Self-Parent",
        vendor: "V",
        type: "PLA",
        parentName: "Self-Parent",
      },
    ]);

    expect(result.skipped).toBe(1);
    expect(result.skippedRows[0].reason).toContain("self");
  });

  it("ignores the Parent column when updating an existing active filament", async () => {
    // Active sibling that could appear to be the Parent — but updates
    // never re-parent, per the issue's design.
    const sibling = await Filament.create({
      name: "Existing Parent",
      vendor: "V",
      type: "PLA",
    });
    const target = await Filament.create({
      name: "Already Active",
      vendor: "V",
      type: "PLA",
    });
    expect(target.parentId).toBeFalsy();

    const result = await upsertImportRows([
      {
        name: "Already Active",
        vendor: "V",
        type: "PLA",
        cost: 19.99,
        parentName: "Existing Parent",
      },
    ]);

    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    const fresh = await Filament.findById(target._id);
    expect(fresh.cost).toBe(19.99);
    expect(fresh.parentId).toBeFalsy();
    // The sibling stays a top-level filament too.
    const stillSibling = await Filament.findById(sibling._id);
    expect(stillSibling.parentId).toBeFalsy();
  });

  it("round-trips a parent + its variants through a single import batch", async () => {
    // Simulates an export of (parent + 2 variants) being re-imported into
    // an empty DB. After the import, the cluster shape is preserved:
    // one root with two children.
    const result = await upsertImportRows([
      { name: "Galaxy Black PLA", vendor: "Sunlu", type: "PLA", parentName: "Universal PLA" },
      { name: "Universal PLA", vendor: "Generic", type: "PLA" },
      { name: "Galaxy Gold PLA", vendor: "Sunlu", type: "PLA", parentName: "Universal PLA" },
    ]);

    expect(result.created).toBe(3);
    expect(result.skipped).toBe(0);

    const parent = await Filament.findOne({ name: "Universal PLA" });
    expect(parent.parentId).toBeFalsy();
    const children = await Filament.find({ parentId: parent._id });
    expect(children).toHaveLength(2);
    const names = children.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["Galaxy Black PLA", "Galaxy Gold PLA"]);
  });

  it("routes a whitespace-only Parent cell to pass 1 so it can serve as an in-batch parent (Codex P2)", async () => {
    // Whitespace-only `Parent` is semantically empty (processRow trims
    // before resolving). Pre-fix the router compared raw `row.parentName`,
    // so a row with parentName="   " landed in pass 2 even though it had
    // no parent — and any earlier variant referencing it as Parent then
    // skipped with a misleading "not found" because pass 2's order of
    // operations meant the parent row wasn't processed yet.
    //
    // Ordering this test like the original failure: variant first, then
    // the whitespace-parent row. Both should now end up in their
    // semantically-correct passes (variant in pass 2, parent in pass 1).
    const result = await upsertImportRows([
      { name: "Variant", vendor: "V", type: "PLA", parentName: "Real Parent" },
      // Whitespace-only Parent column — semantically a standalone.
      { name: "Real Parent", vendor: "V", type: "PLA", parentName: "   " },
    ]);

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    const realParent = await Filament.findOne({ name: "Real Parent" });
    const variant = await Filament.findOne({ name: "Variant" });
    expect(realParent.parentId).toBeFalsy();
    expect(variant.parentId.toString()).toBe(realParent._id.toString());
  });

  it("treats a Variant Count cell as read-only — does not blow up or persist anything", async () => {
    // `rowToImport` would already filter the column out via mapHeaders, so
    // an ImportRow built normally never carries `variantCount`. This test
    // just guards the surface — a stray field on a hand-built row is
    // ignored, not crashing.
    const result = await upsertImportRows([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: "Plain Row", vendor: "V", type: "PLA", variantCount: 5 } as any,
    ]);

    expect(result.created).toBe(1);
    const doc = await Filament.findOne({ name: "Plain Row" });
    // No spurious `variantCount` field landed on the model.
    expect("variantCount" in (doc.toObject?.() ?? {})).toBe(false);
  });
});

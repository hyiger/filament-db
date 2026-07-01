import { describe, it, expect, beforeEach } from "vitest";
import { mapHeaders, rowToImport, splitInheritedImportSet, upsertImportRows } from "@/lib/importFilaments";

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

  // GH #649 (Codex P2): a parent + an existing variant in the same import,
  // where the parent's value changes. Pass 1 bumps the parent; pass 2 must
  // compare the variant's incoming (flattened-export) value against the
  // NEW parent value, not the stale one loaded before processing — else
  // the inherited value is written as a local override and the variant
  // stops tracking the parent (severing GH #106 inheritance).
  it("refreshes parent values between passes so a changed parent doesn't pin the variant (GH #649)", async () => {
    const parent = await Filament.create({
      name: "Galaxy", vendor: "Acme", type: "PLA", cost: 20,
    });
    const variant = await Filament.create({
      name: "Galaxy Black", vendor: "Acme", type: "PLA",
      parentId: parent._id, cost: null, // inherits the parent's cost
    });

    // Parent row bumps cost 20 → 30; the variant row's flattened cost (what
    // an export emits) equals the NEW parent value because it inherits.
    const result = await upsertImportRows([
      { name: "Galaxy", vendor: "Acme", type: "PLA", cost: 30 },
      { name: "Galaxy Black", vendor: "Acme", type: "PLA", parentName: "Galaxy", cost: 30 },
    ]);
    expect(result.updated).toBe(2);

    const p = await Filament.findById(parent._id);
    const v = await Filament.findById(variant._id);
    expect(p!.cost).toBe(30);
    // Variant kept inheriting — cost was NOT pinned as a local override.
    expect(v!.cost == null).toBe(true);
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

  // GH #503: a bad-hex `color` cell must land in skippedRows (not throw on the
  // bulk save() and lose the whole batch's accounting) — lines 586-593.
  it("skips a row with an invalid color hex and reports the reason, still importing the good rows", async () => {
    const result = await upsertImportRows([
      { name: "Bad Color Row", vendor: "V", type: "PLA", color: "red" },
      { name: "Bad Color Row 2", vendor: "V", type: "PLA", color: "#GGGGGG" },
      { name: "Good Color Row", vendor: "V", type: "PLA", color: "#00FF00" },
    ]);

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.skippedRows).toHaveLength(2);
    expect(result.skippedRows[0].name).toBe("Bad Color Row");
    expect(result.skippedRows[0].reason).toContain("Invalid color hex");
    expect(result.skippedRows[0].reason).toContain("red");
    expect(result.skippedRows[1].name).toBe("Bad Color Row 2");
    expect(result.skippedRows[1].reason).toContain("#GGGGGG");

    // The bad rows never persisted; the good one did.
    expect(await Filament.findOne({ name: "Bad Color Row" })).toBeNull();
    expect(await Filament.findOne({ name: "Bad Color Row 2" })).toBeNull();
    const good = await Filament.findOne({ name: "Good Color Row" });
    expect(good!.color).toBe("#00FF00");
  });

  // Branch 610: secondaryColors provided but EVERY entry is malformed → the
  // filtered slots array is empty → doc.secondaryColors is never set (the
  // schema default [] applies) and the null-primary block is not entered.
  it("omits secondaryColors and does not touch color when every provided entry is malformed (branch 610)", async () => {
    const result = await upsertImportRows([
      {
        name: "All Bad Secondaries",
        vendor: "V",
        type: "PLA",
        color: "#abcdef",
        secondaryColors: "red, #BAD, notahex",
      },
    ]);
    expect(result.created).toBe(1);
    const doc = await Filament.findOne({ name: "All Bad Secondaries" });
    expect(doc!.secondaryColors).toEqual([]);
    // color survives untouched — the null-primary override (line 620-622)
    // only fires when slots.length > 0.
    expect(doc!.color).toBe("#abcdef");
  });

  // Branch 458: two soft-deleted filaments share a name (allowed — the
  // partial-unique index only covers active rows). Only the FIRST is indexed
  // into deletedByName; the second hits the `!deletedByName.has(...)` false arm.
  it("indexes only the first of two same-named soft-deleted rows for resurrection (branch 458)", async () => {
    const first = await Filament.create({
      name: "Dupe Deleted",
      vendor: "V",
      type: "PLA",
      cost: 11,
      _deletedAt: new Date(),
    });
    await Filament.create({
      name: "Dupe Deleted",
      vendor: "V",
      type: "PETG",
      cost: 22,
      _deletedAt: new Date(),
    });

    const result = await upsertImportRows([
      { name: "Dupe Deleted", vendor: "NewVendor", type: "PLA", cost: 33 },
    ]);

    // Resurrection updates exactly one row (the first-indexed soft-deleted one),
    // not a create.
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    const resurrected = await Filament.findById(first._id);
    expect(resurrected!._deletedAt).toBeNull();
    expect(resurrected!.vendor).toBe("NewVendor");
    expect(resurrected!.cost).toBe(33);
  });

  // Line 770 / branch 760: a non-duplicate-key error (a schema ValidationError
  // from `runValidators` on the update path) routes into skippedRows via the
  // `err instanceof Error ? err.message` fallback, not the 11000 branch.
  it("routes a validation error on update into skippedRows with the error message (line 770)", async () => {
    await Filament.create({ name: "Validate Me", vendor: "V", type: "PLA", cost: 10 });

    const result = await upsertImportRows([
      // Negative cost trips the schema `min: 0` validator under runValidators
      // on the update path → a ValidationError (not an E11000).
      { name: "Validate Me", vendor: "V", type: "PLA", cost: -50 },
    ]);

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedRows).toHaveLength(1);
    expect(result.skippedRows[0].name).toBe("Validate Me");
    // The message is the raw validator text, not the "Duplicate …" shape.
    expect(result.skippedRows[0].reason).not.toMatch(/^Duplicate /);
    expect(result.skippedRows[0].reason.toLowerCase()).toContain("cost");

    // The bad update did not persist.
    const doc = await Filament.findOne({ name: "Validate Me" });
    expect(doc!.cost).toBe(10);
  });

  // Scalar `?? null` branches: a column present-but-null must write an
  // explicit null (the right arm of `row.cost ?? null` on line 631, and
  // `row.nozzleTemp ?? null` on line 655), distinct from a present value.
  it("writes explicit nulls for present-but-null scalar/temp columns (branches 631 & 655)", async () => {
    await Filament.create({
      name: "Nullify Fields",
      vendor: "V",
      type: "PLA",
      cost: 10,
      temperatures: { nozzle: 200 },
    });
    // Existing row → update path. cost + nozzleTemp present as null → the
    // `?? null` right arm fires and writes null through.
    const result = await upsertImportRows([
      { name: "Nullify Fields", vendor: "V", type: "PLA", cost: null, nozzleTemp: null },
    ]);
    expect(result.updated).toBe(1);
    const doc = await Filament.findOne({ name: "Nullify Fields" });
    expect(doc!.cost).toBeNull();
    expect(doc!.temperatures.nozzle).toBeNull();
  });

  // Create-path temps object (branch 703): a row that supplies SOME temp
  // subfields but not others exercises both the value side and the `?? null`
  // fallback within the nested temperatures object.
  it("fills unsupplied create-path temp subfields with null while keeping supplied ones (branch 703)", async () => {
    await upsertImportRows([
      {
        name: "Partial Temps Create",
        vendor: "V",
        type: "PLA",
        // Only bed supplied → nozzle et al. fall through `?? null`.
        bedTemp: 60,
      },
    ]);
    const doc = await Filament.findOne({ name: "Partial Temps Create" });
    expect(doc!.temperatures.bed).toBe(60);
    expect(doc!.temperatures.nozzle).toBeNull();
    expect(doc!.temperatures.nozzleFirstLayer).toBeNull();
    expect(doc!.temperatures.bedFirstLayer).toBeNull();
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

  describe("secondaryColors (#477)", () => {
    it("parses comma-separated string into the schema array", async () => {
      const result = await upsertImportRows([
        {
          name: "Multi Import",
          vendor: "Test",
          type: "PLA",
          color: "#ffffff",
          secondaryColors: "#FF0000,#00FF00,#0000FF",
        },
      ]);
      expect(result.created).toBe(1);
      const doc = await Filament.findOne({ name: "Multi Import" });
      expect(doc?.secondaryColors).toEqual(["#FF0000", "#00FF00", "#0000FF"]);
    });

    it("trims whitespace and drops malformed hex entries", async () => {
      const result = await upsertImportRows([
        {
          name: "Sloppy Hex",
          vendor: "Test",
          type: "PLA",
          color: "#ffffff",
          // Mixed: valid + extra whitespace + malformed + named color
          // (which the schema would reject) + empty entries.
          secondaryColors: " #FF0000 , red , #BAD , , #00FF00 ",
        },
      ]);
      expect(result.created).toBe(1);
      const doc = await Filament.findOne({ name: "Sloppy Hex" });
      // Only the two valid 6-char hex entries survive; "red", "#BAD"
      // (3-char), and the empties are dropped before reaching the
      // schema validator.
      expect(doc?.secondaryColors).toEqual(["#FF0000", "#00FF00"]);
    });

    it("caps at 5 entries on import (spec ceiling)", async () => {
      const result = await upsertImportRows([
        {
          name: "Too Many Colors",
          vendor: "Test",
          type: "PLA",
          secondaryColors:
            "#FF0000,#FF8800,#FFFF00,#00FF00,#0000FF,#8800FF",
        },
      ]);
      expect(result.created).toBe(1);
      const doc = await Filament.findOne({ name: "Too Many Colors" });
      expect(doc?.secondaryColors).toHaveLength(5);
      // 6th entry (#8800FF) dropped silently — there's no spec key for it.
      expect(doc?.secondaryColors).toEqual([
        "#FF0000", "#FF8800", "#FFFF00", "#00FF00", "#0000FF",
      ]);
    });

    it("omits the field when the column is empty / missing", async () => {
      const result = await upsertImportRows([
        { name: "Plain Row 477", vendor: "Test", type: "PLA", secondaryColors: "" },
        { name: "Plain Row 477b", vendor: "Test", type: "PLA" },
      ]);
      expect(result.created).toBe(2);
      const docs = await Filament.find({
        name: { $in: ["Plain Row 477", "Plain Row 477b"] },
      });
      // Schema default is []. Either way, no entries.
      expect(docs[0].secondaryColors).toEqual([]);
      expect(docs[1].secondaryColors).toEqual([]);
    });

    it("preserves null primary on coextruded CSV round-trip (Codex P2 r2)", async () => {
      // Coextruded filaments have `color: null` per OpenPrintTag spec.
      // Export writes an empty Color cell; pre-fix import would skip
      // setting `doc.color` so the schema default "#808080" applied,
      // re-introducing a phantom gray primary. Now: secondaryColors
      // present + color empty → doc.color = null explicitly.
      await Filament.create({
        name: "Coextruded Round-Trip",
        vendor: "Test",
        type: "PLA",
        color: null,
        secondaryColors: ["#FF0000", "#00FF00", "#0000FF"],
      });
      const { getExportRows } = await import("@/lib/exportFilaments");
      const exportRows = await getExportRows();
      const row = exportRows.find((r) => r.name === "Coextruded Round-Trip")!;
      expect(row.color).toBeNull();
      await Filament.deleteOne({ name: "Coextruded Round-Trip" });
      const result = await upsertImportRows([
        {
          name: row.name,
          vendor: row.vendor,
          type: row.type,
          // `row.color === null` simulating the empty Color cell on
          // re-import.
          color: row.color ?? undefined,
          secondaryColors: row.secondaryColors,
        },
      ]);
      expect(result.created).toBe(1);
      const reimported = await Filament.findOne({ name: "Coextruded Round-Trip" });
      expect(reimported?.color).toBeNull();
      expect(reimported?.secondaryColors).toEqual([
        "#FF0000", "#00FF00", "#0000FF",
      ]);
    });

    it("round-trips via export → import without drift", async () => {
      await Filament.create({
        name: "Round Trip",
        vendor: "Test",
        type: "PLA",
        color: "#ffffff",
        secondaryColors: ["#FF0000", "#00FF00", "#0000FF"],
      });
      const { getExportRows } = await import("@/lib/exportFilaments");
      const exportRows = await getExportRows();
      const row = exportRows.find((r) => r.name === "Round Trip")!;
      // Drop the original then re-import the export row as a new
      // filament — the unique-name index requires removing first.
      await Filament.deleteOne({ name: "Round Trip" });
      const result = await upsertImportRows([
        {
          name: row.name,
          vendor: row.vendor,
          type: row.type,
          color: row.color ?? undefined,
          secondaryColors: row.secondaryColors,
        },
      ]);
      expect(result.created).toBe(1);
      const reimported = await Filament.findOne({ name: "Round Trip" });
      expect(reimported?.secondaryColors).toEqual([
        "#FF0000", "#00FF00", "#0000FF",
      ]);
    });
  });
});

/**
 * GH #627 item 3: the export side prefixes formula-leading cells with `'`
 * (csvCell / sanitizeFormulaPrefix); the importer must strip that prefix
 * from free-text string fields so an exported `'+95A TPU` re-imports as
 * `+95A TPU` and matches the existing row instead of creating a corrupted
 * duplicate.
 */
describe("rowToImport — formula-prefix strip (GH #627)", () => {
  it("strips the guard apostrophe from name/vendor/type/colorName/spoolType/parentName", () => {
    const mapping = mapHeaders([
      "Name", "Vendor", "Type", "Color Name", "Spool Type", "Parent",
    ]);
    const row = rowToImport(
      ["'+95A TPU", "'@home Filaments", "'+PLA", "'=Galaxy", "'-cardboard", "'+95A Base"],
      mapping,
    );
    expect(row.name).toBe("+95A TPU");
    expect(row.vendor).toBe("@home Filaments");
    // GH #649: `type` is a required free-text field the exporter prefixes —
    // without unsanitizing it, `+PLA` would re-import as `'+PLA`.
    expect(row.type).toBe("+PLA");
    expect(row.colorName).toBe("=Galaxy");
    expect(row.spoolType).toBe("-cardboard");
    expect(row.parentName).toBe("+95A Base");
  });

  it("leaves genuine leading apostrophes alone when the next char is benign", () => {
    const mapping = mapHeaders(["Name", "Vendor", "Type"]);
    const row = rowToImport(["'70s Blue PLA", "Vendor", "PLA"], mapping);
    expect(row.name).toBe("'70s Blue PLA");
  });

  it("strips the guard apostrophe from instanceId (not strictly hex) (#679)", () => {
    // A legacy/custom instanceId starting with a trigger char gets
    // formula-prefixed on export; without unsanitizing it round-trips
    // corrupted as `'-custom-id-123`.
    const mapping = mapHeaders(["Name", "Vendor", "Type", "Instance ID"]);
    const row = rowToImport(["PLA", "Acme", "PLA", "'-custom-id-123"], mapping);
    expect(row.instanceId).toBe("-custom-id-123");
  });
});

/**
 * GH #628 — pure-helper coverage for the variant-update inheritance split.
 * Semantics follow `setIfNotInherited` in src/lib/bambuStudioApply.ts
 * (GH #403 / #473): incoming == parent → skip (keep inheriting); stale
 * diverging local override → $unset; incoming != parent → $set.
 */
describe("splitInheritedImportSet (GH #628)", () => {
  const parent = {
    vendor: "Acme",
    type: "PLA",
    cost: 25,
    density: 1.24,
    spoolType: "cardboard",
    temperatures: { nozzle: 215, bed: 60 },
    secondaryColors: ["#FF0000", "#00FF00"],
  };

  it("skips $set for scalar fields whose incoming value matches the parent", () => {
    const variant = { cost: null, density: null };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", cost: 25, density: 1.24 },
      variant,
      parent,
    );
    expect(set).toEqual({ name: "V" });
    expect(unset).toEqual([]);
  });

  it("$sets a genuine variant override that differs from the parent", () => {
    const variant = { cost: null };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", cost: 30 },
      variant,
      parent,
    );
    expect(set).toEqual({ name: "V", cost: 30 });
    expect(unset).toEqual([]);
  });

  it("$unsets a stale local override the import reconciled back to the parent value", () => {
    // variant pinned cost=30, parent says 25, import says 25 → the
    // variant returns to inheriting.
    const variant = { cost: 30 };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", cost: 25 },
      variant,
      parent,
    );
    expect(set).toEqual({ name: "V" });
    expect(unset).toEqual(["cost"]);
  });

  it("never $unsets schema-required fields (vendor/type), and writes them through when stale (GH #649)", () => {
    // Required fields can't be unset (validation) and never inherit at read
    // time — resolveFilament always uses the variant's own value. So when
    // the incoming (new parent) value differs from the variant's stale
    // stored value, it must be $set, not skipped (Codex P2 on #649: a
    // parent+variant import where the parent's vendor/type changed used to
    // leave the variant showing the old value).
    const variant = { vendor: "OldVendor", type: "PETG" };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", vendor: "Acme", type: "PLA" },
      variant,
      parent,
    );
    expect(set).toEqual({ name: "V", vendor: "Acme", type: "PLA" });
    expect(unset).toEqual([]);
  });

  it("does not re-write a required field that already matches (GH #649)", () => {
    // incoming == parent == variant's own value → nothing to do, no $set.
    const variant = { vendor: "Acme", type: "PLA" };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", vendor: "Acme", type: "PLA" },
      variant,
      parent,
    );
    expect(set).toEqual({ name: "V" });
    expect(unset).toEqual([]);
  });

  it("handles temperatures.* dot-keys per subfield", () => {
    const variant = { temperatures: { nozzle: 230, bed: null } };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", "temperatures.nozzle": 215, "temperatures.bed": 60 },
      variant,
      parent,
    );
    // nozzle: incoming matches parent, variant diverged at 230 → unset.
    // bed: incoming matches parent, variant has no local value → skip.
    expect(set).toEqual({ name: "V" });
    expect(unset).toEqual(["temperatures.nozzle"]);
  });

  it("treats an empty-string local value as 'already inheriting' (resolveFilament rule)", () => {
    const variant = { spoolType: "" };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", spoolType: "cardboard" },
      variant,
      parent,
    );
    expect(set).toEqual({ name: "V" });
    expect(unset).toEqual([]);
  });

  it("skips secondaryColors when the incoming array equals the parent's (whole-array inheritance)", () => {
    const variant = { secondaryColors: [] };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", secondaryColors: ["#FF0000", "#00FF00"] },
      variant,
      parent,
    );
    expect(set).toEqual({ name: "V" });
    expect(unset).toEqual([]);
  });

  it("$sets secondaryColors when the incoming array differs from the parent's", () => {
    const variant = { secondaryColors: [] };
    const { set } = splitInheritedImportSet(
      { name: "V", secondaryColors: ["#0000FF"] },
      variant,
      parent,
    );
    expect(set.secondaryColors).toEqual(["#0000FF"]);
  });

  it("passes variant-only fields (color, colorName, instanceId) straight through", () => {
    const variant = {};
    const { set } = splitInheritedImportSet(
      { name: "V", color: "#FF0000", colorName: "Red", instanceId: "abc123" },
      variant,
      parent,
    );
    expect(set).toEqual({
      name: "V",
      color: "#FF0000",
      colorName: "Red",
      instanceId: "abc123",
    });
  });

  it("passes incoming nulls through (null on a variant means 'inherit' anyway)", () => {
    const variant = { cost: 30 };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", cost: null },
      variant,
      parent,
    );
    expect(set).toEqual({ name: "V", cost: null });
    expect(unset).toEqual([]);
  });

  it("$unsets a stale diverging secondaryColors override when the import reconciles it back to the parent (line 353/354)", () => {
    // Variant carries its OWN non-empty secondaryColors that differ from the
    // parent's; the import row matches the parent's array (a flattened-export
    // re-import). The whole-array inheritance rule → drop the local override
    // so the variant resumes inheriting.
    const variant = { secondaryColors: ["#111111", "#222222"] };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", secondaryColors: ["#FF0000", "#00FF00"] },
      variant,
      parent,
    );
    expect(set).toEqual({ name: "V" });
    expect(unset).toEqual(["secondaryColors"]);
  });

  it("does NOT $unset secondaryColors when the variant's local array already equals the incoming/parent array", () => {
    // variantArr equals incoming → nothing stale to reconcile → skip $set, no $unset.
    const variant = { secondaryColors: ["#FF0000", "#00FF00"] };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", secondaryColors: ["#FF0000", "#00FF00"] },
      variant,
      parent,
    );
    expect(set).toEqual({ name: "V" });
    expect(unset).toEqual([]);
  });

  it("treats a non-array parent.secondaryColors as [] so a non-empty incoming array is a genuine override (branch 344)", () => {
    // parent.secondaryColors is undefined → coerced to []; incoming is
    // non-empty and can't equal [] → $set through.
    const parentNoArr = { ...parent, secondaryColors: undefined };
    const { set, unset } = splitInheritedImportSet(
      { name: "V", secondaryColors: ["#0000FF"] },
      { secondaryColors: [] },
      parentNoArr,
    );
    expect(set.secondaryColors).toEqual(["#0000FF"]);
    expect(unset).toEqual([]);
  });

  it("treats a non-array variant.secondaryColors as [] (branch 347) — matches parent → skip, no unset", () => {
    // variant.secondaryColors is undefined → coerced to []; incoming equals
    // the parent's array → skip $set. variantArr is empty so no $unset.
    const { set, unset } = splitInheritedImportSet(
      { name: "V", secondaryColors: ["#FF0000", "#00FF00"] },
      { secondaryColors: undefined },
      parent,
    );
    expect(set).toEqual({ name: "V" });
    expect(unset).toEqual([]);
  });
});

/**
 * GH #627 item 2: a row whose write throws (the realistic trigger: the
 * create path carries an exported Instance ID that collides with the
 * partial-unique instanceId index after the user renamed the filament)
 * must land in skippedRows instead of aborting the whole batch.
 */
describe("upsertImportRows — per-row error isolation (GH #627)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    Filament = (await import("@/models/Filament")).default;
    await Filament.syncIndexes();
  });

  it("routes a duplicate-key create into skippedRows with a named reason and keeps processing", async () => {
    await Filament.create({
      name: "Original Name PLA",
      vendor: "Acme",
      type: "PLA",
      instanceId: "aabbccdd11",
    });

    const result = await upsertImportRows([
      // Renamed-filament re-import: the name misses, the carried
      // Instance ID collides → E11000 on create.
      { name: "Renamed PLA", vendor: "Acme", type: "PLA", instanceId: "aabbccdd11" },
      // A healthy row after the failing one must still import.
      { name: "Healthy PETG", vendor: "Acme", type: "PETG" },
    ]);

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedRows).toHaveLength(1);
    expect(result.skippedRows[0].name).toBe("Renamed PLA");
    expect(result.skippedRows[0].reason).toMatch(/Duplicate instanceId/);
    expect(result.skippedRows[0].reason).toMatch(/aabbccdd11/);

    expect(await Filament.findOne({ name: "Healthy PETG" })).toBeTruthy();
    expect(await Filament.findOne({ name: "Renamed PLA" })).toBeNull();
  });
});

/**
 * GH #628 — end-to-end round-trip: export flattens a variant through
 * resolveFilament, re-importing the flattened row onto the EXISTING
 * variant must NOT pin the inherited values as local overrides. The
 * variant keeps tracking parent edits after the round-trip.
 */
describe("upsertImportRows — variant round-trip preserves inheritance (GH #628)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    Filament = (await import("@/models/Filament")).default;
  });

  /** Re-import the current export rows the way the XLSX route does:
   *  header mapping + rowToImport over raw values. */
  async function reimportCurrentExport() {
    const { getExportRows, EXPORT_COLUMNS } = await import("@/lib/exportFilaments");
    const exportRows = await getExportRows();
    const mapping = mapHeaders(EXPORT_COLUMNS.map((c) => c.header));
    return upsertImportRows(
      exportRows.map((r) => rowToImport(EXPORT_COLUMNS.map((c) => r[c.key]), mapping)),
    );
  }

  it("does not pin inherited values onto the variant on re-import", async () => {
    const parent = await Filament.create({
      name: "Universal PLA",
      vendor: "Acme",
      type: "PLA",
      cost: 25,
      density: 1.24,
      dryingTemperature: 55,
      temperatures: { nozzle: 215, bed: 60 },
    });
    await Filament.create({
      name: "Universal PLA — Red",
      vendor: "Acme",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
      // cost/density/dryingTemperature/temps left unset → inherited live
    });

    const result = await reimportCurrentExport();
    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(0);

    const variant = await Filament.findOne({ name: "Universal PLA — Red" }).lean();
    // The export wrote the parent-resolved values (25 / 1.24 / 215 …);
    // the import must have skipped $set-ing them back onto the variant.
    expect(variant.cost).toBeNull();
    expect(variant.density).toBeNull();
    expect(variant.dryingTemperature).toBeNull();
    expect(variant.temperatures?.nozzle ?? null).toBeNull();
    expect(variant.temperatures?.bed ?? null).toBeNull();

    // …and parent edits still propagate (the GH #106 live link survives).
    await Filament.updateOne({ _id: parent._id }, { $set: { cost: 30 } });
    const { resolveFilament } = await import("@/lib/resolveFilament");
    const freshParent = await Filament.findById(parent._id).lean();
    const resolved = resolveFilament(variant, freshParent);
    expect(resolved.cost).toBe(30);
  });

  it("keeps a genuine variant override that differs from the parent", async () => {
    const parent = await Filament.create({
      name: "Universal PETG",
      vendor: "Acme",
      type: "PETG",
      cost: 20,
      temperatures: { nozzle: 240 },
    });
    await Filament.create({
      name: "Universal PETG — Black",
      vendor: "Acme",
      type: "PETG",
      color: "#000000",
      parentId: parent._id,
      temperatures: { nozzle: 250 }, // real local override
    });

    await reimportCurrentExport();

    const variant = await Filament.findOne({ name: "Universal PETG — Black" }).lean();
    expect(variant.temperatures.nozzle).toBe(250); // override survives
    expect(variant.cost).toBeNull(); // inherited stays inherited
  });

  it("clears a stale override the import reconciled back to the parent value", async () => {
    const parent = await Filament.create({
      name: "Universal ASA",
      vendor: "Acme",
      type: "ASA",
      cost: 35,
    });
    const variant = await Filament.create({
      name: "Universal ASA — White",
      vendor: "Acme",
      type: "ASA",
      color: "#FFFFFF",
      parentId: parent._id,
      cost: 40, // stale divergence
    });

    // Import the flattened row with cost equal to the PARENT value —
    // the user reconciled the divergence in the spreadsheet.
    const mapping = mapHeaders(["Name", "Vendor", "Type", "Cost", "Parent"]);
    const result = await upsertImportRows([
      rowToImport(["Universal ASA — White", "Acme", "ASA", 35, "Universal ASA"], mapping),
    ]);
    expect(result.updated).toBe(1);

    const updated = await Filament.findById(variant._id).lean();
    // $unset → the field is gone/null and inheritance resumes.
    expect(updated.cost == null).toBe(true);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

describe("Filament Model", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    // Clear cached model and re-import to get coverage on the actual file
    delete mongoose.models.Filament;
    const schemas = (mongoose as unknown as Record<string, Record<string, unknown>>).modelSchemas;
    if (schemas) delete schemas.Filament;
    // Dynamic import to re-evaluate the module
    const mod = await import("@/models/Filament");
    Filament = mod.default;
    await Filament.syncIndexes();
  });

  it("creates a filament with required fields", async () => {
    const filament = await Filament.create({
      name: "Test PLA",
      vendor: "TestBrand",
      type: "PLA",
    });

    expect(filament.name).toBe("Test PLA");
    expect(filament.vendor).toBe("TestBrand");
    expect(filament.type).toBe("PLA");
    expect(filament._id).toBeDefined();
  });

  it("applies default values", async () => {
    const filament = await Filament.create({
      name: "Defaults Test",
      vendor: "Test",
      type: "PLA",
    });

    expect(filament.color).toBe("#808080");
    expect(filament.diameter).toBe(1.75);
    expect(filament.cost).toBeNull();
    expect(filament.density).toBeNull();
    expect(filament.maxVolumetricSpeed).toBeNull();
    expect(filament.inherits).toBeNull();
    expect(filament.compatibleNozzles).toEqual([]);
    expect(filament.calibrations).toEqual([]);
  });

  it("fails without required name", async () => {
    await expect(
      Filament.create({ vendor: "Test", type: "PLA" })
    ).rejects.toThrow();
  });

  it("fails without required vendor", async () => {
    await expect(
      Filament.create({ name: "NoVendor", type: "PLA" })
    ).rejects.toThrow();
  });

  it("fails without required type", async () => {
    await expect(
      Filament.create({ name: "NoType", vendor: "Test" })
    ).rejects.toThrow();
  });

  it("enforces unique name", async () => {
    await Filament.create({ name: "Unique", vendor: "A", type: "PLA" });
    await expect(
      Filament.create({ name: "Unique", vendor: "B", type: "PETG" })
    ).rejects.toThrow();
  });

  it("stores temperature values", async () => {
    const filament = await Filament.create({
      name: "Temp Test",
      vendor: "Test",
      type: "PLA",
      temperatures: {
        nozzle: 210,
        nozzleFirstLayer: 215,
        bed: 60,
        bedFirstLayer: 65,
      },
    });

    expect(filament.temperatures.nozzle).toBe(210);
    expect(filament.temperatures.nozzleFirstLayer).toBe(215);
    expect(filament.temperatures.bed).toBe(60);
    expect(filament.temperatures.bedFirstLayer).toBe(65);
  });

  it("stores calibrations with nozzle reference", async () => {
    const nozzleId = new mongoose.Types.ObjectId();
    const filament = await Filament.create({
      name: "Calibration Test",
      vendor: "Test",
      type: "PLA",
      calibrations: [
        {
          nozzle: nozzleId,
          extrusionMultiplier: 0.96,
          maxVolumetricSpeed: 10,
          pressureAdvance: 0.053,
          retractLength: 0.8,
          retractSpeed: 40,
          retractLift: 0.15,
        },
      ],
    });

    expect(filament.calibrations).toHaveLength(1);
    expect(filament.calibrations[0].nozzle.toString()).toBe(nozzleId.toString());
    expect(filament.calibrations[0].extrusionMultiplier).toBe(0.96);
    expect(filament.calibrations[0].maxVolumetricSpeed).toBe(10);
    expect(filament.calibrations[0].pressureAdvance).toBe(0.053);
  });

  it("stores settings as mixed type", async () => {
    const filament = await Filament.create({
      name: "Settings Test",
      vendor: "Test",
      type: "PLA",
      settings: { custom_key: "value", nil_key: null },
    });

    const found = await Filament.findById(filament._id).lean();
    expect(found!.settings).toMatchObject({
      custom_key: "value",
      nil_key: null,
    });
  });

  it("stores compatibleNozzles as ObjectId array", async () => {
    const id1 = new mongoose.Types.ObjectId();
    const filament = await Filament.create({
      name: "Nozzle Ref",
      vendor: "Test",
      type: "PLA",
      compatibleNozzles: [id1],
    });

    expect(filament.compatibleNozzles).toHaveLength(1);
    expect(filament.compatibleNozzles[0].toString()).toBe(id1.toString());
  });

  it("includes timestamps", async () => {
    const filament = await Filament.create({
      name: "Timestamp Test",
      vendor: "Test",
      type: "PLA",
    });

    expect(filament.createdAt).toBeDefined();
    expect(filament.updatedAt).toBeDefined();
  });

  it("creates a filament with spools", async () => {
    const filament = await Filament.create({
      name: "Spool Test",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
      spools: [
        { label: "Printer 1", totalWeight: 800 },
        { label: "Backup", totalWeight: 1150 },
      ],
    });

    expect(filament.spools).toHaveLength(2);
    expect(filament.spools[0].label).toBe("Printer 1");
    expect(filament.spools[0].totalWeight).toBe(800);
    expect(filament.spools[0]._id).toBeDefined();
    expect(filament.spools[0].createdAt).toBeDefined();
    expect(filament.spools[1].label).toBe("Backup");
    expect(filament.spools[1].totalWeight).toBe(1150);
  });

  it("defaults spools to empty array", async () => {
    const filament = await Filament.create({
      name: "No Spools",
      vendor: "Test",
      type: "PLA",
    });

    expect(filament.spools).toEqual([]);
  });

  it("adds a spool via push and save", async () => {
    const filament = await Filament.create({
      name: "Push Spool",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 200,
      netFilamentWeight: 1000,
    });

    filament.spools.push({ label: "", totalWeight: 950 });
    await filament.save();

    const found = await Filament.findById(filament._id);
    expect(found!.spools).toHaveLength(1);
    expect(found!.spools[0].totalWeight).toBe(950);
    expect(found!.spools[0].label).toBe("");
  });

  it("removes a spool via pull", async () => {
    const filament = await Filament.create({
      name: "Remove Spool",
      vendor: "Test",
      type: "PLA",
      spools: [
        { label: "A", totalWeight: 500 },
        { label: "B", totalWeight: 600 },
      ],
    });

    const spoolId = filament.spools[0]._id;
    await Filament.findByIdAndUpdate(filament._id, {
      $pull: { spools: { _id: spoolId } },
    });

    const found = await Filament.findById(filament._id);
    expect(found!.spools).toHaveLength(1);
    expect(found!.spools[0].label).toBe("B");
  });

  it("updates a spool weight via positional operator", async () => {
    const filament = await Filament.create({
      name: "Update Spool",
      vendor: "Test",
      type: "PLA",
      spools: [{ label: "Main", totalWeight: 900 }],
    });

    const spoolId = filament.spools[0]._id;
    await Filament.findOneAndUpdate(
      { _id: filament._id, "spools._id": spoolId },
      { $set: { "spools.$.totalWeight": 750 } },
    );

    const found = await Filament.findById(filament._id);
    expect(found!.spools[0].totalWeight).toBe(750);
  });

  it("stores spool weight fields", async () => {
    const filament = await Filament.create({
      name: "Weight Fields",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 190,
      netFilamentWeight: 1000,
      totalWeight: 850,
    });

    expect(filament.spoolWeight).toBe(190);
    expect(filament.netFilamentWeight).toBe(1000);
    expect(filament.totalWeight).toBe(850);
  });

  it("soft-deletes by setting _deletedAt", async () => {
    const filament = await Filament.create({
      name: "SoftDel Test",
      vendor: "Test",
      type: "PLA",
    });

    await Filament.findByIdAndUpdate(filament._id, { _deletedAt: new Date() });

    // Should be excluded by _deletedAt: null filter
    const found = await Filament.findOne({ _id: filament._id, _deletedAt: null });
    expect(found).toBeNull();

    // But still exists in the database
    const raw = await Filament.findById(filament._id);
    expect(raw).not.toBeNull();
    expect(raw!._deletedAt).toBeInstanceOf(Date);
  });

  it("_deletedAt defaults to null", async () => {
    const filament = await Filament.create({
      name: "DeletedAt Default",
      vendor: "Test",
      type: "PLA",
    });

    expect(filament._deletedAt).toBeNull();

    // Findable with _deletedAt: null filter
    const found = await Filament.findOne({ _id: filament._id, _deletedAt: null });
    expect(found).not.toBeNull();
  });

  it("auto-generates instanceId on save via pre-save hook", async () => {
    const filament = await Filament.create({
      name: "InstanceId Test",
      vendor: "Test",
      type: "PLA",
    });
    expect(filament.instanceId).toBeDefined();
    expect(typeof filament.instanceId).toBe("string");
    expect(filament.instanceId.length).toBeGreaterThan(0);
  });

  it("regenerates instanceId via pre-save hook when cleared", async () => {
    const filament = await Filament.create({
      name: "Regen InstanceId",
      vendor: "Test",
      type: "PLA",
    });
    const originalId = filament.instanceId;
    expect(originalId).toBeDefined();

    // Clear instanceId and save — hook should regenerate it
    filament.instanceId = "";
    await filament.save();
    expect(filament.instanceId).toBeDefined();
    expect(filament.instanceId.length).toBeGreaterThan(0);
    expect(filament.instanceId).not.toBe(originalId);
  });

  it("does not overwrite existing instanceId on save", async () => {
    const filament = await Filament.create({
      name: "Keep InstanceId",
      vendor: "Test",
      type: "PLA",
      instanceId: "custom-id-123",
    });
    expect(filament.instanceId).toBe("custom-id-123");

    filament.vendor = "Updated";
    await filament.save();
    expect(filament.instanceId).toBe("custom-id-123");
  });

  it("supports parentId for variant relationships", async () => {
    const parent = await Filament.create({
      name: "Parent PLA",
      vendor: "Test",
      type: "PLA",
    });

    const variant = await Filament.create({
      name: "Variant PLA - Red",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
    });

    expect(variant.parentId.toString()).toBe(parent._id.toString());
  });

  it("can query variants by parentId", async () => {
    const parent = await Filament.create({
      name: "Parent PETG",
      vendor: "Test",
      type: "PETG",
    });

    await Filament.create({
      name: "Variant PETG - Blue",
      vendor: "Test",
      type: "PETG",
      parentId: parent._id,
    });
    await Filament.create({
      name: "Variant PETG - Green",
      vendor: "Test",
      type: "PETG",
      parentId: parent._id,
    });

    const variants = await Filament.find({ parentId: parent._id, _deletedAt: null });
    expect(variants).toHaveLength(2);
  });

  it("countDocuments returns variant count for a parent", async () => {
    const parent = await Filament.create({
      name: "Parent ASA",
      vendor: "Test",
      type: "ASA",
    });

    await Filament.create({
      name: "Variant ASA - Black",
      vendor: "Test",
      type: "ASA",
      parentId: parent._id,
    });

    const variantCount = await Filament.countDocuments({ parentId: parent._id, _deletedAt: null });
    expect(variantCount).toBe(1);

    // Soft-delete the variant
    await Filament.findOneAndUpdate(
      { name: "Variant ASA - Black" },
      { _deletedAt: new Date() },
    );

    const activeCount = await Filament.countDocuments({ parentId: parent._id, _deletedAt: null });
    expect(activeCount).toBe(0);
  });
});

describe("Spool remaining weight calculation", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    delete mongoose.models.Filament;
    const schemas = (mongoose as unknown as Record<string, Record<string, unknown>>).modelSchemas;
    if (schemas) delete schemas.Filament;
    const mod = await import("@/models/Filament");
    Filament = mod.default;
    await Filament.syncIndexes();
  });

  it("computes remaining weight as totalWeight minus spoolWeight", async () => {
    const filament = await Filament.create({
      name: "Remaining Weight PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 190,
      spools: [{ label: "Spool A", totalWeight: 850 }],
    });

    const spool = filament.spools[0];
    const remainingWeight = spool.totalWeight - filament.spoolWeight;
    expect(remainingWeight).toBe(660);
  });

  it("clamps remaining weight to zero when totalWeight is less than spoolWeight", async () => {
    const filament = await Filament.create({
      name: "Low Weight PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 190,
      spools: [{ label: "Nearly empty", totalWeight: 100 }],
    });

    const spool = filament.spools[0];
    const remainingWeight = Math.max(0, spool.totalWeight - filament.spoolWeight);
    expect(remainingWeight).toBe(0);
    // Without clamping, the value would be negative
    expect(spool.totalWeight - filament.spoolWeight).toBe(-90);
  });

  it("cannot compute remaining weight when spoolWeight is null", async () => {
    const filament = await Filament.create({
      name: "Null SpoolWeight PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: null,
      spools: [{ label: "Spool B", totalWeight: 850 }],
    });

    expect(filament.spoolWeight).toBeNull();
    const spool = filament.spools[0];
    const canCompute = filament.spoolWeight != null && spool.totalWeight != null;
    expect(canCompute).toBe(false);
  });

  it("cannot compute remaining weight when spool totalWeight is null", async () => {
    const filament = await Filament.create({
      name: "Null TotalWeight PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 190,
      spools: [{ label: "Spool C", totalWeight: null }],
    });

    const spool = filament.spools[0];
    expect(spool.totalWeight).toBeNull();
    const canCompute = filament.spoolWeight != null && spool.totalWeight != null;
    expect(canCompute).toBe(false);
  });

  it("stores and retrieves multiple spools for a single filament", async () => {
    const filament = await Filament.create({
      name: "Multi-Spool PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 190,
      spools: [
        { label: "Printer A", totalWeight: 850 },
        { label: "Printer B", totalWeight: 600 },
      ],
    });

    expect(filament.spools).toHaveLength(2);

    const found = await Filament.findById(filament._id);
    expect(found!.spools).toHaveLength(2);
    expect(found!.spools[0].label).toBe("Printer A");
    expect(found!.spools[0].totalWeight).toBe(850);
    expect(found!.spools[1].label).toBe("Printer B");
    expect(found!.spools[1].totalWeight).toBe(600);

    // Verify remaining weight for each spool
    const remaining0 = found!.spools[0].totalWeight - found!.spoolWeight;
    const remaining1 = found!.spools[1].totalWeight - found!.spoolWeight;
    expect(remaining0).toBe(660);
    expect(remaining1).toBe(410);
  });

  it("computes remaining filament length from weight, density, and diameter", async () => {
    const filament = await Filament.create({
      name: "Length Calc PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 190,
      density: 1.24, // g/cm^3 — typical PLA
      diameter: 1.75, // mm
      spools: [{ label: "Main", totalWeight: 850 }],
    });

    const spool = filament.spools[0];
    const remainingWeightG = spool.totalWeight - filament.spoolWeight; // 660g
    expect(remainingWeightG).toBe(660);

    // Volume in cm^3 = weight / density
    const volumeCm3 = remainingWeightG / filament.density;

    // Cross-section area in cm^2: pi * (diameter/2)^2, diameter in cm
    const radiusCm = (filament.diameter / 10) / 2; // 1.75mm -> 0.175cm -> r=0.0875cm
    const crossSectionCm2 = Math.PI * radiusCm * radiusCm;

    // Length in cm = volume / cross-section area
    const lengthCm = volumeCm3 / crossSectionCm2;

    // Convert to meters
    const lengthM = lengthCm / 100;

    // ~221m for 660g of PLA at 1.24 g/cm^3 and 1.75mm diameter
    expect(lengthM).toBeGreaterThan(200);
    expect(lengthM).toBeLessThan(250);
    expect(Math.round(lengthM)).toBe(221);
  });
});

describe("Calibration sub-document updates", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    delete mongoose.models.Filament;
    const schemas = (mongoose as unknown as Record<string, Record<string, unknown>>).modelSchemas;
    if (schemas) delete schemas.Filament;
    const mod = await import("@/models/Filament");
    Filament = mod.default;
    await Filament.syncIndexes();
  });

  it("updates a calibration entry via Object.assign on a cloned array", async () => {
    const nozzleId = new mongoose.Types.ObjectId();
    const filament = await Filament.create({
      name: "Calibration Update Test",
      vendor: "Test",
      type: "PLA",
      calibrations: [
        {
          nozzle: nozzleId,
          extrusionMultiplier: 1.049,
          maxVolumetricSpeed: 12,
          pressureAdvance: 0.04,
          retractLength: 0.8,
          retractSpeed: 40,
          retractLift: 0.15,
        },
      ],
    });

    expect(filament.calibrations[0].extrusionMultiplier).toBe(1.049);

    // Clone the calibrations array (as the API route does)
    const updatedCals = filament.calibrations.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => (c.toObject ? c.toObject() : { ...c })
    );

    // Find the matching entry and Object.assign new values
    const match = updatedCals.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => c.nozzle.toString() === nozzleId.toString()
    );
    expect(match).toBeDefined();
    Object.assign(match, { extrusionMultiplier: 1.05 });

    // Save the filament with the updated calibrations
    filament.calibrations = updatedCals;
    await filament.save();

    // Re-fetch and verify
    const found = await Filament.findById(filament._id);
    expect(found!.calibrations).toHaveLength(1);
    expect(found!.calibrations[0].extrusionMultiplier).toBe(1.05);
    // Other fields should remain unchanged
    expect(found!.calibrations[0].maxVolumetricSpeed).toBe(12);
    expect(found!.calibrations[0].pressureAdvance).toBe(0.04);
    expect(found!.calibrations[0].retractLength).toBe(0.8);
  });

  it("preserves other calibration entries when updating one", async () => {
    const nozzleA = new mongoose.Types.ObjectId();
    const nozzleB = new mongoose.Types.ObjectId();
    const filament = await Filament.create({
      name: "Multi-Cal Update",
      vendor: "Test",
      type: "PLA",
      calibrations: [
        { nozzle: nozzleA, extrusionMultiplier: 0.95 },
        { nozzle: nozzleB, extrusionMultiplier: 1.0 },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updatedCals = filament.calibrations.map((c: any) =>
      c.toObject ? c.toObject() : { ...c }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matchA = updatedCals.find((c: any) => c.nozzle.toString() === nozzleA.toString());
    Object.assign(matchA, { extrusionMultiplier: 0.97 });

    filament.calibrations = updatedCals;
    await filament.save();

    const found = await Filament.findById(filament._id);
    expect(found!.calibrations).toHaveLength(2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calA = found!.calibrations.find((c: any) => c.nozzle.toString() === nozzleA.toString());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calB = found!.calibrations.find((c: any) => c.nozzle.toString() === nozzleB.toString());
    expect(calA!.extrusionMultiplier).toBe(0.97);
    expect(calB!.extrusionMultiplier).toBe(1.0);
  });
});

describe("backfillInstanceIds", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  let backfillInstanceIds: typeof import("@/models/Filament").backfillInstanceIds;

  beforeEach(async () => {
    delete mongoose.models.Filament;
    const schemas = (mongoose as unknown as Record<string, Record<string, unknown>>).modelSchemas;
    if (schemas) delete schemas.Filament;
    const mod = await import("@/models/Filament");
    Filament = mod.default;
    backfillInstanceIds = mod.backfillInstanceIds;
    await Filament.syncIndexes();
  });

  it("backfills instanceId for filaments missing it", async () => {
    // Insert directly to bypass pre-save hook
    await Filament.collection.insertOne({
      name: "No Instance",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
    });

    const count = await backfillInstanceIds();
    expect(count).toBe(1);

    const doc = await Filament.findOne({ name: "No Instance" });
    expect(doc!.instanceId).toBeDefined();
    expect(doc!.instanceId.length).toBeGreaterThan(0);
  });

  it("returns 0 when all filaments have instanceId", async () => {
    await Filament.create({ name: "Has ID", vendor: "Test", type: "PLA" });
    const count = await backfillInstanceIds();
    expect(count).toBe(0);
  });
});

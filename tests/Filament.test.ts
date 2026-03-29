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
});

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

describe("Filament Model", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    // Clear cached model and re-import to get coverage on the actual file
    delete mongoose.models.Filament;
    delete (mongoose as unknown as Record<string, unknown>).modelSchemas?.Filament;
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
});

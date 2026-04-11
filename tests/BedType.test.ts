import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

describe("BedType Model", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BedType: any;

  beforeEach(async () => {
    delete mongoose.models.BedType;
    const mod = await import("@/models/BedType");
    BedType = mod.default;
    await BedType.syncIndexes();
  });

  it("creates a bed type with required fields", async () => {
    const bedType = await BedType.create({
      name: "Smooth PEI",
      material: "PEI",
    });

    expect(bedType.name).toBe("Smooth PEI");
    expect(bedType.material).toBe("PEI");
    expect(bedType._id).toBeDefined();
  });

  it("applies default values", async () => {
    const bedType = await BedType.create({
      name: "Defaults",
      material: "PEI",
    });

    expect(bedType.notes).toBe("");
    expect(bedType._deletedAt).toBeNull();
  });

  it("fails without required name", async () => {
    await expect(
      BedType.create({ material: "PEI" })
    ).rejects.toThrow();
  });

  it("fails without required material", async () => {
    await expect(
      BedType.create({ name: "Test" })
    ).rejects.toThrow();
  });

  it("enforces unique name among non-deleted", async () => {
    await BedType.create({ name: "Unique", material: "PEI" });
    await expect(
      BedType.create({ name: "Unique", material: "Glass" })
    ).rejects.toThrow();
  });

  it("allows duplicate name when original is soft-deleted", async () => {
    const original = await BedType.create({ name: "Reusable", material: "PEI" });
    await BedType.findByIdAndUpdate(original._id, { _deletedAt: new Date() });

    const reused = await BedType.create({ name: "Reusable", material: "G10/FR4" });
    expect(reused.name).toBe("Reusable");
  });

  it("stores notes", async () => {
    const bedType = await BedType.create({
      name: "With Notes",
      material: "Glass",
      notes: "Requires glue stick",
    });

    expect(bedType.notes).toBe("Requires glue stick");
  });

  it("includes timestamps", async () => {
    const bedType = await BedType.create({
      name: "Timestamp",
      material: "PEI",
    });

    expect(bedType.createdAt).toBeDefined();
    expect(bedType.updatedAt).toBeDefined();
  });

  it("soft-deletes by setting _deletedAt", async () => {
    const bedType = await BedType.create({ name: "ToDelete", material: "PEI" });
    await BedType.findByIdAndUpdate(bedType._id, { _deletedAt: new Date() });

    const found = await BedType.findOne({ name: "ToDelete", _deletedAt: null });
    expect(found).toBeNull();

    const deleted = await BedType.findById(bedType._id);
    expect(deleted._deletedAt).not.toBeNull();
  });

  it("filters by material", async () => {
    await BedType.create({ name: "PEI Smooth", material: "PEI" });
    await BedType.create({ name: "PEI Textured", material: "Textured PEI" });
    await BedType.create({ name: "Glass Plate", material: "Glass" });

    const peiResults = await BedType.find({ material: "PEI", _deletedAt: null });
    expect(peiResults).toHaveLength(1);
    expect(peiResults[0].name).toBe("PEI Smooth");
  });
});

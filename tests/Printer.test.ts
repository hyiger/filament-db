import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

describe("Printer Model", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;

  beforeEach(async () => {
    // Clear cached model and re-import to get coverage on the actual file
    delete mongoose.models.Printer;
    const schemas = (mongoose as unknown as Record<string, Record<string, unknown>>).modelSchemas;
    if (schemas) delete schemas.Printer;
    // Dynamic import to re-evaluate the module
    const mod = await import("@/models/Printer");
    Printer = mod.default;
    await Printer.syncIndexes();
  });

  it("creates a printer with required fields", async () => {
    const printer = await Printer.create({
      name: "Test Printer",
      manufacturer: "Prusa",
      printerModel: "MK4S",
    });

    expect(printer.name).toBe("Test Printer");
    expect(printer.manufacturer).toBe("Prusa");
    expect(printer.printerModel).toBe("MK4S");
    expect(printer._id).toBeDefined();
  });

  it("applies default values", async () => {
    const printer = await Printer.create({
      name: "Defaults Test",
      manufacturer: "Bambu",
      printerModel: "X1C",
    });

    expect(printer.notes).toBe("");
    expect(printer._deletedAt).toBeNull();
    expect(printer.installedNozzles).toEqual([]);
  });

  it("fails without required name", async () => {
    await expect(
      Printer.create({ manufacturer: "Prusa", printerModel: "MK4S" })
    ).rejects.toThrow();
  });

  it("fails without required manufacturer", async () => {
    await expect(
      Printer.create({ name: "No Mfg", printerModel: "MK4S" })
    ).rejects.toThrow();
  });

  it("fails without required printerModel", async () => {
    await expect(
      Printer.create({ name: "No Model", manufacturer: "Prusa" })
    ).rejects.toThrow();
  });

  it("enforces unique name among non-deleted", async () => {
    await Printer.create({
      name: "Unique Printer",
      manufacturer: "A",
      printerModel: "X",
    });
    await expect(
      Printer.create({
        name: "Unique Printer",
        manufacturer: "B",
        printerModel: "Y",
      })
    ).rejects.toThrow();
  });

  it("allows duplicate names when one is soft-deleted", async () => {
    const first = await Printer.create({
      name: "Dup Name",
      manufacturer: "A",
      printerModel: "X",
    });

    await Printer.findByIdAndUpdate(first._id, { _deletedAt: new Date() });

    const second = await Printer.create({
      name: "Dup Name",
      manufacturer: "B",
      printerModel: "Y",
    });

    expect(second.name).toBe("Dup Name");
  });

  it("enforces syncId unique sparse constraint", async () => {
    await Printer.create({
      name: "Sync1",
      manufacturer: "A",
      printerModel: "X",
      syncId: "abc-123",
    });
    await expect(
      Printer.create({
        name: "Sync2",
        manufacturer: "B",
        printerModel: "Y",
        syncId: "abc-123",
      })
    ).rejects.toThrow();
  });

  it("allows multiple printers with null syncId", async () => {
    const p1 = await Printer.create({
      name: "NoSync1",
      manufacturer: "A",
      printerModel: "X",
    });
    const p2 = await Printer.create({
      name: "NoSync2",
      manufacturer: "B",
      printerModel: "Y",
    });

    expect(p1.syncId).toBeUndefined();
    expect(p2.syncId).toBeUndefined();
  });

  it("stores installedNozzles as ObjectId array", async () => {
    const id1 = new mongoose.Types.ObjectId();
    const id2 = new mongoose.Types.ObjectId();
    const printer = await Printer.create({
      name: "Nozzle Test",
      manufacturer: "Prusa",
      printerModel: "MK4S",
      installedNozzles: [id1, id2],
    });

    expect(printer.installedNozzles).toHaveLength(2);
    expect(printer.installedNozzles[0].toString()).toBe(id1.toString());
    expect(printer.installedNozzles[1].toString()).toBe(id2.toString());
  });

  it("includes timestamps", async () => {
    const printer = await Printer.create({
      name: "Timestamp Test",
      manufacturer: "Prusa",
      printerModel: "MK4S",
    });

    expect(printer.createdAt).toBeDefined();
    expect(printer.updatedAt).toBeDefined();
  });

  it("soft-deletes by setting _deletedAt", async () => {
    const printer = await Printer.create({
      name: "SoftDel Test",
      manufacturer: "Prusa",
      printerModel: "MK4S",
    });

    await Printer.findByIdAndUpdate(printer._id, { _deletedAt: new Date() });

    // Should be excluded by _deletedAt: null filter
    const found = await Printer.findOne({ _id: printer._id, _deletedAt: null });
    expect(found).toBeNull();

    // But still exists in the database
    const raw = await Printer.findById(printer._id);
    expect(raw).not.toBeNull();
    expect(raw!._deletedAt).toBeInstanceOf(Date);
  });
});

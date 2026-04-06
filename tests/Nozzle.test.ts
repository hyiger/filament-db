import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

describe("Nozzle Model", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Nozzle: any;

  beforeEach(async () => {
    delete mongoose.models.Nozzle;
    const mod = await import("@/models/Nozzle");
    Nozzle = mod.default;
    await Nozzle.syncIndexes();
  });

  it("creates a nozzle with required fields", async () => {
    const nozzle = await Nozzle.create({
      name: "0.4mm Brass",
      diameter: 0.4,
      type: "Brass",
    });

    expect(nozzle.name).toBe("0.4mm Brass");
    expect(nozzle.diameter).toBe(0.4);
    expect(nozzle.type).toBe("Brass");
    expect(nozzle._id).toBeDefined();
  });

  it("applies default values", async () => {
    const nozzle = await Nozzle.create({
      name: "Defaults",
      diameter: 0.4,
      type: "Brass",
    });

    expect(nozzle.highFlow).toBe(false);
    expect(nozzle.hardened).toBe(false);
    expect(nozzle.notes).toBe("");
  });

  it("fails without required name", async () => {
    await expect(
      Nozzle.create({ diameter: 0.4, type: "Brass" })
    ).rejects.toThrow();
  });

  it("fails without required diameter", async () => {
    await expect(
      Nozzle.create({ name: "Test", type: "Brass" })
    ).rejects.toThrow();
  });

  it("fails without required type", async () => {
    await expect(
      Nozzle.create({ name: "Test", diameter: 0.4 })
    ).rejects.toThrow();
  });

  it("enforces unique name", async () => {
    await Nozzle.create({ name: "Unique", diameter: 0.4, type: "Brass" });
    await expect(
      Nozzle.create({ name: "Unique", diameter: 0.6, type: "Steel" })
    ).rejects.toThrow();
  });

  it("stores highFlow and hardened booleans", async () => {
    const nozzle = await Nozzle.create({
      name: "HF Hardened",
      diameter: 0.4,
      type: "Hardened Steel",
      highFlow: true,
      hardened: true,
    });

    expect(nozzle.highFlow).toBe(true);
    expect(nozzle.hardened).toBe(true);
  });

  it("stores notes", async () => {
    const nozzle = await Nozzle.create({
      name: "With Notes",
      diameter: 0.6,
      type: "Brass",
      notes: "Good for flexible filaments",
    });

    expect(nozzle.notes).toBe("Good for flexible filaments");
  });

  it("includes timestamps", async () => {
    const nozzle = await Nozzle.create({
      name: "Timestamp",
      diameter: 0.4,
      type: "Brass",
    });

    expect(nozzle.createdAt).toBeDefined();
    expect(nozzle.updatedAt).toBeDefined();
  });
});

describe("Nozzle calibration matching by diameter and highFlow", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Nozzle: any;

  beforeEach(async () => {
    delete mongoose.models.Nozzle;
    const mod = await import("@/models/Nozzle");
    Nozzle = mod.default;
    await Nozzle.syncIndexes();
  });

  it("finds standard nozzle when querying diameter=0.4 and highFlow=false", async () => {
    await Nozzle.create({
      name: "0.4mm Standard",
      diameter: 0.4,
      type: "Brass",
      highFlow: false,
    });
    await Nozzle.create({
      name: "0.4mm HF",
      diameter: 0.4,
      type: "Brass",
      highFlow: true,
    });

    const standard = await Nozzle.findOne({ diameter: 0.4, highFlow: false, _deletedAt: null });
    expect(standard).not.toBeNull();
    expect(standard!.name).toBe("0.4mm Standard");
    expect(standard!.highFlow).toBe(false);
  });

  it("finds high-flow nozzle when querying diameter=0.4 and highFlow=true", async () => {
    await Nozzle.create({
      name: "0.4mm Std",
      diameter: 0.4,
      type: "Brass",
      highFlow: false,
    });
    await Nozzle.create({
      name: "0.4mm High Flow",
      diameter: 0.4,
      type: "Brass",
      highFlow: true,
    });

    const hf = await Nozzle.findOne({ diameter: 0.4, highFlow: true, _deletedAt: null });
    expect(hf).not.toBeNull();
    expect(hf!.name).toBe("0.4mm High Flow");
    expect(hf!.highFlow).toBe(true);
  });

  it("finds a nozzle when querying by diameter only without highFlow filter", async () => {
    await Nozzle.create({
      name: "0.4mm Only Standard",
      diameter: 0.4,
      type: "Brass",
      highFlow: false,
    });
    await Nozzle.create({
      name: "0.4mm Only HF",
      diameter: 0.4,
      type: "Brass",
      highFlow: true,
    });

    const result = await Nozzle.findOne({ diameter: 0.4, _deletedAt: null });
    expect(result).not.toBeNull();
    expect(result!.diameter).toBe(0.4);
    // Should find one of them (we don't care which without the highFlow filter)
    expect(["0.4mm Only Standard", "0.4mm Only HF"]).toContain(result!.name);
  });

  it("returns null when no nozzle matches the diameter", async () => {
    await Nozzle.create({
      name: "0.4mm Brass Only",
      diameter: 0.4,
      type: "Brass",
      highFlow: false,
    });

    const result = await Nozzle.findOne({ diameter: 0.6, _deletedAt: null });
    expect(result).toBeNull();
  });

  it("excludes soft-deleted nozzles from calibration matching", async () => {
    const nozzle = await Nozzle.create({
      name: "Deleted Nozzle",
      diameter: 0.4,
      type: "Brass",
      highFlow: false,
    });

    await Nozzle.findByIdAndUpdate(nozzle._id, { _deletedAt: new Date() });

    const result = await Nozzle.findOne({ diameter: 0.4, highFlow: false, _deletedAt: null });
    expect(result).toBeNull();
  });
});

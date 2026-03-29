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

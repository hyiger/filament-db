import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

describe("Location Model", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Location: any;

  beforeEach(async () => {
    delete mongoose.models.Location;
    Location = (await import("@/models/Location")).default;
    await Location.syncIndexes();
  });

  it("creates a location with required fields", async () => {
    const loc = await Location.create({ name: "Drybox #1" });
    expect(loc.name).toBe("Drybox #1");
    expect(loc.kind).toBe("shelf");
    expect(loc.humidity).toBeNull();
    expect(loc.notes).toBe("");
    expect(loc._deletedAt).toBeNull();
  });

  it("accepts custom kind and humidity", async () => {
    const loc = await Location.create({
      name: "Active Drybox",
      kind: "drybox",
      humidity: 18,
    });
    expect(loc.kind).toBe("drybox");
    expect(loc.humidity).toBe(18);
  });

  it("rejects humidity outside 0–100", async () => {
    await expect(
      Location.create({ name: "Invalid", humidity: 150 }),
    ).rejects.toThrow();
    await expect(
      Location.create({ name: "Invalid2", humidity: -1 }),
    ).rejects.toThrow();
  });

  it("fails without required name", async () => {
    await expect(Location.create({})).rejects.toThrow();
  });

  it("enforces unique names among non-deleted documents", async () => {
    await Location.create({ name: "Drybox #1" });
    await expect(Location.create({ name: "Drybox #1" })).rejects.toThrow();
  });

  it("allows re-using a name of a soft-deleted location", async () => {
    const first = await Location.create({ name: "Drybox #1" });
    first._deletedAt = new Date();
    await first.save();
    const second = await Location.create({ name: "Drybox #1" });
    expect(second._id.toString()).not.toBe(first._id.toString());
  });
});

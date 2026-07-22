import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  clearLegacyNozzleConditionsOnce,
  LEGACY_NOZZLE_CONDITION_RE,
  type MinimalDb,
} from "@/lib/legacyNozzleConditions";

/**
 * GH #1021 (#1022) — the one-shot, per-DB, claim-first cleanup
 * of machine-derived nozzle compatibility conditions. Exercised directly
 * against the shared in-memory MongoDB (tests/setup.ts) plus thin wrappers to
 * reach the failure branches.
 */
describe("clearLegacyNozzleConditionsOnce", () => {
  const db = () => mongoose.connection.db! as unknown as MinimalDb;
  const rawDb = () => mongoose.connection.db!;

  beforeEach(async () => {
    await rawDb().collection("_migrations").deleteMany({});
    await rawDb().collection("filaments").deleteMany({ name: /^LNC / });
  });

  async function seed(name: string, condition?: string) {
    await rawDb()
      .collection("filaments")
      .insertOne({
        name: `LNC ${name}`,
        vendor: "T",
        type: "PLA",
        settings: condition === undefined ? { cooling: "1" } : { compatible_printers_condition: condition, cooling: "1" },
      });
  }
  const conditionOf = async (name: string) =>
    (await rawDb().collection("filaments").findOne({ name: `LNC ${name}` }))!.settings
      .compatible_printers_condition;

  it("clears exact machine grammar, leaves human expressions + sibling keys, and completes the marker", async () => {
    await seed("machine-single", "nozzle_diameter[0]==0.4");
    await seed("machine-multi", "nozzle_diameter[0]==0.25 or nozzle_diameter[0]==0.6");
    await seed("human-compound", "printer_model==MK4 and nozzle_diameter[0]==0.4");
    await seed("human-comparison", "nozzle_diameter[0]>=0.4");
    await seed("no-condition");

    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: true, cleared: 2 });

    expect(await conditionOf("machine-single")).toBe("");
    expect(await conditionOf("machine-multi")).toBe("");
    expect(await conditionOf("human-compound")).toBe("printer_model==MK4 and nozzle_diameter[0]==0.4");
    expect(await conditionOf("human-comparison")).toBe("nozzle_diameter[0]>=0.4");
    expect(await conditionOf("no-condition")).toBeUndefined();
    const doc = await rawDb().collection("filaments").findOne({ name: "LNC machine-single" });
    expect(doc!.settings.cooling).toBe("1"); // sibling key untouched

    const marker = await rawDb().collection("_migrations").findOne({ _id: "legacyNozzleConditions" as never });
    expect(marker).not.toBeNull();
    expect(marker!.completed).toBe(true);
  });

  it("THE #1022 P1 scenario: a machine-grammar pin authored AFTER completion survives every later run", async () => {
    await clearLegacyNozzleConditionsOnce(db()); // completes on an empty DB
    await seed("post-upgrade-pin", "nozzle_diameter[0]==0.4");

    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: false, reason: "already-done" });
    expect(await conditionOf("post-upgrade-pin")).toBe("nozzle_diameter[0]==0.4"); // NOT erased
  });

  it("skips (never clears) when another process holds the claim — even an uncompleted one", async () => {
    // A crashed-mid-clear claimer leaves an uncompleted marker; re-running
    // could erase a pin accepted in the meantime, so the helper must SKIP.
    await rawDb().collection("_migrations").insertOne({ _id: "legacyNozzleConditions" as never, claimedAt: new Date() });
    await seed("would-be-cleared", "nozzle_diameter[0]==0.4");

    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: false, reason: "claimed-elsewhere" });
    expect(await conditionOf("would-be-cleared")).toBe("nozzle_diameter[0]==0.4");
  });

  it("loses the claim-insert race gracefully (duplicate _id → claimed-elsewhere, no clear)", async () => {
    // Wrapper: findOne sees no marker, but by insert time a racer has claimed.
    await seed("race-victim", "nozzle_diameter[0]==0.4");
    const real = db();
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          ...col,
          findOne: async () => null, // simulate the pre-insert read seeing nothing
          insertOne: async (doc) => {
            await rawDb().collection("_migrations").insertOne({ _id: "legacyNozzleConditions" as never, claimedAt: new Date() });
            return rawDb().collection("_migrations").insertOne(doc as never); // duplicate _id → E11000
          },
          updateOne: col.updateOne.bind(col),
          updateMany: col.updateMany.bind(col),
          deleteOne: col.deleteOne.bind(col),
        };
      },
    };
    const res = await clearLegacyNozzleConditionsOnce(wrapper);
    expect(res).toEqual({ ran: false, reason: "claimed-elsewhere" });
    expect(await conditionOf("race-victim")).toBe("nozzle_diameter[0]==0.4"); // loser never cleared
  });

  it("releases the claim and rethrows on a transient clear failure, so a retry succeeds", async () => {
    await seed("retry-me", "nozzle_diameter[0]==0.4");
    const real = db();
    let failNext = true;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "filaments") return col;
        return {
          ...col,
          findOne: col.findOne.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: col.updateOne.bind(col),
          deleteOne: col.deleteOne.bind(col),
          updateMany: async (f: Record<string, unknown>, u: Record<string, unknown>) => {
            if (failNext) {
              failNext = false;
              throw new Error("transient");
            }
            return col.updateMany(f, u);
          },
        };
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toThrow("transient");
    // Claim released → nothing in _migrations → the retry claims and completes.
    expect(await rawDb().collection("_migrations").findOne({ _id: "legacyNozzleConditions" as never })).toBeNull();
    const res = await clearLegacyNozzleConditionsOnce(wrapper);
    expect(res).toEqual({ ran: true, cleared: 1 });
    expect(await conditionOf("retry-me")).toBe("");
  });

  it("a non-duplicate claim-insert failure propagates (not swallowed as a race)", async () => {
    const real = db();
    let rejection: unknown = new Error("network down");
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          ...col,
          findOne: async () => null,
          insertOne: async () => {
            throw rejection;
          },
          updateOne: col.updateOne.bind(col),
          updateMany: col.updateMany.bind(col),
          deleteOne: col.deleteOne.bind(col),
        };
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toThrow("network down");
    // Non-object / message-less rejections must not be misread as a race either.
    rejection = "boom";
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toBe("boom");
    rejection = null;
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toBe(null);
    rejection = { code: 999 };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toEqual({ code: 999 });
    // ...while a message-shaped E11000 WITHOUT the numeric code (older driver
    // surfaces) still counts as losing the race.
    rejection = new Error("E11000 duplicate key error collection: _migrations");
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).resolves.toEqual({
      ran: false,
      reason: "claimed-elsewhere",
    });
  });

  it("keeps the claim held (skip state) when the release itself fails mid-crash", async () => {
    // The documented worst case: clear fails AND the claim delete fails. The
    // original error still propagates, the claim stays, and every later run
    // SKIPS — residual legacy values (recoverable) instead of any re-run that
    // could erase a post-upgrade pin.
    await seed("stuck", "nozzle_diameter[0]==0.4");
    const real = db();
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name === "filaments") {
          return {
            ...col,
            findOne: col.findOne.bind(col),
            insertOne: col.insertOne.bind(col),
            updateOne: col.updateOne.bind(col),
            deleteOne: col.deleteOne.bind(col),
            updateMany: async () => {
              throw new Error("clear failed");
            },
          };
        }
        if (name === "_migrations") {
          return {
            ...col,
            findOne: col.findOne.bind(col),
            insertOne: col.insertOne.bind(col),
            updateOne: col.updateOne.bind(col),
            updateMany: col.updateMany.bind(col),
            deleteOne: async () => {
              throw new Error("release failed");
            },
          };
        }
        return col;
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toThrow("clear failed");
    // Claim still held → the next run (real db) skips rather than re-running.
    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: false, reason: "claimed-elsewhere" });
    expect(await conditionOf("stuck")).toBe("nozzle_diameter[0]==0.4");
  });

  it("regex matches only the machine grammar", () => {
    for (const yes of [
      "nozzle_diameter[0]==0.4",
      "nozzle_diameter[0]==0.4 or nozzle_diameter[0]==0.6",
      "nozzle_diameter[0]==1",
    ]) expect(LEGACY_NOZZLE_CONDITION_RE.test(yes)).toBe(true);
    for (const no of [
      "",
      "printer_model==MK4 and nozzle_diameter[0]==0.4",
      "nozzle_diameter[0]>=0.4",
      "nozzle_diameter[0]==0.4 or printer_model==MK4",
      "printer_notes=~/.*PRUSA.*/",
    ]) expect(LEGACY_NOZZLE_CONDITION_RE.test(no)).toBe(false);
  });
});

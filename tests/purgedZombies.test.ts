import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  retombstonePurgedZombies,
  type MinimalZombieCollection,
} from "@/lib/purgedZombies";
import { trimEntityNames, type MinimalTrimDb } from "@/lib/trimEntityNames";

/**
 * GH #1004 F1, made load-bearing by GH #1116 (Codex P1, round 27).
 *
 * A zombie (`_purged: true` with `_deletedAt: null`) is ACTIVE as far as
 * MongoDB is concerned, so it occupies the partial unique name index — and on
 * the hybrid remote nothing ever repairs it, because `SyncService.sync()` never
 * calls `dbConnect` and the both-purged copy branch is a no-op.
 *
 * The trim deliberately refuses to let a hidden zombie GATE a sync, so a local
 * `"X "` may become `"X"` while a remote zombie still holds `"X"`. Every later
 * `replaceOne` of that filament onto the remote then fails E11000, permanently.
 */
describe("retombstonePurgedZombies (GH #1004 / #1116)", () => {
  const db = () =>
    mongoose.connection.collection("filaments") as unknown as MinimalZombieCollection;
  const trimDb = () => mongoose.connection.db as unknown as MinimalTrimDb;
  const col = () => mongoose.connection.collection("filaments");

  beforeEach(async () => {
    await col().deleteMany({});
  });

  it("gives an active-but-purged row the tombstone it should have had", async () => {
    const fixed = new Date("2026-08-11T00:00:00.000Z");
    await col().insertOne({
      name: "Zombie",
      vendor: "V",
      type: "PLA",
      _purged: true,
      _deletedAt: null,
    });

    expect(await retombstonePurgedZombies(db(), fixed)).toBe(1);
    const row = await col().findOne({ name: "Zombie" });
    expect(row?._deletedAt).toEqual(fixed);
    expect(row?._purged).toBe(true);
  });

  it("leaves healthy rows — active, trashed and properly purged — alone", async () => {
    const already = new Date("2020-01-01T00:00:00.000Z");
    await col().insertMany([
      { name: "Active", vendor: "V", type: "PLA", _deletedAt: null },
      { name: "Trashed", vendor: "V", type: "PLA", _deletedAt: already },
      {
        name: "ProperlyPurged",
        vendor: "V",
        type: "PLA",
        _purged: true,
        _deletedAt: already,
      },
    ]);

    expect(await retombstonePurgedZombies(db())).toBe(0);
    expect((await col().findOne({ name: "Active" }))?._deletedAt).toBeNull();
    expect((await col().findOne({ name: "ProperlyPurged" }))?._deletedAt).toEqual(already);
  });

  it("is idempotent — a second pass repairs nothing", async () => {
    await col().insertOne({
      name: "Zombie",
      vendor: "V",
      type: "PLA",
      _purged: true,
      _deletedAt: null,
    });
    expect(await retombstonePurgedZombies(db())).toBe(1);
    expect(await retombstonePurgedZombies(db())).toBe(0);
  });

  it("frees the index slot the trim needs — the reason this runs FIRST", async () => {
    // The whole point, end to end. A zombie holding "X" occupies the partial
    // unique index, so trimming "X " to "X" collides. Repair first and the
    // trim goes through; that ordering is what stops the hybrid copy from
    // E11000-ing against a remote zombie forever.
    await col().insertMany([
      { name: "Clash", vendor: "V", type: "PLA", _purged: true, _deletedAt: null },
      { name: "Clash ", vendor: "V", type: "PLA", _deletedAt: null },
    ]);

    // Without the repair the trim cannot land: the zombie owns the name.
    const blocked = await trimEntityNames(trimDb());
    expect(await col().findOne({ name: "Clash " })).not.toBeNull();
    expect(blocked.conflicts.some((c) => c.name === "Clash ")).toBe(true);
    // ...and it does NOT gate the sync, which is precisely why the row was
    // free to diverge and why the repair below is the actual remedy.
    expect(blocked.conflicts.find((c) => c.name === "Clash ")?.active).toBe(false);

    expect(await retombstonePurgedZombies(db())).toBe(1);

    const after = await trimEntityNames(trimDb());
    expect(after.conflicts.some((c) => c.name === "Clash ")).toBe(false);
    expect(await col().findOne({ name: "Clash " })).toBeNull();
    expect(await col().countDocuments({ name: "Clash", _deletedAt: null })).toBe(1);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  untouchedMigrationFilter,
  undoMigrationUpdate,
  type AppliedLegacyMigration,
} from "@/lib/legacySpoolRollback";

/**
 * GH #1121 (Codex P1) — the compensation for a legacy single-spool migration
 * must never delete a spool another request has started using.
 *
 * Between migrating filament A and failing on filament B the print-history
 * route holds no key on A, so a concurrent job can debit A's freshly created
 * spool and record its own history row. An unconditional `$pull` would erase
 * that job's inventory and `usageHistory` and orphan its `PrintHistory` row.
 */
describe("legacy migration rollback", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", mod.default.schema);
    Filament = mongoose.models.Filament;
  });

  /** The post-migration shape: one spool holding the legacy weight, and the
   *  top-level field nulled. */
  async function migratedFilament(name: string, weight = 1000) {
    const f = await Filament.create({
      name,
      vendor: "V",
      type: "PLA",
      totalWeight: null,
      spools: [{ label: "", totalWeight: weight }],
    });
    const applied: AppliedLegacyMigration = {
      id: f._id,
      spoolId: f.spools[0]._id,
      totalWeight: weight,
    };
    return { f, applied };
  }

  const undo = (m: AppliedLegacyMigration) =>
    Filament.updateOne(untouchedMigrationFilter(m), undoMigrationUpdate(m));

  it("reverts an untouched migration exactly", async () => {
    const { f, applied } = await migratedFilament("Untouched Roll");
    const res = await undo(applied);
    expect(res.matchedCount).toBe(1);

    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(0);
    expect(fresh.totalWeight).toBe(1000);
  });

  it("declines when the spool has been DEBITED", async () => {
    const { f, applied } = await migratedFilament("Debited Roll");
    await Filament.updateOne(
      { _id: f._id, "spools._id": applied.spoolId },
      { $set: { "spools.$.totalWeight": 850 } },
    );

    const res = await undo(applied);
    expect(res.matchedCount).toBe(0);

    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(850);
    expect(fresh.totalWeight).toBeNull();
  });

  it("declines when the spool carries a usageHistory entry", async () => {
    // The weight alone isn't enough: a job that debited and then had its
    // debit refunded leaves the weight equal but the ledger non-empty, and
    // pulling the spool would take the ledger with it.
    const { f, applied } = await migratedFilament("Logged Roll");
    await Filament.updateOne(
      { _id: f._id, "spools._id": applied.spoolId },
      {
        $push: {
          "spools.$.usageHistory": { date: new Date(), grams: 5, source: "manual" },
        },
      },
    );

    const res = await undo(applied);
    expect(res.matchedCount).toBe(0);
    expect((await Filament.findById(f._id)).spools).toHaveLength(1);
  });

  it("declines when the top-level weight has been re-set", async () => {
    const { f, applied } = await migratedFilament("Reset Roll");
    await Filament.updateOne({ _id: f._id }, { $set: { totalWeight: 500 } });

    const res = await undo(applied);
    expect(res.matchedCount).toBe(0);
    expect((await Filament.findById(f._id)).totalWeight).toBe(500);
  });

  it("declines when the spool is gone", async () => {
    const { f, applied } = await migratedFilament("Vanished Roll");
    await Filament.updateOne({ _id: f._id }, { $set: { spools: [] } });
    expect((await undo(applied)).matchedCount).toBe(0);
  });

  it("treats an ABSENT usageHistory as empty, not as touched", async () => {
    // Mongoose materializes the array on save, but a document written by the
    // driver (hybrid sync) may omit it. Reading absent as "has entries" would
    // refuse to undo a migration nothing has touched.
    const raw = await mongoose.connection.collection("filaments").insertOne({
      name: "Driver Written Roll",
      vendor: "V",
      type: "PLA",
      totalWeight: null,
      _deletedAt: null,
      spools: [{ _id: new mongoose.Types.ObjectId(), label: "", totalWeight: 1000 }],
    });
    const doc = await mongoose.connection
      .collection("filaments")
      .findOne({ _id: raw.insertedId });
    const applied: AppliedLegacyMigration = {
      id: raw.insertedId,
      spoolId: doc!.spools[0]._id,
      totalWeight: 1000,
    };

    expect((await undo(applied)).matchedCount).toBe(1);
    const fresh = await Filament.findById(raw.insertedId);
    expect(fresh.spools).toHaveLength(0);
    expect(fresh.totalWeight).toBe(1000);
  });

  it("bumps __v so a stale hydrated doc can't re-materialize the spool", async () => {
    // Same reason completeParentPromotion bumps it (GH #605): a document
    // loaded before the undo would otherwise still match its version filter
    // and write the removed spool back on its next save().
    const { f, applied } = await migratedFilament("Versioned Roll");
    const stale = await Filament.findById(f._id);
    const before = stale.__v;

    await undo(applied);
    const fresh = await Filament.findById(f._id);
    expect(fresh.__v).toBe(before + 1);

    stale.spools[0].totalWeight = 900;
    await expect(stale.save({ validateModifiedOnly: true })).rejects.toThrow();
    expect((await Filament.findById(f._id)).spools).toHaveLength(0);
  });
});

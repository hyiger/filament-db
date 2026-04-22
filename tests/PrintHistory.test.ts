import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

/**
 * Schema-level coverage for PrintHistory. Route-level behaviour is in
 * tests/print-history.test.ts; this file locks down the document shape
 * and defaults so a model change can't silently ship. Analytics, filtered
 * history queries, and sync all depend on the fields validated here.
 */
describe("PrintHistory Model", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PrintHistory: any;

  beforeEach(async () => {
    delete mongoose.models.PrintHistory;
    const schemas = (mongoose as unknown as Record<string, Record<string, unknown>>).modelSchemas;
    if (schemas) delete schemas.PrintHistory;
    const mod = await import("@/models/PrintHistory");
    PrintHistory = mod.default;
  });

  it("creates a record with required fields", async () => {
    const entry = await PrintHistory.create({
      jobLabel: "benchy.3mf",
      usage: [{ filamentId: new mongoose.Types.ObjectId(), grams: 25 }],
    });
    expect(entry.jobLabel).toBe("benchy.3mf");
    expect(entry.usage).toHaveLength(1);
    expect(entry.usage[0].grams).toBe(25);
    expect(entry._id).toBeDefined();
  });

  it("fails without jobLabel", async () => {
    await expect(
      PrintHistory.create({
        usage: [{ filamentId: new mongoose.Types.ObjectId(), grams: 10 }],
      }),
    ).rejects.toThrow();
  });

  it("applies defaults (printerId=null, source=manual, notes=empty)", async () => {
    const entry = await PrintHistory.create({
      jobLabel: "defaults-test",
      usage: [{ filamentId: new mongoose.Types.ObjectId(), grams: 5 }],
    });
    expect(entry.printerId).toBeNull();
    expect(entry.source).toBe("manual");
    expect(entry.notes).toBe("");
    expect(entry.startedAt).toBeInstanceOf(Date);
  });

  it("rejects source values outside the enum", async () => {
    await expect(
      PrintHistory.create({
        jobLabel: "bad-source",
        source: "not-a-real-source",
        usage: [{ filamentId: new mongoose.Types.ObjectId(), grams: 5 }],
      }),
    ).rejects.toThrow();
  });

  it("rejects negative grams per usage entry", async () => {
    await expect(
      PrintHistory.create({
        jobLabel: "negative",
        usage: [{ filamentId: new mongoose.Types.ObjectId(), grams: -1 }],
      }),
    ).rejects.toThrow();
  });

  it("supports multi-filament usage entries", async () => {
    const f1 = new mongoose.Types.ObjectId();
    const f2 = new mongoose.Types.ObjectId();
    const entry = await PrintHistory.create({
      jobLabel: "multi-material.3mf",
      source: "prusaslicer",
      usage: [
        { filamentId: f1, grams: 42 },
        { filamentId: f2, grams: 8 },
      ],
    });
    expect(entry.usage).toHaveLength(2);
    expect(entry.usage[0].filamentId.toString()).toBe(f1.toString());
    expect(entry.usage[1].filamentId.toString()).toBe(f2.toString());
    expect(entry.source).toBe("prusaslicer");
  });

  it("stores spoolId on usage entries (nullable)", async () => {
    const fid = new mongoose.Types.ObjectId();
    const sid = new mongoose.Types.ObjectId();
    const entry = await PrintHistory.create({
      jobLabel: "spool-tagged",
      usage: [{ filamentId: fid, spoolId: sid, grams: 12 }],
    });
    expect(entry.usage[0].spoolId.toString()).toBe(sid.toString());
  });

  it("records timestamps automatically", async () => {
    const entry = await PrintHistory.create({
      jobLabel: "ts-check",
      usage: [{ filamentId: new mongoose.Types.ObjectId(), grams: 1 }],
    });
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.updatedAt).toBeInstanceOf(Date);
  });

  it("honours soft-delete via _deletedAt", async () => {
    const entry = await PrintHistory.create({
      jobLabel: "soft-delete",
      usage: [{ filamentId: new mongoose.Types.ObjectId(), grams: 1 }],
    });
    entry._deletedAt = new Date();
    await entry.save();
    const found = await PrintHistory.findOne({ _id: entry._id, _deletedAt: null });
    expect(found).toBeNull();
    const raw = await PrintHistory.findById(entry._id);
    expect(raw._deletedAt).toBeInstanceOf(Date);
  });
});

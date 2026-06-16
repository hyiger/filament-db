import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";

describe("dbConnect", () => {
  beforeEach(() => {
    // Reset the global cache before each test
    (global as Record<string, unknown>).mongoose = undefined;
  });

  it("throws when MONGODB_URI is not defined", async () => {
    const original = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;

    await expect(dbConnect()).rejects.toThrow(
      "Please define the MONGODB_URI environment variable"
    );

    process.env.MONGODB_URI = original;
  });

  it("connects and returns mongoose instance", async () => {
    const result = await dbConnect();
    expect(result).toBeDefined();
    expect(result).toBe(mongoose);
  });

  it("returns cached connection on second call", async () => {
    const first = await dbConnect();
    const second = await dbConnect();
    expect(first).toBe(second);
  });

  it("sets global.mongoose cache", async () => {
    await dbConnect();
    expect((global as Record<string, unknown>).mongoose).toBeDefined();
  });

  it("reuses existing promise when connection is in progress", async () => {
    // Set up a cache with a pending promise but no connection
    const connectPromise = Promise.resolve(mongoose);
    (global as Record<string, unknown>).mongoose = {
      conn: null,
      promise: connectPromise,
      uri: process.env.MONGODB_URI,
      migrations: { instanceIds: false, spoolInstanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false, coreModelIndexes: false },
    };

    const result = await dbConnect();
    expect(result).toBe(mongoose);
  });

  it("initializes global.mongoose when not set", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    await dbConnect();
    expect((global as Record<string, unknown>).mongoose).toBeDefined();
  });

  // GH #457 RESTORED: the backfill stays in the startup path because
  // the `coreModelIndexes` migration depends on every Filament having
  // an `instanceId` before it can build the partial-unique index.
  // See the matching docblock in src/lib/mongodb.ts.
  it("logs when migration backfills instanceIds", async () => {
    await dbConnect();
    const Filament = mongoose.models.Filament || (await import("@/models/Filament")).default;
    await Filament.collection.insertOne({
      name: "MigrationTest",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      _deletedAt: null,
    });
    const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
    cached.migrations = { instanceIds: false, spoolInstanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false, coreModelIndexes: false };
    cached.conn = null;
    cached.promise = null;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dbConnect();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[migration] Backfilled instanceId"),
      );
    } finally {
      logSpy.mockRestore();
      await Filament.deleteMany({ name: "MigrationTest" });
    }
  });

  // GH #732: the spool-level instanceId backfill runs as its own migration.
  it("logs when migration backfills spool instanceIds", async () => {
    await dbConnect();
    const Filament = mongoose.models.Filament || (await import("@/models/Filament")).default;
    // Raw insert: filament already has an id (skips the filament backfill);
    // its lone spool is missing one (triggers the spool backfill).
    await Filament.collection.insertOne({
      name: "SpoolMigrationTest",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      instanceId: "filparent1",
      _deletedAt: null,
      spools: [{ _id: new mongoose.Types.ObjectId(), label: "A", totalWeight: 1000 }],
    });
    const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
    cached.migrations = { instanceIds: false, spoolInstanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false, coreModelIndexes: false };
    cached.conn = null;
    cached.promise = null;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dbConnect();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[migration] Backfilled instanceId for 1 spool(s)"),
      );
      expect(
        (cached.migrations as { spoolInstanceIds: boolean }).spoolInstanceIds,
      ).toBe(true);
      // The lone spool carried over the filament's id.
      const doc = await Filament.findOne({ name: "SpoolMigrationTest" });
      expect(doc!.spools[0].instanceId).toBe("filparent1");
    } finally {
      logSpy.mockRestore();
      await Filament.deleteMany({ name: "SpoolMigrationTest" });
    }
  });

  // GH #732: the spool backfill runs BEFORE the filament backfill so carry-over
  // only adopts a PRE-EXISTING filament id. A legacy filament that never had an
  // id must NOT have its first spool "carry over" a freshly-minted filament id.
  it("spool backfill runs before the filament backfill (no carry-over of a fresh id)", async () => {
    await dbConnect();
    const Filament = mongoose.models.Filament || (await import("@/models/Filament")).default;
    const spoolA = new mongoose.Types.ObjectId();
    const spoolB = new mongoose.Types.ObjectId();
    // Legacy doc: NO filament instanceId, two id-less spools.
    await Filament.collection.insertOne({
      name: "OrderingTest",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      _deletedAt: null,
      spools: [
        { _id: spoolA, label: "A", totalWeight: 1000 },
        { _id: spoolB, label: "B", totalWeight: 1000 },
      ],
    });
    const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
    cached.migrations = { instanceIds: false, spoolInstanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false, coreModelIndexes: false };
    cached.conn = null;
    cached.promise = null;
    try {
      await dbConnect();
      const doc = await Filament.findOne({ name: "OrderingTest" });
      // Filament got a fresh id from the filament backfill...
      expect(doc!.instanceId).toMatch(/^[0-9a-f]{10}$/);
      // ...but neither spool carried it over (spool backfill ran first, when
      // the filament had no id) — both spools have their own fresh ids.
      expect(doc!.spools[0].instanceId).toMatch(/^[0-9a-f]{10}$/);
      expect(doc!.spools[1].instanceId).toMatch(/^[0-9a-f]{10}$/);
      expect(doc!.spools[0].instanceId).not.toBe(doc!.spools[1].instanceId);
      expect(doc!.spools[0].instanceId).not.toBe(doc!.instanceId);
      expect(doc!.spools[1].instanceId).not.toBe(doc!.instanceId);
    } finally {
      await Filament.deleteMany({ name: "OrderingTest" });
    }
  });

  it("does not log a spool backfill when nothing needs migrating", async () => {
    // Steady-state path: empty DB → count 0 → no "[migration] Backfilled
    // instanceId for N spool(s)" line, but the flag still flips to true.
    (global as Record<string, unknown>).mongoose = undefined;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dbConnect();
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Backfilled instanceId for"),
      );
      const cached = (global as Record<string, unknown>).mongoose as {
        migrations: { spoolInstanceIds: boolean };
      };
      expect(cached.migrations.spoolInstanceIds).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("retries the spool backfill on the next connect when it fails once", async () => {
    (global as Record<string, unknown>).mongoose = undefined;

    // mongodb.ts dynamically imports the model each connect, so spy on the
    // shared module export to intercept the call.
    const filamentMod = await import("@/models/Filament");
    const spy = vi
      .spyOn(filamentMod, "backfillSpoolInstanceIds")
      .mockRejectedValueOnce(new Error("transient failure"));

    try {
      await dbConnect();
      const cached = (global as Record<string, unknown>).mongoose as {
        migrations: { spoolInstanceIds: boolean };
      };
      // Didn't succeed yet — flag stays false so the next connect retries.
      expect(cached.migrations.spoolInstanceIds).toBe(false);

      await dbConnect();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(cached.migrations.spoolInstanceIds).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // GH #732 (Codex P2): the filament backfill is gated on the spool backfill
  // succeeding. If the spool backfill throws, NO filament id may be minted —
  // otherwise the next retry's carry-over would adopt that brand-new id.
  it("does not mint filament ids while the spool backfill is failing", async () => {
    await dbConnect();
    const Filament = mongoose.models.Filament || (await import("@/models/Filament")).default;
    // Legacy doc: NO filament instanceId, one id-less spool.
    await Filament.collection.insertOne({
      name: "GatedOrdering",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      _deletedAt: null,
      spools: [{ _id: new mongoose.Types.ObjectId(), label: "A", totalWeight: 1000 }],
    });

    const filamentMod = await import("@/models/Filament");
    const spy = vi
      .spyOn(filamentMod, "backfillSpoolInstanceIds")
      .mockRejectedValueOnce(new Error("transient failure"));
    try {
      const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
      cached.migrations = { instanceIds: false, spoolInstanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false, coreModelIndexes: false };
      cached.conn = null;
      cached.promise = null;

      // Read PERSISTED values via the raw driver — a hydrated findOne() would
      // apply the schema default for a missing instanceId in memory, masking
      // whether anything was actually written.
      const raw = () => Filament.collection.findOne({ name: "GatedOrdering" });

      // Cycle 1: spool backfill throws → filament backfill is SKIPPED.
      await dbConnect();
      const m = (cached.migrations as { spoolInstanceIds: boolean; instanceIds: boolean });
      expect(m.spoolInstanceIds).toBe(false);
      expect(m.instanceIds).toBe(false);
      let doc = await raw();
      expect(doc!.instanceId).toBeUndefined(); // no filament id minted yet
      expect(doc!.spools[0].instanceId).toBeUndefined(); // spool untouched too

      // Cycle 2: spool backfill succeeds first (spool gets a FRESH id, no
      // carry-over since the filament still had no id), THEN filament backfill
      // mints the filament id.
      await dbConnect();
      expect(m.spoolInstanceIds).toBe(true);
      expect(m.instanceIds).toBe(true);
      doc = await raw();
      expect(doc!.instanceId).toMatch(/^[0-9a-f]{10}$/);
      expect(doc!.spools[0].instanceId).toMatch(/^[0-9a-f]{10}$/);
      // The ordering guarantee held: the spool did NOT inherit the later-minted
      // filament id.
      expect(doc!.spools[0].instanceId).not.toBe(doc!.instanceId);
    } finally {
      spy.mockRestore();
      await Filament.deleteMany({ name: "GatedOrdering" });
    }
  });


  it("reconnects when URI changes", async () => {
    // First connect with current URI
    await dbConnect();

    // Simulate URI change by modifying the cached URI
    const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
    cached.uri = "mongodb://different-uri:27017/test";

    // This should trigger disconnect and reconnect
    const result = await dbConnect();
    expect(result).toBeDefined();
  });

  it("marks each migration complete on first successful connect", async () => {
    (global as Record<string, unknown>).mongoose = undefined;

    const result = await dbConnect();
    expect(result).toBeDefined();
    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { sharedCatalogIndexes: boolean; spoolInstanceIds: boolean };
    };
    expect(cached.migrations.sharedCatalogIndexes).toBe(true);
    expect(cached.migrations.spoolInstanceIds).toBe(true);
  });

  it("skips migrations on subsequent connects once they've succeeded", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    await dbConnect();

    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { sharedCatalogIndexes: boolean };
    };
    expect(cached.migrations.sharedCatalogIndexes).toBe(true);

    const result = await dbConnect();
    expect(result).toBeDefined();
  });

  it("retries a failed migration on the next connect (doesn't poison the cache)", async () => {
    // Codex round-4 P2: a transient failure on backfillInstanceIds or
    // syncIndexes used to set the single `migrated` flag and skip both
    // migrations forever after. With per-migration flags, only the
    // succeeded migration sticks; a failed one retries on the next call.
    (global as Record<string, unknown>).mongoose = undefined;

    // Force the SharedCatalog migration to throw on its first attempt.
    const sharedCatalogMod = await import("@/models/SharedCatalog");
    const SharedCatalog = sharedCatalogMod.default;
    const syncIndexesSpy = vi
      .spyOn(SharedCatalog, "syncIndexes")
      .mockRejectedValueOnce(new Error("transient failure"));

    try {
      await dbConnect();
      const cached = (global as Record<string, unknown>).mongoose as {
        migrations: { sharedCatalogIndexes: boolean };
      };
      // The sharedCatalog migration didn't succeed yet.
      expect(cached.migrations.sharedCatalogIndexes).toBe(false);

      // Next call should retry the failed one — and now succeed.
      await dbConnect();
      expect(syncIndexesSpy).toHaveBeenCalledTimes(2);
      expect(cached.migrations.sharedCatalogIndexes).toBe(true);
    } finally {
      syncIndexesSpy.mockRestore();
    }
  });
});

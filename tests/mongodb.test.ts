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

  it("#898: concurrent first-connects run the nozzle-split migration once (no duplicate clones)", async () => {
    await dbConnect();
    const Nozzle = mongoose.models.Nozzle || (await import("@/models/Nozzle")).default;
    const Printer = mongoose.models.Printer || (await import("@/models/Printer")).default;
    await Nozzle.deleteMany({});
    await Printer.collection.deleteMany({});

    // One nozzle installed on TWO printers → the #232 split should clone it
    // EXACTLY once (keep printer 1's ref, mint one clone for printer 2).
    const noz = await Nozzle.create({ name: "Brass", diameter: 0.4, type: "Brass" });
    await Printer.collection.insertMany([
      { name: "P1", installedNozzles: [noz._id], _deletedAt: null },
      { name: "P2", installedNozzles: [noz._id], _deletedAt: null },
    ]);

    // Re-arm the split migration and clear any in-flight handle.
    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { nozzlePhysicalInstances: boolean };
      migrationsPromise: Promise<void> | null;
    };
    cached.migrations.nozzlePhysicalInstances = false;
    cached.migrationsPromise = null;

    // Fire two connects concurrently. Pre-fix both ran the split and each
    // minted a clone (2 clones); the #898 serialization runs it once.
    await Promise.all([dbConnect(), dbConnect()]);

    const nozzles = await Nozzle.find({ _deletedAt: null });
    expect(nozzles).toHaveLength(2); // original + exactly ONE clone
    expect(cached.migrations.nozzlePhysicalInstances).toBe(true);
  });

  // GH #312: a cached handle whose connection went dead (readyState !== 1
  // after an outage / Atlas failover) must be dropped so the reconnect path
  // runs instead of returning a stale handle. src/lib/mongodb.ts:81-84.
  it("drops a stale cached handle and reconnects when readyState !== 1", async () => {
    // Establish a live, fully-migrated connection first.
    await dbConnect();
    // Force the "connected" check to see a dead handle for the duration of
    // the next connect — the mocked getter flips readyState to 0
    // (disconnected), tripping the stale-handle drop.
    const readySpy = vi
      .spyOn(mongoose.connection, "readyState", "get")
      .mockReturnValue(0 as unknown as 0);
    let result: typeof mongoose;
    try {
      result = await dbConnect();
    } finally {
      readySpy.mockRestore();
    }
    // The reconnect path re-established a usable handle.
    expect(result).toBe(mongoose);
    expect(mongoose.connection.readyState).toBe(1);
  });

  // src/lib/mongodb.ts:104-107 — the connect promise's own .catch nulls
  // cached.promise and rethrows so a failed first connect doesn't get cached
  // as a permanently-rejected promise (the next call retries cleanly).
  it("clears the cached promise and rethrows when mongoose.connect rejects", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    const connectSpy = vi
      .spyOn(mongoose, "connect")
      .mockRejectedValueOnce(new Error("connect boom"));
    try {
      await expect(dbConnect()).rejects.toThrow("connect boom");
      const cached = (global as Record<string, unknown>).mongoose as Record<
        string,
        unknown
      >;
      // The .catch reset the promise so a retry re-attempts the connect.
      expect(cached.promise).toBeNull();
      expect(cached.conn).toBeNull();
    } finally {
      connectSpy.mockRestore();
    }
    // Recovery: the next call connects for real (spy consumed once).
    const ok = await dbConnect();
    expect(ok).toBe(mongoose);
  });

  // src/lib/mongodb.ts:184-186 — the filament-level backfill's own catch. It's
  // gated on the spool backfill succeeding, so a filament-backfill throw leaves
  // spoolInstanceIds=true but instanceIds=false, and the next connect retries.
  it("retries the filament backfill on the next connect when it fails once", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    const filamentMod = await import("@/models/Filament");
    const spy = vi
      .spyOn(filamentMod, "backfillInstanceIds")
      .mockRejectedValueOnce(new Error("transient filament failure"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await dbConnect();
      const cached = (global as Record<string, unknown>).mongoose as {
        migrations: { instanceIds: boolean; spoolInstanceIds: boolean };
      };
      // Spool backfill (which runs first) succeeded; the filament backfill threw.
      expect(cached.migrations.spoolInstanceIds).toBe(true);
      expect(cached.migrations.instanceIds).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to backfill instanceIds"),
        expect.anything(),
      );

      // Next connect retries the failed one — and now succeeds.
      await dbConnect();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(cached.migrations.instanceIds).toBe(true);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  // src/lib/mongodb.ts:205-207 — the SharedCatalog syncIndexes "dropped > 0"
  // log branch (corrective on an upgraded DB). Hard to force a real drop
  // deterministically, so stub syncIndexes to report a dropped index name.
  it("logs when SharedCatalog syncIndexes reports dropped indexes", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    const SharedCatalog = (await import("@/models/SharedCatalog")).default;
    const scSpy = vi
      .spyOn(SharedCatalog, "syncIndexes")
      .mockResolvedValueOnce(["slug_1"] as unknown as string[]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dbConnect();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[migration] Rebuilt SharedCatalog indexes (dropped: slug_1)",
        ),
      );
      const cached = (global as Record<string, unknown>).mongoose as {
        migrations: { sharedCatalogIndexes: boolean };
      };
      expect(cached.migrations.sharedCatalogIndexes).toBe(true);
    } finally {
      scSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  // src/lib/mongodb.ts:234-239 — the per-model "dropped > 0" log branch inside
  // the coreModelIndexes loop. Stub one model's syncIndexes to report a drop.
  it("logs when a core model's syncIndexes reports dropped indexes", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    await dbConnect(); // establish + run the migration block once
    const Filament = (await import("@/models/Filament")).default;
    const fSpy = vi
      .spyOn(Filament, "syncIndexes")
      .mockResolvedValueOnce(["name_1"] as unknown as string[]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { coreModelIndexes: boolean };
      migrationsPromise: Promise<void> | null;
    };
    cached.migrations.coreModelIndexes = false;
    cached.migrationsPromise = null;
    try {
      await dbConnect();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Rebuilt Filament indexes (dropped: name_1)",
        ),
      );
      expect(cached.migrations.coreModelIndexes).toBe(true);
    } finally {
      fSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  // src/lib/mongodb.ts:242-244 — the coreModelIndexes catch. A syncIndexes
  // failure leaves the flag false so the next connect retries.
  it("retries the core-model index sync on the next connect when it fails once", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    await dbConnect();
    const BedType = (await import("@/models/BedType")).default;
    const spy = vi
      .spyOn(BedType, "syncIndexes")
      .mockRejectedValueOnce(new Error("transient index failure"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { coreModelIndexes: boolean };
      migrationsPromise: Promise<void> | null;
    };
    cached.migrations.coreModelIndexes = false;
    cached.migrationsPromise = null;
    try {
      await dbConnect();
      expect(cached.migrations.coreModelIndexes).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to sync core model indexes"),
        expect.anything(),
      );

      await dbConnect();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(cached.migrations.coreModelIndexes).toBe(true);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  // src/lib/mongodb.ts:285 (`p.installedNozzles || []`) + :301 (`if (!source)
  // continue`). A nozzle referenced by two printers but soft-deleted between
  // the ref walk and the hydrate is skipped, minting no clone; a
  // no-installedNozzles printer exercises the `|| []` fallback.
  it("#232 split: skips a soft-deleted source nozzle and tolerates a printer with no installedNozzles", async () => {
    await dbConnect();
    const Nozzle = (await import("@/models/Nozzle")).default;
    const Printer = (await import("@/models/Printer")).default;
    await Nozzle.deleteMany({});
    await Printer.collection.deleteMany({});

    // Nozzle inserted already soft-deleted → Nozzle.findOne({_deletedAt:null})
    // returns null → the `!source` branch continues without cloning.
    const nozzleId = new mongoose.Types.ObjectId();
    await Nozzle.collection.insertOne({
      _id: nozzleId,
      name: "GoneNozzle",
      diameter: 0.4,
      type: "Brass",
      _deletedAt: new Date(),
    });
    await Printer.collection.insertMany([
      { name: "SP1", installedNozzles: [nozzleId], _deletedAt: null },
      { name: "SP2", installedNozzles: [nozzleId], _deletedAt: null },
      // No installedNozzles field at all → exercises the `|| []` guard.
      { name: "SPNone", _deletedAt: null },
    ]);

    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { nozzlePhysicalInstances: boolean };
      migrationsPromise: Promise<void> | null;
    };
    cached.migrations.nozzlePhysicalInstances = false;
    cached.migrationsPromise = null;

    try {
      await dbConnect();
      // No clone minted (source was gone); the pass still completes cleanly.
      const active = await Nozzle.find({ _deletedAt: null });
      expect(active).toHaveLength(0);
      expect(cached.migrations.nozzlePhysicalInstances).toBe(true);
    } finally {
      await Nozzle.deleteMany({});
      await Printer.collection.deleteMany({});
    }
  });

  // src/lib/mongodb.ts:351-354 (`if (!fresh) throw`) — the printer being
  // swapped disappears mid-migration. The throw is caught by the inner
  // try/catch, the clone is rolled back, the swapErr propagates to the outer
  // catch (:390), and the flag stays false so the pass retries.
  it("#232 split: rolls back the clone and stays retryable when the printer vanishes mid-swap", async () => {
    await dbConnect();
    const Nozzle = (await import("@/models/Nozzle")).default;
    const Printer = (await import("@/models/Printer")).default;
    await Nozzle.deleteMany({});
    await Printer.collection.deleteMany({});

    const noz = await Nozzle.create({ name: "Steel", diameter: 0.6, type: "Steel" });
    await Printer.collection.insertMany([
      { name: "FP1", installedNozzles: [noz._id], _deletedAt: null },
      { name: "FP2", installedNozzles: [noz._id], _deletedAt: null },
    ]);

    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { nozzlePhysicalInstances: boolean };
      migrationsPromise: Promise<void> | null;
    };
    cached.migrations.nozzlePhysicalInstances = false;
    cached.migrationsPromise = null;

    // Printer.findById(...).select(...).lean() resolves to null → `!fresh`.
    const findByIdSpy = vi.spyOn(Printer, "findById").mockReturnValueOnce({
      select: () => ({ lean: () => Promise.resolve(null) }),
    } as unknown as ReturnType<typeof Printer.findById>);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await dbConnect();
      // Clone rolled back → only the original nozzle survives.
      const active = await Nozzle.find({ _deletedAt: null });
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe("Steel");
      // Outer catch logged and left the flag false for a retry.
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to split duplicated nozzles"),
        expect.anything(),
      );
      expect(cached.migrations.nozzlePhysicalInstances).toBe(false);
    } finally {
      findByIdSpy.mockRestore();
      errSpy.mockRestore();
      await Nozzle.deleteMany({});
      await Printer.collection.deleteMany({});
    }
  });

  // src/lib/mongodb.ts:356-379 — the atomic-swap write itself fails. The
  // clone is rolled back (:373), swapErr rethrown (:378), outer catch (:390)
  // logs and leaves the flag false. Also exercises the swapped-array map
  // (:358-360) over a printer that carries an UNRELATED nozzle too, so both
  // ternary branches (keep unrelated / swap source) run.
  it("#232 split: rolls back the clone when the swap write fails", async () => {
    await dbConnect();
    const Nozzle = (await import("@/models/Nozzle")).default;
    const Printer = (await import("@/models/Printer")).default;
    await Nozzle.deleteMany({});
    await Printer.collection.deleteMany({});

    const shared = await Nozzle.create({ name: "SharedBrass", diameter: 0.4, type: "Brass" });
    const other = await Nozzle.create({ name: "SoloSteel", diameter: 0.6, type: "Steel" });
    await Printer.collection.insertMany([
      { name: "WP1", installedNozzles: [shared._id], _deletedAt: null },
      // WP2 carries the shared nozzle AND an unrelated one → the swap map
      // hits both ternary branches.
      { name: "WP2", installedNozzles: [shared._id, other._id], _deletedAt: null },
    ]);

    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { nozzlePhysicalInstances: boolean };
      migrationsPromise: Promise<void> | null;
    };
    cached.migrations.nozzlePhysicalInstances = false;
    cached.migrationsPromise = null;

    const updSpy = vi
      .spyOn(Printer, "updateOne")
      .mockRejectedValueOnce(new Error("swap write boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await dbConnect();
      expect(updSpy).toHaveBeenCalledTimes(1);
      // The freshly-minted clone was deleted on rollback → only the two
      // originals remain (SharedBrass + SoloSteel), no "SharedBrass #2".
      const active = await Nozzle.find({ _deletedAt: null });
      expect(active).toHaveLength(2);
      expect(active.some((n) => n.name === "SharedBrass #2")).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to split duplicated nozzles"),
        expect.anything(),
      );
      expect(cached.migrations.nozzlePhysicalInstances).toBe(false);
    } finally {
      updSpy.mockRestore();
      errSpy.mockRestore();
      await Nozzle.deleteMany({});
      await Printer.collection.deleteMany({});
    }
  });
});

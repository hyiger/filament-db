import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import dbConnect, { isDuplicateKeyError } from "@/lib/mongodb";

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

  // #955.14: the duplicate-key classifier. Covers every branch deterministically
  // so the integration test below doesn't have to reproduce each error shape.
  describe("isDuplicateKeyError (#955.14)", () => {
    it("is true for a driver E11000 (numeric code)", () => {
      expect(isDuplicateKeyError({ code: 11000, message: "whatever" })).toBe(true);
    });
    it("is true when only the message carries E11000 / 'duplicate key'", () => {
      expect(isDuplicateKeyError({ message: "E11000 duplicate key error" })).toBe(true);
      expect(isDuplicateKeyError({ message: "duplicate key on index" })).toBe(true);
    });
    it("is false for an unrelated error, a wrong code, and non-objects", () => {
      expect(isDuplicateKeyError(new Error("transient blip"))).toBe(false);
      expect(isDuplicateKeyError({ code: 26, message: "ns not found" })).toBe(false);
      expect(isDuplicateKeyError(null)).toBe(false);
      expect(isDuplicateKeyError("E11000")).toBe(false);
    });
  });

  // #955.14: a DB with duplicate ACTIVE rows on a unique field made the
  // coreModelIndexes migration loop forever — syncIndexes() E11000'd, the shared
  // catch left the flag false, and the block re-ran on every request. Now the
  // dup-key error is terminal: it logs once, the flag converges, and the block
  // stops re-entering. Seed the collision with a raw insertMany (bypassing the
  // model's validators + the unique index, which is dropped first) to reproduce
  // a pre-migration upgraded DB.
  it("treats a duplicate-active-rows E11000 as terminal so the index migration converges", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    await dbConnect(); // establish + build the Filament indexes once
    const Filament = (await import("@/models/Filament")).default;

    // Drop every non-_id index so the colliding pair can be inserted, then seed
    // two ACTIVE filaments sharing a name (distinct instanceIds isolate the
    // E11000 to the name partial-unique index).
    await Filament.collection.dropIndexes().catch(() => {});
    await Filament.collection.insertMany([
      { name: "DupName", vendor: "V", type: "PLA", color: "#808080", diameter: 1.75, instanceId: "dupinst001", _deletedAt: null },
      { name: "DupName", vendor: "V", type: "PLA", color: "#808080", diameter: 1.75, instanceId: "dupinst002", _deletedAt: null },
    ]);

    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { coreModelIndexes: boolean };
      migrationsPromise: Promise<void> | null;
    };
    cached.migrations.coreModelIndexes = false;
    cached.migrationsPromise = null;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Spy WITHOUT a mock impl so the real syncIndexes runs (and throws E11000);
    // we only need the call count to prove the block stops re-entering.
    const syncSpy = vi.spyOn(Filament, "syncIndexes");
    try {
      // Cycle 1: Filament.syncIndexes throws E11000 → terminal → logged once →
      // flag converges to true despite the unbuildable index.
      await dbConnect();
      expect(cached.migrations.coreModelIndexes).toBe(true);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("cannot build a unique index"),
        expect.anything(),
      );
      // It must NOT have logged the retryable "will retry" message — E11000 is
      // terminal, not transient.
      expect(errSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Failed to sync core model indexes"),
        expect.anything(),
      );
      const callsAfterCycle1 = syncSpy.mock.calls.length;
      expect(callsAfterCycle1).toBeGreaterThan(0);

      // Cycle 2: the flag is now true, so the migration block never re-enters —
      // syncIndexes isn't called again. This is the anti-infinite-loop proof.
      await dbConnect();
      expect(syncSpy.mock.calls.length).toBe(callsAfterCycle1);
    } finally {
      errSpy.mockRestore();
      syncSpy.mockRestore();
      await Filament.deleteMany({ name: "DupName" });
    }
  });

  // #955.14 (Codex re-review): the terminal-E11000 handling must NOT fire while
  // the instanceId backfills are still pending. If the spool backfill throws
  // transiently, the filament backfill is gated off and legacy rows stay without
  // an instanceId — building the partial-unique index would E11000 on the shared
  // null. Treating THAT as terminal would permanently skip the index rebuild even
  // after the backfill later succeeds. The coreModelIndexes block is gated on
  // both backfills, so it doesn't run (and doesn't converge) until they finish.
  it("keeps the index sync retryable until the instanceId backfills finish", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    await dbConnect(); // establish; all flags true
    const Filament = (await import("@/models/Filament")).default;

    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: {
        spoolInstanceIds: boolean;
        instanceIds: boolean;
        coreModelIndexes: boolean;
      };
      migrationsPromise: Promise<void> | null;
    };
    // Re-arm: pretend NOTHING has migrated yet this process.
    cached.migrations.spoolInstanceIds = false;
    cached.migrations.instanceIds = false;
    cached.migrations.coreModelIndexes = false;
    cached.migrationsPromise = null;

    const filamentMod = await import("@/models/Filament");
    const backfillSpy = vi
      .spyOn(filamentMod, "backfillSpoolInstanceIds")
      .mockRejectedValueOnce(new Error("transient backfill failure"));
    const syncSpy = vi.spyOn(Filament, "syncIndexes");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Cycle 1: spool backfill throws → filament backfill gated off → the
      // coreModelIndexes gate (both backfills) is UNMET → syncIndexes not called,
      // flag stays false (retryable), NOT terminally converged.
      await dbConnect();
      expect(cached.migrations.spoolInstanceIds).toBe(false);
      expect(cached.migrations.instanceIds).toBe(false);
      expect(cached.migrations.coreModelIndexes).toBe(false);
      expect(syncSpy).not.toHaveBeenCalled();

      // Cycle 2: backfills succeed (mock consumed) → gate met → the index sync
      // runs and converges. The rebuild wasn't permanently skipped.
      await dbConnect();
      expect(cached.migrations.spoolInstanceIds).toBe(true);
      expect(cached.migrations.instanceIds).toBe(true);
      expect(cached.migrations.coreModelIndexes).toBe(true);
      expect(syncSpy).toHaveBeenCalled();
    } finally {
      backfillSpy.mockRestore();
      syncSpy.mockRestore();
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

/**
 * GH #1004 F1 — startup repair for "zombie" filaments created by the
 * pre-fix importer: `_purged: true` while ACTIVE (`_deletedAt: null`).
 * Their intended state is gone-forever, so the migration restores
 * `_deletedAt`. Idempotent: matches nothing on healthy installs.
 */
describe("purgedZombies migration (GH #1004 F1)", () => {
  it("re-tombstones active _purged rows and leaves healthy rows alone", async () => {
    await dbConnect();
    const Filament = mongoose.models.Filament || (await import("@/models/Filament")).default;

    // A zombie (raw insert — the broken state the old importer produced),
    // a healthy active row, and a proper tombstone.
    await Filament.collection.insertOne({
      name: "Zombie", vendor: "T", type: "PLA", _purged: true, _deletedAt: null,
    });
    await Filament.collection.insertOne({
      name: "Healthy", vendor: "T", type: "PLA", _deletedAt: null,
    });
    const properDeletedAt = new Date("2024-01-01T00:00:00Z");
    await Filament.collection.insertOne({
      name: "ProperTombstone", vendor: "T", type: "PLA", _purged: true, _deletedAt: properDeletedAt,
    });

    // Force the migration block to re-run.
    const cached = (global as Record<string, unknown>).mongoose as {
      conn: unknown; promise: unknown;
      migrations: Record<string, boolean>;
    };
    cached.migrations = {
      instanceIds: false, spoolInstanceIds: false, sharedCatalogIndexes: false,
      nozzlePhysicalInstances: false, coreModelIndexes: false, purgedZombies: false,
    };
    cached.conn = null;
    cached.promise = null;

    await dbConnect();

    const zombie = await Filament.collection.findOne({ name: "Zombie" });
    expect(zombie!._purged).toBe(true);
    expect(zombie!._deletedAt).not.toBeNull(); // re-tombstoned

    const healthy = await Filament.collection.findOne({ name: "Healthy" });
    expect(healthy!._purged ?? false).toBe(false);
    expect(healthy!._deletedAt).toBeNull(); // untouched

    const proper = await Filament.collection.findOne({ name: "ProperTombstone" });
    expect(proper!._deletedAt!.toISOString()).toBe(properDeletedAt.toISOString()); // untouched

    expect(cached.migrations.purgedZombies).toBe(true);

    await Filament.collection.deleteMany({ name: { $in: ["Zombie", "Healthy", "ProperTombstone"] } });
  });

  it("leaves the flag false and retries on a transient failure", async () => {
    await dbConnect();
    const Filament = mongoose.models.Filament || (await import("@/models/Filament")).default;

    const cached = (global as Record<string, unknown>).mongoose as {
      conn: unknown; promise: unknown; migrations: Record<string, boolean>;
    };
    cached.migrations = {
      instanceIds: false, spoolInstanceIds: false, sharedCatalogIndexes: false,
      nozzlePhysicalInstances: false, coreModelIndexes: false, purgedZombies: false,
    };
    cached.conn = null;
    cached.promise = null;

    // Force the zombie repair to throw once (transient blip).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const updateSpy = vi
      .spyOn(Filament, "updateMany")
      .mockRejectedValueOnce(new Error("transient"));
    try {
      await dbConnect();
      // The catch left the flag false so the next connect retries.
      expect(cached.migrations.purgedZombies).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("purged zombie"),
        expect.any(Error),
      );
    } finally {
      updateSpy.mockRestore();
      errSpy.mockRestore();
    }

    // Retry now succeeds (real updateMany) and flips the flag.
    cached.conn = null;
    cached.promise = null;
    await dbConnect();
    expect(cached.migrations.purgedZombies).toBe(true);
  });
});

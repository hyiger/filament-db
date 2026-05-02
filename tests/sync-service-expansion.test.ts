import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import { SyncService } from "../electron/sync-service";

/**
 * Coverage for the v1.12 sync expansion (P1 audit follow-up):
 *
 *   - Sync now covers bedtypes, printhistories, sharedcatalogs.
 *   - Filament transform remaps calibrations[].bedType.
 *   - Printer.amsSlots[].filamentId is repaired post-filament-sync.
 *   - Spool subdocument refs (amsSlots[].spoolId, usage[].spoolId) are
 *     cleared on cross-side remap because no spool syncIds exist yet.
 *
 * Each test reaches into the raw MongoDB driver to seed minimal docs and
 * then asserts the post-sync state on the opposite side.
 */
describe("SyncService — v1.12 sync expansion", () => {
  let localServer: MongoMemoryServer;
  let remoteServer: MongoMemoryServer;
  let localClient: MongoClient;
  let remoteClient: MongoClient;
  let sync: SyncService | null = null;

  beforeAll(async () => {
    [localServer, remoteServer] = await Promise.all([
      MongoMemoryServer.create(),
      MongoMemoryServer.create(),
    ]);
    localClient = await new MongoClient(localServer.getUri()).connect();
    remoteClient = await new MongoClient(remoteServer.getUri()).connect();
  }, 120_000);

  afterAll(async () => {
    await Promise.all([
      localClient?.close().catch(() => {}),
      remoteClient?.close().catch(() => {}),
    ]);
    await Promise.all([
      localServer?.stop().catch(() => {}),
      remoteServer?.stop().catch(() => {}),
    ]);
  });

  beforeAll(async () => {
    // Mirror the partial-unique name indexes Mongoose creates for
    // bedtypes and locations so name-reconciliation tests actually
    // hit the duplicate-key constraint.
    for (const db of [localClient.db("filament-db"), remoteClient.db("filament-db")]) {
      await db.collection("bedtypes").createIndex(
        { name: 1 },
        { unique: true, partialFilterExpression: { _deletedAt: null } },
      ).catch(() => {});
      await db.collection("locations").createIndex(
        { name: 1 },
        { unique: true, partialFilterExpression: { _deletedAt: null } },
      ).catch(() => {});
      await db.collection("sharedcatalogs").createIndex(
        { slug: 1 },
        { unique: true },
      ).catch(() => {});
    }
  }, 120_000);

  afterEach(async () => {
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");
    for (const col of ["bedtypes", "filaments", "locations", "nozzles", "printers", "printhistories", "sharedcatalogs"]) {
      await localDb.collection(col).deleteMany({}).catch(() => {});
      await remoteDb.collection(col).deleteMany({}).catch(() => {});
    }
    sync?.destroy();
    sync = null;
  });

  function makeSync() {
    return new SyncService(localServer.getUri(), remoteServer.getUri());
  }

  // ── bedtypes ──────────────────────────────────────────────────────────

  describe("bedtypes", () => {
    it("pushes a local-only bedtype to remote", async () => {
      await localClient.db("filament-db").collection("bedtypes").insertOne({
        name: "Textured PEI",
        material: "PEI",
        notes: "",
        _deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sync = makeSync();
      const results = await sync.sync();
      const bedTypeResult = results.find((r) => r.collection === "bedtypes");
      expect(bedTypeResult?.pushed).toBe(1);

      const remote = await remoteClient.db("filament-db").collection("bedtypes").findOne({ name: "Textured PEI" });
      expect(remote?.material).toBe("PEI");
      expect(remote?.syncId).toBeTruthy();
    });

    it("reconciles same-name bedtypes across DBs without tripping the unique-name index", async () => {
      // Both sides independently created the same bedtype with their own syncIds —
      // the very shape that would E11000 on first sync without reconcileByName.
      await localClient.db("filament-db").collection("bedtypes").insertOne({
        name: "Cool Plate", material: "PEI", notes: "local", syncId: "local-uuid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });
      await remoteClient.db("filament-db").collection("bedtypes").insertOne({
        name: "Cool Plate", material: "PEI", notes: "remote", syncId: "remote-uuid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });

      sync = makeSync();
      const results = await sync.sync();
      expect(results.find((r) => r.collection === "bedtypes")).toBeDefined();

      // Each side still has exactly one row for the name (no E11000).
      const localCount = await localClient.db("filament-db").collection("bedtypes").countDocuments({ name: "Cool Plate", _deletedAt: null });
      const remoteCount = await remoteClient.db("filament-db").collection("bedtypes").countDocuments({ name: "Cool Plate", _deletedAt: null });
      expect(localCount).toBe(1);
      expect(remoteCount).toBe(1);

      // syncIds unified — local wins per the tie-break rule.
      const localRow = await localClient.db("filament-db").collection("bedtypes").findOne({ name: "Cool Plate" });
      const remoteRow = await remoteClient.db("filament-db").collection("bedtypes").findOne({ name: "Cool Plate" });
      expect(localRow?.syncId).toBe("local-uuid");
      expect(remoteRow?.syncId).toBe("local-uuid");
    });
  });

  // ── filament calibrations[].bedType remap ─────────────────────────────

  describe("filament calibrations.bedType remap", () => {
    it("translates calibrations[].bedType ObjectId across DBs via syncId", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");

      // Seed: a nozzle (referenced by calibration) and a bedtype on local.
      const localNozzleId = new ObjectId();
      await localDb.collection("nozzles").insertOne({
        _id: localNozzleId, name: "0.4 brass", diameter: 0.4, type: "brass",
        highFlow: false, syncId: "n-syncid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });
      const localBedTypeId = new ObjectId();
      await localDb.collection("bedtypes").insertOne({
        _id: localBedTypeId, name: "Textured PEI", material: "PEI", notes: "",
        syncId: "bt-syncid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });
      // Same nozzle/bedtype identities pre-existing on remote so the calibration
      // entry has a target. (In real sync, these would propagate via the
      // collection sync that runs first; pre-seeding keeps this test focused.)
      const remoteNozzleId = new ObjectId();
      await remoteDb.collection("nozzles").insertOne({
        _id: remoteNozzleId, name: "0.4 brass", diameter: 0.4, type: "brass",
        highFlow: false, syncId: "n-syncid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });
      const remoteBedTypeId = new ObjectId();
      await remoteDb.collection("bedtypes").insertOne({
        _id: remoteBedTypeId, name: "Textured PEI", material: "PEI", notes: "",
        syncId: "bt-syncid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });

      // Filament with a calibration referencing local nozzle + bedtype.
      await localDb.collection("filaments").insertOne({
        name: "Test PLA", vendor: "Test", type: "PLA", color: "#ffffff",
        diameter: 1.75, temperatures: {}, bedTypeTemps: [],
        compatibleNozzles: [],
        calibrations: [
          { nozzle: localNozzleId, bedType: localBedTypeId, extrusionMultiplier: 0.97 },
        ],
        spools: [], optTags: [], settings: {},
        syncId: "f-syncid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });

      sync = makeSync();
      await sync.sync();

      // The pushed filament's calibration.bedType should now point at the
      // remote-side bedtype id, not local's.
      const remoteFilament = await remoteDb.collection("filaments").findOne({ name: "Test PLA" });
      expect(remoteFilament).not.toBeNull();
      expect(remoteFilament?.calibrations).toHaveLength(1);
      const cal = remoteFilament?.calibrations?.[0];
      expect(cal.bedType.toString()).toBe(remoteBedTypeId.toString());
      expect(cal.bedType.toString()).not.toBe(localBedTypeId.toString());
    });
  });

  // ── printer.amsSlots[].filamentId repair ──────────────────────────────

  describe("printer amsSlots.filamentId repair", () => {
    it("rewrites a stale amsSlots.filamentId to point at the right side's filament id", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");

      // Filament present on both sides with the same syncId but different _id.
      const localFilId = new ObjectId();
      const remoteFilId = new ObjectId();
      const filDoc = {
        name: "AMS PLA", vendor: "Test", type: "PLA", color: "#000",
        diameter: 1.75, temperatures: {}, bedTypeTemps: [],
        compatibleNozzles: [], calibrations: [], spools: [], optTags: [], settings: {},
        syncId: "ams-fil",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      };
      await localDb.collection("filaments").insertOne({ ...filDoc, _id: localFilId });
      await remoteDb.collection("filaments").insertOne({ ...filDoc, _id: remoteFilId });

      // Printer on local with amsSlots pointing at the LOCAL filament id.
      // After sync to remote, the value would be a stale local-side id
      // unless the amsSlots repair pass rewrites it to remoteFilId.
      await localDb.collection("printers").insertOne({
        name: "X1C", manufacturer: "Bambu", printerModel: "X1C",
        installedNozzles: [], notes: "", buildVolume: { x: null, y: null, z: null },
        maxFlow: null, maxSpeed: null, enclosed: false, autoBedLevel: false,
        amsSlots: [
          { slotName: "A", filamentId: localFilId, spoolId: new ObjectId() },
          { slotName: "B", filamentId: null, spoolId: null },
        ],
        syncId: "p-syncid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });

      sync = makeSync();
      await sync.sync();

      const remotePrinter = await remoteDb.collection("printers").findOne({ name: "X1C" });
      expect(remotePrinter).not.toBeNull();
      const slotA = remotePrinter?.amsSlots?.find((s: { slotName: string }) => s.slotName === "A");
      expect(slotA.filamentId.toString()).toBe(remoteFilId.toString());
      // spoolId cleared on remap because no spool syncIds yet.
      expect(slotA.spoolId).toBeNull();

      const slotB = remotePrinter?.amsSlots?.find((s: { slotName: string }) => s.slotName === "B");
      // Empty slot stays empty.
      expect(slotB.filamentId).toBeNull();
      expect(slotB.spoolId).toBeNull();
    });

    it("clears amsSlots.filamentId when the filament doesn't exist on either side", async () => {
      const localDb = localClient.db("filament-db");

      // Printer with amsSlots.filamentId pointing at a filament that exists on
      // neither side — orphan. The repair pass should null it out.
      await localDb.collection("printers").insertOne({
        name: "Orphan",  manufacturer: "Test", printerModel: "X",
        installedNozzles: [], notes: "", buildVolume: { x: null, y: null, z: null },
        maxFlow: null, maxSpeed: null, enclosed: false, autoBedLevel: false,
        amsSlots: [{ slotName: "A", filamentId: new ObjectId(), spoolId: new ObjectId() }],
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });

      sync = makeSync();
      await sync.sync();

      // Local printer's stale slot should be cleared.
      const localPrinter = await localDb.collection("printers").findOne({ name: "Orphan" });
      expect(localPrinter?.amsSlots?.[0].filamentId).toBeNull();
      expect(localPrinter?.amsSlots?.[0].spoolId).toBeNull();
    });
  });

  // ── printhistories ────────────────────────────────────────────────────

  describe("printhistories", () => {
    it("syncs print history records, remapping printerId + usage.filamentId and clearing usage.spoolId", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");

      // Pre-seed matching printer + filament on both sides via syncId.
      const localPrinterId = new ObjectId();
      const remotePrinterId = new ObjectId();
      const printerDoc = {
        name: "Prusa", manufacturer: "Prusa", printerModel: "Mk3",
        installedNozzles: [], notes: "", buildVolume: { x: null, y: null, z: null },
        maxFlow: null, maxSpeed: null, enclosed: false, autoBedLevel: false,
        amsSlots: [],
        syncId: "p-syncid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      };
      await localDb.collection("printers").insertOne({ ...printerDoc, _id: localPrinterId });
      await remoteDb.collection("printers").insertOne({ ...printerDoc, _id: remotePrinterId });

      const localFilId = new ObjectId();
      const remoteFilId = new ObjectId();
      const filDoc = {
        name: "Used PLA", vendor: "Test", type: "PLA", color: "#fff",
        diameter: 1.75, temperatures: {}, bedTypeTemps: [],
        compatibleNozzles: [], calibrations: [], spools: [], optTags: [], settings: {},
        syncId: "f-syncid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      };
      await localDb.collection("filaments").insertOne({ ...filDoc, _id: localFilId });
      await remoteDb.collection("filaments").insertOne({ ...filDoc, _id: remoteFilId });

      // Local-only print history record.
      await localDb.collection("printhistories").insertOne({
        jobLabel: "calibration_cube.3mf",
        printerId: localPrinterId,
        usage: [
          { filamentId: localFilId, spoolId: new ObjectId(), grams: 12.3 },
        ],
        startedAt: new Date(),
        source: "manual",
        notes: "",
        _deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sync = makeSync();
      const results = await sync.sync();
      expect(results.find((r) => r.collection === "printhistories")?.pushed).toBe(1);

      const remoteHistory = await remoteDb.collection("printhistories").findOne({ jobLabel: "calibration_cube.3mf" });
      expect(remoteHistory).not.toBeNull();
      expect(remoteHistory?.printerId.toString()).toBe(remotePrinterId.toString());
      expect(remoteHistory?.usage).toHaveLength(1);
      expect(remoteHistory?.usage?.[0].filamentId.toString()).toBe(remoteFilId.toString());
      expect(remoteHistory?.usage?.[0].spoolId).toBeNull(); // cleared per the comment
      expect(remoteHistory?.usage?.[0].grams).toBe(12.3);
    });

    it("drops usage entries whose filament can't be resolved on the target side", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");

      // Print history with a filamentId that has no match on the other side.
      await localDb.collection("printhistories").insertOne({
        jobLabel: "ghost.gcode",
        printerId: null,
        usage: [{ filamentId: new ObjectId(), spoolId: null, grams: 5 }],
        startedAt: new Date(),
        source: "manual",
        notes: "",
        _deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sync = makeSync();
      await sync.sync();

      const remoteHistory = await remoteDb.collection("printhistories").findOne({ jobLabel: "ghost.gcode" });
      expect(remoteHistory).not.toBeNull();
      // The unresolvable usage entry was dropped — better than persisting a
      // dangling pointer; the job ledger entry survives so the user still sees
      // the job ran.
      expect(remoteHistory?.usage).toHaveLength(0);
    });

    it("propagates a soft-deleted print history (tombstone) to the other side", async () => {
      // Hard-delete on one peer would let the other peer push the row
      // back on the next sync. The DELETE route now soft-deletes via
      // _deletedAt so syncCollection's tombstone path can carry the
      // deletion across.
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");

      const sharedSyncId = "ph-shared-syncid";
      const startedAt = new Date("2026-04-30T12:00:00Z");
      // Both sides have the row (state after a prior sync). The user
      // then unpublishes on local — soft-delete sets _deletedAt to a
      // value newer than the remote's updatedAt.
      await localDb.collection("printhistories").insertOne({
        jobLabel: "to-be-deleted",
        printerId: null,
        usage: [],
        startedAt,
        source: "manual",
        notes: "",
        syncId: sharedSyncId,
        _deletedAt: new Date(Date.now() + 1000), // newer than remote's updatedAt
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      await remoteDb.collection("printhistories").insertOne({
        jobLabel: "to-be-deleted",
        printerId: null,
        usage: [],
        startedAt,
        source: "manual",
        notes: "",
        syncId: sharedSyncId,
        _deletedAt: null,
        createdAt: startedAt,
        updatedAt: startedAt,
      });

      sync = makeSync();
      await sync.sync();

      const remoteRow = await remoteDb.collection("printhistories").findOne({ syncId: sharedSyncId });
      expect(remoteRow).not.toBeNull();
      // The tombstone propagated to the remote side instead of remote
      // pushing its still-active copy back over local.
      expect(remoteRow?._deletedAt).not.toBeNull();
    });
  });

  // ── sharedcatalogs ────────────────────────────────────────────────────

  describe("sharedcatalogs", () => {
    it("pushes a local-only shared catalog to remote", async () => {
      await localClient.db("filament-db").collection("sharedcatalogs").insertOne({
        slug: "abcdefghijkl",
        title: "My picks",
        description: "Tuned profiles",
        payload: { version: 1, createdAt: new Date().toISOString(), filaments: [], nozzles: [], printers: [], bedTypes: [] },
        expiresAt: null,
        viewCount: 0,
        _deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sync = makeSync();
      const results = await sync.sync();
      const sharedResult = results.find((r) => r.collection === "sharedcatalogs");
      expect(sharedResult?.pushed).toBe(1);

      const remote = await remoteClient.db("filament-db").collection("sharedcatalogs").findOne({ slug: "abcdefghijkl" });
      expect(remote?.title).toBe("My picks");
      expect(remote?.syncId).toBeTruthy();
    });

    it("propagates a soft-deleted (unpublished) shared catalog tombstone", async () => {
      // Same model as print-history above: the share unpublish route
      // now soft-deletes so peer sync stops resurrecting unpublished
      // links. Without _deletedAt, syncCollection would push the
      // still-active remote row back over local's tombstone-attempt.
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");

      const sharedSyncId = "sc-shared-syncid";
      const t0 = new Date("2026-04-30T12:00:00Z");
      await localDb.collection("sharedcatalogs").insertOne({
        slug: "shared-link",
        title: "Hidden",
        description: "",
        payload: { version: 1, createdAt: t0.toISOString(), filaments: [], nozzles: [], printers: [], bedTypes: [] },
        expiresAt: null,
        viewCount: 0,
        syncId: sharedSyncId,
        _deletedAt: new Date(Date.now() + 1000),
        createdAt: t0,
        updatedAt: t0,
      });
      await remoteDb.collection("sharedcatalogs").insertOne({
        slug: "shared-link",
        title: "Hidden",
        description: "",
        payload: { version: 1, createdAt: t0.toISOString(), filaments: [], nozzles: [], printers: [], bedTypes: [] },
        expiresAt: null,
        viewCount: 0,
        syncId: sharedSyncId,
        _deletedAt: null,
        createdAt: t0,
        updatedAt: t0,
      });

      sync = makeSync();
      await sync.sync();

      const remoteRow = await remoteDb.collection("sharedcatalogs").findOne({ syncId: sharedSyncId });
      expect(remoteRow?._deletedAt).not.toBeNull();
    });
  });
});

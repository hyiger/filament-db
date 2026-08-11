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
      await db.collection("filaments").createIndex(
        { name: 1 },
        { unique: true, partialFilterExpression: { _deletedAt: null } },
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

  // ── filaments name-collision reconciliation ───────────────────────────

  describe("filaments name reconciliation", () => {
    it("reconciles same-name filaments across DBs without tripping the partial-unique-name index", async () => {
      // Reproduces the v1.30.x E11000 cycle abort: both sides independently
      // created "PC Blend" with their own syncIds; without reconcileByName
      // for filaments, syncCollection's update path walks the new name into
      // the partial-unique-on-non-deleted `name` index and aborts the cycle.
      await localClient.db("filament-db").collection("filaments").insertOne({
        name: "PC Blend", manufacturer: "Local Co", type: "PC",
        syncId: "local-uuid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });
      await remoteClient.db("filament-db").collection("filaments").insertOne({
        name: "PC Blend", manufacturer: "Remote Co", type: "PC",
        syncId: "remote-uuid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });

      sync = makeSync();
      const results = await sync.sync();
      const filamentResult = results.find((r) => r.collection === "filaments");
      expect(filamentResult).toBeDefined();
      expect(filamentResult?.error).toBeUndefined();

      // Each side still has exactly one active row for the name (no E11000).
      const localCount = await localClient.db("filament-db").collection("filaments").countDocuments({ name: "PC Blend", _deletedAt: null });
      const remoteCount = await remoteClient.db("filament-db").collection("filaments").countDocuments({ name: "PC Blend", _deletedAt: null });
      expect(localCount).toBe(1);
      expect(remoteCount).toBe(1);

      // syncIds unified — local wins per the tie-break rule in reconcileByName.
      const localRow = await localClient.db("filament-db").collection("filaments").findOne({ name: "PC Blend" });
      const remoteRow = await remoteClient.db("filament-db").collection("filaments").findOne({ name: "PC Blend" });
      expect(localRow?.syncId).toBe("local-uuid");
      expect(remoteRow?.syncId).toBe("local-uuid");

      // And printhistories (which prerequisite-depend on filaments via trySync)
      // should not be skip-cascaded with a prerequisite-failed error.
      const phResult = results.find((r) => r.collection === "printhistories");
      expect(phResult?.error).toBeUndefined();
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
        name: "AMS PLA", vendor: "Test", type: "PLA", color: "#000000",
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
        name: "Used PLA", vendor: "Test", type: "PLA", color: "#ffffff",
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

  // ── _purged tombstone propagation ─────────────────────────────────────
  //
  // Codex flagged a P1 on PR #213: the original "permanently delete from
  // trash" path called `Filament.deleteOne`, but syncCollection pairs docs
  // by `syncId` and treats "remote has it, local doesn't" as a fresh
  // insert from remote. So a hard delete on one peer was getting
  // resurrected from the other side on the next sync cycle. The fix is a
  // `_purged: boolean` tombstone that the sync engine knows to propagate.

  describe("_purged tombstone propagation", () => {
    it("propagates a local _purged tombstone to the remote peer", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const t0 = new Date("2026-05-01T00:00:00Z");
      const purgedAt = new Date("2026-05-09T00:00:00Z");
      const syncId = "filament-purge-1";

      // Local: trashed and then permanently purged
      await localDb.collection("filaments").insertOne({
        _id: new ObjectId(),
        name: "Purged Locally",
        vendor: "T",
        type: "PLA",
        instanceId: "ffffffffff",
        syncId,
        _deletedAt: purgedAt,
        _purged: true,
        createdAt: t0,
        updatedAt: t0,
      });
      // Remote: still in the trash (not yet purged)
      await remoteDb.collection("filaments").insertOne({
        _id: new ObjectId(),
        name: "Purged Locally",
        vendor: "T",
        type: "PLA",
        instanceId: "eeeeeeeeee",
        syncId,
        _deletedAt: new Date("2026-05-08T00:00:00Z"),
        _purged: false,
        createdAt: t0,
        updatedAt: t0,
      });

      sync = makeSync();
      await sync.sync();

      const remoteRow = await remoteDb.collection("filaments").findOne({ syncId });
      expect(remoteRow?._purged).toBe(true);
    });

    it("propagates a remote _purged tombstone to the local peer", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const t0 = new Date("2026-05-01T00:00:00Z");
      const syncId = "filament-purge-2";

      await localDb.collection("filaments").insertOne({
        _id: new ObjectId(),
        name: "Purged Remotely",
        vendor: "T",
        type: "PLA",
        instanceId: "ffffffffff",
        syncId,
        _deletedAt: new Date("2026-05-08T00:00:00Z"),
        _purged: false,
        createdAt: t0,
        updatedAt: t0,
      });
      await remoteDb.collection("filaments").insertOne({
        _id: new ObjectId(),
        name: "Purged Remotely",
        vendor: "T",
        type: "PLA",
        instanceId: "eeeeeeeeee",
        syncId,
        _deletedAt: new Date("2026-05-09T00:00:00Z"),
        _purged: true,
        createdAt: t0,
        updatedAt: t0,
      });

      sync = makeSync();
      await sync.sync();

      const localRow = await localDb.collection("filaments").findOne({ syncId });
      expect(localRow?._purged).toBe(true);
    });

    it("leaves both sides alone when both are already purged", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const t0 = new Date("2026-05-01T00:00:00Z");
      const syncId = "filament-purge-3";

      const tombstone = {
        name: "Both Purged",
        vendor: "T",
        type: "PLA",
        syncId,
        _deletedAt: t0,
        _purged: true,
        createdAt: t0,
        updatedAt: t0,
      };
      await localDb.collection("filaments").insertOne({
        _id: new ObjectId(),
        instanceId: "1111111111",
        ...tombstone,
      });
      await remoteDb.collection("filaments").insertOne({
        _id: new ObjectId(),
        instanceId: "2222222222",
        ...tombstone,
      });

      sync = makeSync();
      const results = await sync.sync();
      const filamentResult = results.find((r) => r.collection === "filaments");
      // Neither side changed — no pushes/pulls/updates/deletes for this row
      expect(filamentResult).toBeDefined();
      // (other rows in the collection might bump these counters, so just
      // verify the rows are still purged on both sides rather than asserting
      // exact zeros)
      const localRow = await localDb.collection("filaments").findOne({ syncId });
      const remoteRow = await remoteDb.collection("filaments").findOne({ syncId });
      expect(localRow?._purged).toBe(true);
      expect(remoteRow?._purged).toBe(true);
    });

    it("a _purged tombstone wins over a remote update made after the local purge", async () => {
      // Edge case: user purges on local, then on remote (offline at the
      // time) someone edits the still-trashed filament — bumps updatedAt
      // past the purge timestamp. Last-write-wins on plain conflicts would
      // resurrect it. Purge is a stronger one-way signal and should win.
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const t0 = new Date("2026-05-01T00:00:00Z");
      const purgedAt = new Date("2026-05-08T00:00:00Z");
      const remoteEditAt = new Date("2026-05-09T00:00:00Z");
      const syncId = "filament-purge-4";

      await localDb.collection("filaments").insertOne({
        _id: new ObjectId(),
        name: "Purge Wins",
        vendor: "T",
        type: "PLA",
        instanceId: "1111111111",
        syncId,
        _deletedAt: purgedAt,
        _purged: true,
        createdAt: t0,
        updatedAt: purgedAt,
      });
      await remoteDb.collection("filaments").insertOne({
        _id: new ObjectId(),
        name: "Purge Wins",
        vendor: "T",
        type: "PLA",
        instanceId: "2222222222",
        syncId,
        _deletedAt: new Date("2026-05-07T00:00:00Z"),
        _purged: false,
        // Bumped after the purge but the purge still wins
        createdAt: t0,
        updatedAt: remoteEditAt,
      });

      sync = makeSync();
      await sync.sync();

      const remoteRow = await remoteDb.collection("filaments").findOne({ syncId });
      expect(remoteRow?._purged).toBe(true);
    });
  });

  // ── GH #511 — slim-diff fetch + hydrate ───────────────────────────────

  describe("#511 — slim diff + hydrate transfers the full body", () => {
    it("pushes a heavy local-only filament body (photoDataUrl) intact", async () => {
      // The diff loop reads only the slim projection, but the push must
      // still carry the full document — including the spool subfields
      // (photoDataUrl) the projection omits. This pins that the hydrate
      // step refetches the body before transfer.
      const bigPhoto = "data:image/png;base64," + "A".repeat(4096);
      await localClient.db("filament-db").collection("filaments").insertOne({
        _id: new ObjectId(),
        name: "Heavy Body",
        vendor: "T",
        type: "PLA",
        syncId: "heavy-1",
        spools: [{ label: "S1", totalWeight: 1000, photoDataUrl: bigPhoto }],
        usageHistory: [{ grams: 12, date: new Date("2026-05-01T00:00:00Z") }],
        _deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sync = makeSync();
      const results = await sync.sync();
      expect(results.find((r) => r.collection === "filaments")?.pushed).toBe(1);

      const remote = await remoteClient
        .db("filament-db")
        .collection("filaments")
        .findOne({ syncId: "heavy-1" });
      // Full body survived the slim-diff → hydrate → transfer path.
      expect(remote?.spools?.[0]?.photoDataUrl).toBe(bigPhoto);
      expect(remote?.spools?.[0]?.totalWeight).toBe(1000);
    });

    it("pulls a newer remote body intact on a last-write-wins update", async () => {
      const syncId = "heavy-lww";
      const older = new Date("2026-05-01T00:00:00Z");
      const newer = new Date("2026-05-10T00:00:00Z");
      await localClient.db("filament-db").collection("filaments").insertOne({
        _id: new ObjectId(), name: "LWW", vendor: "T", type: "PLA", syncId,
        spools: [{ label: "old", totalWeight: 500 }],
        _deletedAt: null, createdAt: older, updatedAt: older,
      });
      await remoteClient.db("filament-db").collection("filaments").insertOne({
        _id: new ObjectId(), name: "LWW", vendor: "T", type: "PLA", syncId,
        spools: [{ label: "new", totalWeight: 999, photoDataUrl: "data:image/png;base64,ZZZZ" }],
        _deletedAt: null, createdAt: older, updatedAt: newer,
      });

      sync = makeSync();
      await sync.sync();

      const local = await localClient.db("filament-db").collection("filaments").findOne({ syncId });
      // Remote was newer → pulled with its full body (incl. photoDataUrl).
      expect(local?.spools?.[0]?.totalWeight).toBe(999);
      expect(local?.spools?.[0]?.photoDataUrl).toBe("data:image/png;base64,ZZZZ");
    });
  });

  // ── GH #317 — conflict-resolution edge cases ──────────────────────────

  describe("#317 — conflict resolution", () => {
    it("a soft-delete wins over a same-millisecond remote update (no resurrection)", async () => {
      // The exact tie the bug hit: a row deleted locally at time T while
      // the remote copy's updatedAt is also T (a delete right after an
      // edit, equal-ms). Pre-fix the `>` comparison fell through to the
      // else branch and resurrected the row.
      const T = new Date("2026-01-01T12:00:00.000Z");
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");

      await localDb.collection("bedtypes").insertOne({
        name: "Tie Plate", material: "PEI", notes: "",
        syncId: "tie-syncid",
        _deletedAt: T, createdAt: T, updatedAt: T,
      });
      await remoteDb.collection("bedtypes").insertOne({
        name: "Tie Plate", material: "PEI", notes: "",
        syncId: "tie-syncid",
        _deletedAt: null, createdAt: T, updatedAt: T,
      });

      sync = makeSync();
      await sync.sync();

      // Delete must win the tie on BOTH sides — the row stays deleted.
      const localRow = await localDb.collection("bedtypes").findOne({ syncId: "tie-syncid" });
      const remoteRow = await remoteDb.collection("bedtypes").findOne({ syncId: "tie-syncid" });
      expect(localRow?._deletedAt).not.toBeNull();
      expect(remoteRow?._deletedAt).not.toBeNull();
    });

    it("a doc missing updatedAt does not stall the merge (NaN-safe)", async () => {
      // Pre-fix: `new Date(undefined).getTime()` is NaN, every
      // comparison is false, and the row never syncs. The local row has
      // a real updatedAt, the remote one has none — local must win and
      // propagate to remote.
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");

      await localDb.collection("bedtypes").insertOne({
        name: "NaN Plate", material: "LOCAL-WINS", notes: "",
        syncId: "nan-syncid",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });
      await remoteDb.collection("bedtypes").insertOne({
        name: "NaN Plate", material: "stale", notes: "",
        syncId: "nan-syncid",
        _deletedAt: null, createdAt: new Date(),
        // updatedAt intentionally absent
      });

      sync = makeSync();
      await sync.sync();

      // Local (the only side with a timestamp) wins — remote is updated.
      const remoteRow = await remoteDb.collection("bedtypes").findOne({ syncId: "nan-syncid" });
      expect(remoteRow?.material).toBe("LOCAL-WINS");
    });
  });

  // ── GH #1004 F3: whole-doc LWW copy must DROP un-pinned fields ─────────
  //
  // A last-write-wins copy used $set, which can only add/overwrite keys —
  // never remove one the source dropped. So when a variant override is
  // un-pinned (the #951/#969/#971 $unset flows leave a field absent so GH
  // #106 inheritance resumes), the stale value lingered on the peer. Worse:
  // the $set also copied the source's newer updatedAt onto the peer, leaving
  // the two sides content-divergent at an EQUAL timestamp — a state LWW can
  // never resolve (frozen forever). replaceOne copies the doc verbatim, so
  // the field is removed and the sides converge in one cycle.
  describe("LWW copies whole documents, dropping un-pinned fields (replaceOne) — GH #1004 F3", () => {
    it("drops a field the newer LOCAL side no longer carries (toRemote), then converges", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const older = new Date(Date.now() - 60_000);
      const newer = new Date();

      // Remote holds the pinned value; local is newer and has un-pinned it
      // (the field is simply absent — mirroring a variant-override $unset).
      await remoteDb.collection("nozzles").insertOne({
        name: "0.4 Brass", diameter: 0.4, pressureAdvance: 0.05,
        syncId: "noz-unpin", _deletedAt: null, createdAt: older, updatedAt: older,
      });
      await localDb.collection("nozzles").insertOne({
        name: "0.4 Brass", diameter: 0.4, // pressureAdvance intentionally absent
        syncId: "noz-unpin", _deletedAt: null, createdAt: older, updatedAt: newer,
      });

      sync = makeSync();
      const results = await sync.sync();
      expect(results.find((r) => r.collection === "nozzles")?.updated).toBe(1);

      // replaceOne copied the newer local doc verbatim — the field is GONE,
      // not retained (a $set update could only overwrite, never remove it).
      const remoteRow = await remoteDb.collection("nozzles").findOne({ syncId: "noz-unpin" });
      expect(remoteRow).toBeTruthy();
      expect(Object.hasOwn(remoteRow ?? {}, "pressureAdvance")).toBe(false);

      // The copy carried local's updatedAt, so a second cycle is an
      // equal-timestamp no-op AND the field stays gone. Pre-fix, $set left
      // remote still holding pressureAdvance at that same equal timestamp —
      // a divergence LWW could never resolve.
      const results2 = await sync.sync();
      expect(results2.find((r) => r.collection === "nozzles")?.updated).toBe(0);
      const remoteRow2 = await remoteDb.collection("nozzles").findOne({ syncId: "noz-unpin" });
      expect(Object.hasOwn(remoteRow2 ?? {}, "pressureAdvance")).toBe(false);
    });

    it("drops a field the newer REMOTE side no longer carries (toLocal)", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const older = new Date(Date.now() - 60_000);
      const newer = new Date();

      await localDb.collection("nozzles").insertOne({
        name: "0.6 Steel", diameter: 0.6, pressureAdvance: 0.03,
        syncId: "noz-unpin-r", _deletedAt: null, createdAt: older, updatedAt: older,
      });
      await remoteDb.collection("nozzles").insertOne({
        name: "0.6 Steel", diameter: 0.6, // pressureAdvance intentionally absent
        syncId: "noz-unpin-r", _deletedAt: null, createdAt: older, updatedAt: newer,
      });

      sync = makeSync();
      await sync.sync();

      const localRow = await localDb.collection("nozzles").findOne({ syncId: "noz-unpin-r" });
      expect(localRow).toBeTruthy();
      expect(Object.hasOwn(localRow ?? {}, "pressureAdvance")).toBe(false);
    });
  });

  // ── GH #1116: entity-name trim on both sync sides ────────────────────
  // The copy path is the raw driver, so it bypasses the `trim: true` setter.
  // An untrimmed name on a pre-upgrade peer would land here verbatim — and
  // Mongoose then can't find it by name at all, because a String schema
  // setter applies to QUERY values too.

  describe("contended renames are staged, not deadlocked (GH #1142)", () => {
    /**
     * The reported repro, verbatim, and it fails on `main`: two rows with the
     * SAME syncIds on both peers and their names SWAPPED. Whichever paired row
     * is copied first wants a name the other still holds, the partial-unique
     * `name` index rejects it, and reversing the order only changes which one
     * fails — the pair is a cycle.
     *
     * It is not transient. It repeats every cycle, and via `trySync` a failure
     * in a parent collection cascade-skips its dependents, so one swapped pair
     * stalls most of sync indefinitely.
     */
    it("resolves a cross-peer name SWAP instead of erroring forever", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const older = new Date(Date.now() - 60_000);
      const newer = new Date();

      await localDb.collection("bedtypes").insertMany([
        { name: "X", material: "PEI", syncId: "swap-a", _deletedAt: null, createdAt: older, updatedAt: newer },
        { name: "Y", material: "PEI", syncId: "swap-b", _deletedAt: null, createdAt: older, updatedAt: newer },
      ]);
      await remoteDb.collection("bedtypes").insertMany([
        { name: "Y", material: "PEI", syncId: "swap-a", _deletedAt: null, createdAt: older, updatedAt: older },
        { name: "X", material: "PEI", syncId: "swap-b", _deletedAt: null, createdAt: older, updatedAt: older },
      ]);

      sync = makeSync();
      const results = await sync.sync();

      // The collection completed instead of aborting on E11000.
      expect(results.find((r) => r.collection === "bedtypes")?.error).toBeUndefined();

      // Local is newer for both, so the remote adopts the swap...
      const a = await remoteDb.collection("bedtypes").findOne({ syncId: "swap-a" });
      const b = await remoteDb.collection("bedtypes").findOne({ syncId: "swap-b" });
      expect(a!.name).toBe("X");
      expect(b!.name).toBe("Y");

      // ...and no placeholder was left behind.
      const leftovers = await remoteDb
        .collection("bedtypes")
        .countDocuments({ name: { $regex: "^__sync-staging-" } });
      expect(leftovers).toBe(0);
    });

    /**
     * The unsatisfiable case: a row this pass is NOT moving already holds the
     * name. Staging cannot help, so it must be reported and BOTH peers left
     * alone — writing anyway would clobber a record the user still wants.
     */
    it("reports an unsatisfiable name conflict without clobbering the holder", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const older = new Date(Date.now() - 60_000);
      const newer = new Date();

      // Local renames its row to "Taken"; the remote already has a DIFFERENT,
      // unpaired row called "Taken" that this pass will not move.
      await localDb.collection("bedtypes").insertOne({
        name: "Taken", material: "PEI", syncId: "unsat-a",
        _deletedAt: null, createdAt: older, updatedAt: newer,
      });
      await remoteDb.collection("bedtypes").insertMany([
        { name: "Original", material: "PEI", syncId: "unsat-a", _deletedAt: null, createdAt: older, updatedAt: older },
        { name: "Taken", material: "PEI", syncId: "unsat-squatter", _deletedAt: null, createdAt: older, updatedAt: older },
      ]);

      sync = makeSync();
      await sync.sync();

      // The squatter is untouched — that is the point.
      const squatter = await remoteDb.collection("bedtypes").findOne({ syncId: "unsat-squatter" });
      expect(squatter!.name).toBe("Taken");
      // And no placeholder was stranded on it.
      const leftovers = await remoteDb
        .collection("bedtypes")
        .countDocuments({ name: { $regex: "^__sync-staging-" } });
      expect(leftovers).toBe(0);
    });
  });

  describe("purge zombies are repaired on BOTH peers before the trim (GH #1116)", () => {
    /**
     * A zombie (`_purged: true` with `_deletedAt: null`) is ACTIVE as far as
     * MongoDB is concerned, so it OCCUPIES the partial unique name index.
     * Nothing else repairs one on the remote: `SyncService.sync()` never calls
     * `dbConnect`, and `syncCollection`'s both-purged branch is a no-op.
     *
     * The trim deliberately refuses to let a hidden zombie GATE a sync (a user
     * cannot resolve a row the UI does not show), so a local `"X "` is free to
     * become `"X"` while a remote zombie still holds `"X"` — after which every
     * copy of that filament onto the remote fails E11000, permanently, taking
     * filaments and print-history down the dependency chain with it.
     */
    it("tombstones a REMOTE zombie so the local trim can be copied over", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();

      // Remote zombie squatting the name on the partial unique index.
      await remoteDb.collection("filaments").insertOne({
        name: "Zombie PLA", vendor: "V", type: "PLA",
        syncId: "zombie-remote", _purged: true, _deletedAt: null,
        spools: [], createdAt: now, updatedAt: now,
      });
      // Local row that trims INTO that name.
      await localDb.collection("filaments").insertOne({
        name: "Zombie PLA ", vendor: "V", type: "PLA",
        syncId: "victim-local", _deletedAt: null,
        spools: [], createdAt: now, updatedAt: now,
      });

      sync = makeSync();
      const results = await sync.sync();

      // The collection synced instead of erroring on a duplicate key.
      const filamentResult = results.find((r) => r.collection === "filaments");
      expect(filamentResult?.error).toBeUndefined();

      // The zombie got the tombstone it should always have had — so it no
      // longer occupies the active-name index — while staying purged.
      const zombie = await remoteDb
        .collection("filaments")
        .findOne({ syncId: "zombie-remote" });
      expect(zombie!._purged).toBe(true);
      expect(zombie!._deletedAt).not.toBeNull();

      // And the trimmed local row reached the remote under its clean name.
      const copied = await remoteDb
        .collection("filaments")
        .findOne({ syncId: "victim-local" });
      expect(copied!.name).toBe("Zombie PLA");
    });
  });

  describe("a SKIPPED trim collection copies paired rows only (GH #1116)", () => {
    /**
     * When the trim pass cannot establish a protective unique name index it
     * SKIPS the collection, and the gate then disables `reconcileByName` —
     * correctly, since that helper compares raw names and would fuse two
     * records that merely look alike.
     *
     * Disabling it WITHOUT restricting the copy is worse than not gating at
     * all: the pairing that used to fuse an identically-named pair no longer
     * happens, and the unpaired inserts manufacture the duplicate on the
     * target instead. Paired updates still flow so repairs propagate — which
     * is what stops this becoming the self-perpetuating freeze that blocking
     * the copy outright caused.
     */
    it("holds back the unpaired insert instead of manufacturing a duplicate", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();

      // Force the SKIP: replace the partial unique index with a NON-unique
      // one, which `hasUniqueNameIndex` rejects and `createIndex` conflicts
      // with, so the collection cannot be normalized.
      // Force a skip the index CONVERSION cannot repair. A non-unique
      // `name_1` alone is no longer enough — `replaceInadequateNameIndex`
      // upgrades it and the trim then succeeds. Duplicate ACTIVE names block
      // the replacement build, so the legacy index survives and the
      // collection is genuinely skipped, which is the state under test.
      for (const db of [localDb, remoteDb]) {
        await db.collection("bedtypes").dropIndexes().catch(() => {});
        await db.collection("bedtypes").createIndex({ name: 1 }, { name: "name_1" });
        await db.collection("bedtypes").insertMany([
          { name: "Blocker", material: "PEI", syncId: `blk-a-${db.databaseName}`, _deletedAt: null, createdAt: now, updatedAt: now },
          { name: "Blocker", material: "PEI", syncId: `blk-b-${db.databaseName}`, _deletedAt: null, createdAt: now, updatedAt: now },
        ]);
      }

      // Two DISTINCT records that render the same. Different syncIds, so they
      // are unpaired and reconcileByName is the only thing that could fuse
      // them — and it is (correctly) disabled for a skipped collection.
      await localDb.collection("bedtypes").insertOne({
        name: "Plate ", material: "PEI", syncId: "bt-local-only",
        _deletedAt: null, createdAt: now, updatedAt: now,
      });
      await remoteDb.collection("bedtypes").insertOne({
        name: "Plate", material: "PEI", syncId: "bt-remote-only",
        _deletedAt: null, createdAt: now, updatedAt: now,
      });

      try {
        sync = makeSync();
        await sync.sync();

        // Neither side gained the other's row: no duplicate was manufactured.
        // (2 blockers + its own 1 row on each side — and nothing copied over.)
        expect(await localDb.collection("bedtypes").countDocuments({ syncId: "bt-remote-only" })).toBe(0);
        expect(await remoteDb.collection("bedtypes").countDocuments({ syncId: "bt-local-only" })).toBe(0);
      } finally {
        // `finally`, not trailing statements: this test deliberately installs a
        // NON-unique name index, and on a failing assertion the trailing form
        // left it in place — which then broke an unrelated later test that
        // builds the real one. A test that corrupts shared state when it fails
        // makes every subsequent failure a red herring.
        for (const db of [localDb, remoteDb]) {
          await db.collection("bedtypes").dropIndexes().catch(() => {});
          await db.collection("bedtypes").createIndex(
            { name: 1 },
            { unique: true, partialFilterExpression: { _deletedAt: null } },
          ).catch(() => {});
        }
      }
    });

    /**
     * GH #1116 (Codex P1). Holding rows back is only half safe: a DEPENDENT
     * copied against the resulting partial mapping silently drops the
     * references it cannot resolve.
     *
     * Concretely, a spool's `locationId` becomes null on the target, the copy
     * carries the SOURCE timestamp, and the repair pass ignores null refs — so
     * syncing the held-back location on a later cycle never restores it. A
     * blocked cycle is recoverable; a nulled reference is not.
     */
    it("cascade-skips dependents instead of copying against a partial mapping", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();

      // Same as above: duplicate ACTIVE names block the index conversion, so
      // the collection is genuinely skipped rather than repaired.
      for (const db of [localDb, remoteDb]) {
        await db.collection("locations").dropIndexes().catch(() => {});
        await db.collection("locations").createIndex({ name: 1 }, { name: "name_1" });
        await db.collection("locations").insertMany([
          { name: "Blocker", kind: "shelf", syncId: `lblk-a-${db.databaseName}`, _deletedAt: null, createdAt: now, updatedAt: now },
          { name: "Blocker", kind: "shelf", syncId: `lblk-b-${db.databaseName}`, _deletedAt: null, createdAt: now, updatedAt: now },
        ]);
      }

      try {
        // An unpaired location, so the locations copy holds it back...
        const loc = await localDb.collection("locations").insertOne({
          name: "Shelf ", kind: "shelf", syncId: "loc-unpaired",
          _deletedAt: null, createdAt: now, updatedAt: now,
        });
        // ...and a filament whose spool references it.
        await localDb.collection("filaments").insertOne({
          name: "Ref PLA", vendor: "V", type: "PLA", syncId: "fil-ref",
          instanceId: "wsdep0001", _deletedAt: null, createdAt: now, updatedAt: now,
          spools: [{ totalWeight: 1000, locationId: loc.insertedId }],
        });

        sync = makeSync();
        const results = await sync.sync();

        // locations reports the hold-back...
        expect(results.find((r) => r.collection === "locations")?.error).toMatch(/held back/i);
        // ...and filaments cascade-skips on it rather than copying.
        expect(results.find((r) => r.collection === "filaments")?.error).toMatch(
          /prerequisite "locations"/i,
        );

        // The reference survives on the source — nothing was nulled.
        const src = await localDb.collection("filaments").findOne({ syncId: "fil-ref" });
        expect(String(src!.spools[0].locationId)).toBe(String(loc.insertedId));
        // And no half-mapped copy landed on the remote.
        expect(await remoteDb.collection("filaments").countDocuments({})).toBe(0);
      } finally {
        for (const db of [localDb, remoteDb]) {
          await db.collection("locations").dropIndexes().catch(() => {});
          await db.collection("locations").createIndex(
            { name: 1 },
            { unique: true, partialFilterExpression: { _deletedAt: null } },
          ).catch(() => {});
        }
      }
    });
  });

  describe("entity-name trim on both sync sides (GH #1116)", () => {
    it("normalizes names on BOTH DBs before copying, so nothing untrimmed transfers", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();

      // A pre-upgrade peer's untrimmed rows, written past the setter.
      await remoteDb.collection("locations").insertOne({
        name: "Drybox #9 ", kind: "drybox",
        syncId: "loc-untrimmed-remote", _deletedAt: null, createdAt: now, updatedAt: now,
      });
      await localDb.collection("nozzles").insertOne({
        name: " 0.4 Trim Me", diameter: 0.4, type: "brass",
        syncId: "noz-untrimmed-local", _deletedAt: null, createdAt: now, updatedAt: now,
      });

      sync = makeSync();
      await sync.sync();

      // Normalized at the source…
      expect(
        (await remoteDb.collection("locations").findOne({ syncId: "loc-untrimmed-remote" }))!.name,
      ).toBe("Drybox #9");
      expect(
        (await localDb.collection("nozzles").findOne({ syncId: "noz-untrimmed-local" }))!.name,
      ).toBe("0.4 Trim Me");
      // …and therefore trimmed on the side each was copied TO, rather than
      // arriving as a second, unreachable record.
      expect(
        (await localDb.collection("locations").findOne({ syncId: "loc-untrimmed-remote" }))!.name,
      ).toBe("Drybox #9");
      expect(
        (await remoteDb.collection("nozzles").findOne({ syncId: "noz-untrimmed-local" }))!.name,
      ).toBe("0.4 Trim Me");
    });

    it("reconciles nozzles/printers made NEWLY equal by the trim, instead of E11000-ing", async () => {
      // Two peers holding "0.4 " and "0.4" under different syncIds both trim
      // successfully — and then syncCollection would insert one beside the
      // other, straight into the partial-unique name index. That E11000 isn't
      // a syncId collision, so it isn't swallowed: nozzles fail and printers,
      // filaments and print history cascade-skip on EVERY cycle.
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      for (const db of [localDb, remoteDb]) {
        await db
          .collection("nozzles")
          .createIndex({ name: 1 }, { unique: true, partialFilterExpression: { _deletedAt: null } });
        await db
          .collection("printers")
          .createIndex({ name: 1 }, { unique: true, partialFilterExpression: { _deletedAt: null } });
      }
      await localDb.collection("nozzles").insertOne({
        name: "0.4 Newly Equal ", diameter: 0.4, type: "brass",
        syncId: "noz-side-a", _deletedAt: null, createdAt: now, updatedAt: now,
      });
      await remoteDb.collection("nozzles").insertOne({
        name: "0.4 Newly Equal", diameter: 0.4, type: "brass",
        syncId: "noz-side-b", _deletedAt: null, createdAt: now, updatedAt: now,
      });
      await localDb.collection("printers").insertOne({
        name: "Equal Printer ", manufacturer: "P", printerModel: "M",
        syncId: "prn-side-a", _deletedAt: null, createdAt: now, updatedAt: now,
      });
      await remoteDb.collection("printers").insertOne({
        name: "Equal Printer", manufacturer: "P", printerModel: "M",
        syncId: "prn-side-b", _deletedAt: null, createdAt: now, updatedAt: now,
      });

      sync = makeSync();
      const results = await sync.sync();

      // The pair was UNIFIED onto one syncId, so the later sync treats it as
      // one row instead of inserting a second beside it.
      const localNoz = await localDb.collection("nozzles").findOne({ name: "0.4 Newly Equal" });
      const remoteNoz = await remoteDb.collection("nozzles").findOne({ name: "0.4 Newly Equal" });
      expect(localNoz!.syncId).toBe(remoteNoz!.syncId);
      const localPrn = await localDb.collection("printers").findOne({ name: "Equal Printer" });
      const remotePrn = await remoteDb.collection("printers").findOne({ name: "Equal Printer" });
      expect(localPrn!.syncId).toBe(remotePrn!.syncId);

      // Still one row per side, and neither collection reported a failure —
      // a nozzle failure cascade-skips printers, filaments and print history.
      expect(
        await localDb.collection("nozzles").countDocuments({ name: "0.4 Newly Equal" }),
      ).toBe(1);
      expect(
        await remoteDb.collection("nozzles").countDocuments({ name: "0.4 Newly Equal" }),
      ).toBe(1);
      for (const name of ["nozzles", "printers"]) {
        expect(results.find((r) => r.collection === name)?.error).toBeUndefined();
      }
    });

    it("REFUSES to RECONCILE a collection whose trim conflicted (Codex P1)", async () => {
      // The dangerous shape: local holds A="X" and B="X " (distinct rows), the
      // remote holds only B. The local trim can't touch B (it would collide
      // with A) but the remote trim succeeds, so the two sides now disagree
      // about which row is "X" — and reconcileByName would pair remote B with
      // local A by NAME and stamp A's syncId onto B, fusing two records into
      // one for LWW to then overwrite.
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      await localDb
        .collection("locations")
        .createIndex({ name: 1 }, { unique: true, partialFilterExpression: { _deletedAt: null } });
      await localDb.collection("locations").insertMany([
        { name: "Fuse Me", kind: "shelf", syncId: "loc-A", _deletedAt: null, createdAt: now, updatedAt: now },
        { name: "Fuse Me ", kind: "shelf", syncId: "loc-B", _deletedAt: null, createdAt: now, updatedAt: now },
      ]);
      await remoteDb.collection("locations").insertOne({
        name: "Fuse Me ", kind: "shelf", syncId: "loc-B", _deletedAt: null, createdAt: now, updatedAt: now,
      });

      sync = makeSync();
      const results = await sync.sync();

      // The collection reports a loud, retryable failure — the copy is NOT
      // gated any more, so the insert hits the unique index. That is the
      // recoverable outcome; what must never happen is the silent fusion
      // below.
      const loc = results.find((r) => r.collection === "locations");
      expect(loc?.error).toBeTruthy();
      // Crucially the two local rows keep their OWN identities: remote B was
      // not re-keyed onto local A.
      const a = await localDb.collection("locations").findOne({ syncId: "loc-A" });
      const b = await localDb.collection("locations").findOne({ syncId: "loc-B" });
      expect(a!.name).toBe("Fuse Me");
      expect(b!.name).toBe("Fuse Me ");
      const remoteB = await remoteDb.collection("locations").findOne({ name: "Fuse Me" });
      expect(remoteB!.syncId).toBe("loc-B");

      // This file shares its two mongods across tests, and the pair above is
      // deliberately UNRESOLVABLE — left behind it would keep `locations`
      // conflicted for every later test, cascade-skipping filaments and
      // print history. Clean it up rather than coupling the rest of the file
      // to this one's fixture.
      await localDb.collection("locations").deleteMany({ syncId: { $in: ["loc-A", "loc-B"] } });
      await remoteDb.collection("locations").deleteMany({ syncId: { $in: ["loc-A", "loc-B"] } });
    });

    it("a TOMBSTONE with an untrimmable name does not block the collection (Codex P1)", async () => {
      // A soft-deleted row whose name is only whitespace can never be
      // trimmed, can't collide in the partial active-name index, and isn't
      // reachable in the UI for a purged filament — gating on it would block
      // filament and print-history sync forever with no way out.
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      // A zombie exactly as Atlas can hold it: `_purged` set but NOT yet
      // tombstoned, because the remote never runs dbConnect's purgedZombies
      // migration (Codex P1 round 2 — the sync must not assume it ran).
      await localDb.collection("filaments").insertOne({
        name: "   ", vendor: "V", type: "PLA", spools: [],
        syncId: "fil-tombstone", _deletedAt: null, _purged: true, createdAt: now, updatedAt: now,
      });
      await remoteDb.collection("filaments").insertOne({
        name: "Syncs Fine", vendor: "V", type: "PLA", spools: [],
        syncId: "fil-normal", _deletedAt: null, createdAt: now, updatedAt: now,
      });

      sync = makeSync();
      const results = await sync.sync();

      // Asserted on the REASON, not on plain success: this file shares its
      // mongods, so an unrelated prerequisite could legitimately cascade-skip
      // filaments. What must never happen is filaments being blocked by the
      // whitespace gate itself.
      const filaments = results.find((r) => r.collection === "filaments");
      expect(filaments?.error ?? "").not.toContain("whitespace");
    });

    it("never re-pairs by NAME a row that already has a counterpart by syncId (Codex P1)", async () => {
      // The second-cycle trap. Asymmetric conflict resolved by renaming local
      // B "X " -> "Y": the trim now reports nothing, the gate lifts, and
      // reconcileByName runs BEFORE syncCollection has copied the rename.
      // Remote B still carries the trimmed "X", which matches local A — so a
      // name pairing would stamp A's syncId onto remote B and fuse two
      // distinct records.
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      await localDb.collection("locations").insertMany([
        { name: "Pair X", kind: "shelf", syncId: "pair-A", _deletedAt: null, createdAt: now, updatedAt: now },
        // The rename is NEWER than the remote copy — it is the edit the user
        // just made, and LWW needs that to be true to carry it across.
        { name: "Renamed Y", kind: "shelf", syncId: "pair-B", _deletedAt: null, createdAt: now, updatedAt: new Date(now.getTime() + 5000) },
      ]);
      // Remote holds only B, already trimmed to the name local A uses.
      const remoteBId = (
        await remoteDb.collection("locations").insertOne({
          name: "Pair X", kind: "shelf", syncId: "pair-B", _deletedAt: null, createdAt: now, updatedAt: now,
        })
      ).insertedId;

      // The remote's unique name index must be present, or the convergence
      // half of this test proves nothing.
      await remoteDb
        .collection("locations")
        .createIndex({ name: 1 }, { unique: true, partialFilterExpression: { _deletedAt: null } });

      sync = makeSync();
      const results = await sync.sync();

      // 1. No fusion. Asserted on the DOCUMENT, by _id — not on "some row with
      //    syncId pair-B exists", which the copy step recreates and which
      //    therefore passes even when the fusion happened.
      const remoteB = await remoteDb.collection("locations").findOne({ _id: remoteBId });
      expect(remoteB!.syncId).toBe("pair-B");
      const localA = await localDb.collection("locations").findOne({ syncId: "pair-A" });
      expect(localA!.name).toBe("Pair X");

      // 2. And the collection CONVERGES (Codex P1). Preventing the fusion is
      //    worth nothing if locations then fails on the unique index every
      //    cycle and filaments + print history stay cascade-skipped. The
      //    rename must reach the remote and A must land beside it.
      expect(results.find((r) => r.collection === "locations")?.error).toBeUndefined();
      expect(remoteB!.name).toBe("Renamed Y");
      expect(
        await remoteDb.collection("locations").findOne({ syncId: "pair-A" }),
      ).not.toBeNull();

      await localDb.collection("locations").deleteMany({ syncId: { $in: ["pair-A", "pair-B"] } });
      await remoteDb.collection("locations").deleteMany({ syncId: { $in: ["pair-A", "pair-B"] } });
    });

    it("an untrimmable pair does not stop UNRELATED names from reconciling (audit P1)", async () => {
      // The gate was keyed by COLLECTION while conflicts are per ROW, so one
      // whitespace pair disabled reconcileByName for every name in the
      // collection — including a genuinely unpaired same-name row created
      // independently on both peers, the v1.11.3 case that helper exists to
      // fix. Its insert then hit the unique name index, locations errored,
      // and filaments + print history cascade-skipped, every cycle, with the
      // surfaced error naming the innocent row.
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      for (const db of [localDb, remoteDb]) {
        await db
          .collection("locations")
          .createIndex({ name: 1 }, { unique: true, partialFilterExpression: { _deletedAt: null } });
      }
      // The untrimmable pair this PR targets…
      await localDb.collection("locations").insertMany([
        { name: "Blast Radius", kind: "shelf", syncId: "br-a", _deletedAt: null, createdAt: now, updatedAt: now },
        { name: "Blast Radius ", kind: "shelf", syncId: "br-b", _deletedAt: null, createdAt: now, updatedAt: now },
      ]);
      // …and a completely unrelated independently-created pair.
      await localDb.collection("locations").insertOne({
        name: "Innocent Shelf", kind: "shelf", syncId: "inn-local", _deletedAt: null, createdAt: now, updatedAt: now,
      });
      await remoteDb.collection("locations").insertOne({
        name: "Innocent Shelf", kind: "shelf", syncId: "inn-remote", _deletedAt: null, createdAt: now, updatedAt: now,
      });

      sync = makeSync();
      const results = await sync.sync();

      // The unrelated pair was unified, so no insert collided…
      const localInn = await localDb.collection("locations").findOne({ name: "Innocent Shelf" });
      const remoteInn = await remoteDb.collection("locations").findOne({ name: "Innocent Shelf" });
      expect(localInn!.syncId).toBe(remoteInn!.syncId);
      // …locations did not fail, so filaments and print history are not
      // cascade-skipped.
      expect(results.find((r) => r.collection === "locations")?.error).toBeUndefined();
      expect(results.find((r) => r.collection === "filaments")?.error).toBeUndefined();

      for (const db of [localDb, remoteDb]) {
        await db.collection("locations").deleteMany({
          syncId: { $in: ["br-a", "br-b", "inn-local", "inn-remote"] },
        });
      }
    });

    it("gates reconciliation but NOT the copy, so a fix can propagate", async () => {
      // The copy gate was self-perpetuating: in hybrid the app writes only to
      // the LOCAL database, so a user who does what the error says — rename
      // the duplicate — clears the local conflict while the REMOTE pair stays
      // active, and the collection is named on every later cycle. The one
      // thing that could propagate the fix is a syncId-keyed LWW copy of the
      // renamed row onto Atlas, which was exactly what was blocked.
      //
      // `reconcileByName` stays gated: it matches on the raw name and is the
      // only path that can fuse two distinct records (see the test above).
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      await remoteDb
        .collection("bedtypes")
        .createIndex({ name: 1 }, { unique: true, partialFilterExpression: { _deletedAt: null } });
      await remoteDb.collection("bedtypes").insertMany([
        { name: "Smooth PEI", material: "PEI", syncId: "bt-clean", _deletedAt: null, createdAt: now, updatedAt: now },
        { name: "Smooth PEI ", material: "PEI", syncId: "bt-clash", _deletedAt: null, createdAt: now, updatedAt: now },
      ]);
      await remoteDb.collection("nozzles").insertOne({
        name: "Unaffected 0.4", diameter: 0.4, type: "brass",
        syncId: "noz-unaffected", _deletedAt: null, createdAt: now, updatedAt: now,
      });

      sync = makeSync();
      const results = await sync.sync();

      // The colliding row is untouched…
      expect(
        (await remoteDb.collection("bedtypes").findOne({ syncId: "bt-clash" }))!.name,
      ).toBe("Smooth PEI ");
      // …but the COPY still ran, so both rows reached the other peer and a
      // later local fix has a route to Atlas.
      expect(
        await localDb.collection("bedtypes").findOne({ syncId: "bt-clash" }),
      ).not.toBeNull();
      // …and unrelated collections are entirely unaffected.
      expect(results.find((r) => r.collection === "nozzles")?.error).toBeUndefined();
      expect(
        await localDb.collection("nozzles").findOne({ syncId: "noz-unaffected" }),
      ).not.toBeNull();

      await remoteDb.collection("bedtypes").deleteMany({ syncId: { $in: ["bt-clean", "bt-clash"] } });
      await localDb.collection("bedtypes").deleteMany({ syncId: { $in: ["bt-clean", "bt-clash"] } });
    });
  });

  // ── GH #1021 (Codex P1 ×2 on #1022): legacyNozzleConditions cleanup ──
  // The remote (Atlas) DB never runs dbConnect's startup migrations, and on
  // first hybrid startup the sync can run BEFORE the local dbConnect does —
  // while the cleanup preserves updatedAt, so LWW would never propagate it.
  // sync() must therefore run the marker-guarded helper against BOTH DBs
  // before any collection sync.

  describe("legacyNozzleConditions cleanup on both sync sides (GH #1021)", () => {
    it("clears provenance-matched conditions on BOTH DBs exactly once; a later remote pin survives", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      // Earlier tests' sync() calls already completed the one-shot markers
      // against (empty) DBs — drop them so the cleanups attempt to run.
      for (const dbh of [localDb, remoteDb]) {
        await dbh.collection("_migrations").deleteOne({ _id: "legacyNozzleConditions" as never });
      }
      const now = new Date();
      // compatibleNozzles holds ObjectId REFS — each side's cleanup resolves
      // them against ITS OWN nozzles collection (the exporter's populate()).
      const rNoz04 = (await remoteDb.collection("nozzles").insertOne({
        name: "LNC r 0.4", diameter: 0.4, _deletedAt: null, createdAt: now, updatedAt: now,
      })).insertedId;
      const rNoz06 = (await remoteDb.collection("nozzles").insertOne({
        name: "LNC r 0.6", diameter: 0.6, _deletedAt: null, createdAt: now, updatedAt: now,
      })).insertedId;
      const rNoz08 = (await remoteDb.collection("nozzles").insertOne({
        name: "LNC r 0.8", diameter: 0.8, _deletedAt: null, createdAt: now, updatedAt: now,
      })).insertedId;
      const lNoz025 = (await localDb.collection("nozzles").insertOne({
        name: "LNC l 0.25", diameter: 0.25, _deletedAt: null, createdAt: now, updatedAt: now,
      })).insertedId;
      // Machine-derived on the REMOTE (stored equals the derivation from its
      // compatibleNozzles)…
      await remoteDb.collection("filaments").insertOne({
        name: "RemoteLegacy", vendor: "T", type: "PLA",
        compatibleNozzles: [rNoz06, rNoz04],
        settings: {
          compatible_printers_condition: "nozzle_diameter[0]==0.4 or nozzle_diameter[0]==0.6",
          cooling: "1",
        },
        syncId: "fil-remote-legacy", _deletedAt: null, createdAt: now, updatedAt: now,
      });
      // …and on the LOCAL side (the round-6 case: local sync starts before the
      // Next server's dbConnect migrations have run).
      await localDb.collection("filaments").insertOne({
        name: "LocalLegacy", vendor: "T", type: "PLA",
        compatibleNozzles: [lNoz025],
        settings: { compatible_printers_condition: "nozzle_diameter[0]==0.25" },
        syncId: "fil-local-legacy", _deletedAt: null, createdAt: now, updatedAt: now,
      });
      // A user pin whose ticks do NOT derive to it must survive the cleanup
      // AND the sync that follows.
      await remoteDb.collection("filaments").insertOne({
        name: "RemotePin", vendor: "T", type: "PLA",
        compatibleNozzles: [rNoz08],
        settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4" },
        syncId: "fil-remote-pin", _deletedAt: null, createdAt: now, updatedAt: now,
      });

      sync = makeSync();
      await sync.sync();

      const remoteAfter = await remoteDb.collection("filaments").findOne({ syncId: "fil-remote-legacy" });
      expect(remoteAfter!.settings.compatible_printers_condition).toBe("");
      expect(remoteAfter!.settings.cooling).toBe("1"); // sibling key untouched
      const localAfter = await localDb.collection("filaments").findOne({ syncId: "fil-local-legacy" });
      expect(localAfter!.settings.compatible_printers_condition).toBe("");
      // The cleared local doc propagated cleanly to the remote (no stale
      // machine value pushed back over the cleaned side).
      const localOnRemote = await remoteDb.collection("filaments").findOne({ syncId: "fil-local-legacy" });
      expect(localOnRemote!.settings.compatible_printers_condition).toBe("");
      const pinAfter = await remoteDb.collection("filaments").findOne({ syncId: "fil-remote-pin" });
      expect(pinAfter!.settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
      for (const dbh of [localDb, remoteDb]) {
        const marker = await dbh
          .collection("_migrations")
          .findOne({ _id: "legacyNozzleConditions" as never });
        expect(marker?.completed).toBe(true);
      }

      // A pure nozzle pin authored on the REMOTE after completion is textually
      // identical to the legacy values — the durable marker must keep every
      // later cycle from erasing it.
      await remoteDb.collection("filaments").updateOne(
        { syncId: "fil-remote-legacy" },
        { $set: { "settings.compatible_printers_condition": "nozzle_diameter[0]==0.4", updatedAt: new Date(Date.now() + 1000) } },
      );
      await sync.sync();
      const after2 = await remoteDb.collection("filaments").findOne({ syncId: "fil-remote-legacy" });
      expect(after2!.settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
    });

    it("strips a stale machine condition IN TRANSIT after both markers completed (r17: mixed-version peer)", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      // Both sides' one-shot cleanups completed long ago.
      for (const dbh of [localDb, remoteDb]) {
        await dbh.collection("_migrations").deleteOne({ _id: "legacyNozzleConditions" as never });
        await dbh.collection("_migrations").insertOne({
          _id: "legacyNozzleConditions" as never,
          claimedAt: now,
          completed: true,
          processed: [],
        });
      }
      // An OLDER (pre-#1022) desktop edited a filament on the remote side and
      // its export/sync round-trip re-stamped the machine condition — the doc
      // is NEWER than the local counterpart, so LWW copies it toLocal.
      const rNoz = (await remoteDb.collection("nozzles").insertOne({
        name: "LNC t 0.4", diameter: 0.4, _deletedAt: null, syncId: "noz-t", createdAt: now, updatedAt: now,
      })).insertedId;
      await localDb.collection("nozzles").insertOne({
        name: "LNC t 0.4", diameter: 0.4, _deletedAt: null, syncId: "noz-t", createdAt: now, updatedAt: now,
      });
      await remoteDb.collection("filaments").insertOne({
        name: "TransitLegacy", vendor: "T", type: "PLA",
        compatibleNozzles: [rNoz],
        settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4", cooling: "1" },
        syncId: "fil-transit", _deletedAt: null, createdAt: now, updatedAt: new Date(now.getTime() + 5000),
      });
      // A remote PIN that does not match its ticks must ride through intact.
      await remoteDb.collection("filaments").insertOne({
        name: "TransitPin", vendor: "T", type: "PLA",
        compatibleNozzles: [rNoz],
        settings: { compatible_printers_condition: "nozzle_diameter[0]==0.8" },
        syncId: "fil-transit-pin", _deletedAt: null, createdAt: now, updatedAt: new Date(now.getTime() + 5000),
      });

      sync = makeSync();
      await sync.sync();

      // The copy landed VERBATIM (honest timestamps — nothing in-transit is
      // authoritative, r25), and the post-sync field-level pair-clear then
      // set the condition to "" on BOTH sides in the same cycle…
      const localCopy = await localDb.collection("filaments").findOne({ syncId: "fil-transit" });
      expect(localCopy!.settings.compatible_printers_condition).toBe("");
      expect(localCopy!.settings.cooling).toBe("1"); // sibling key intact
      const remoteRow = await remoteDb.collection("filaments").findOne({ syncId: "fil-transit" });
      expect(remoteRow!.settings.compatible_printers_condition).toBe("");
      expect(remoteRow!.settings.cooling).toBe("1");
      // …with timestamps UNTOUCHED — the pair converges at the source's own
      // updatedAt, so no synthetic stamp can ever tie or outrun a real edit.
      expect(remoteRow!.updatedAt.getTime()).toBe(localCopy!.updatedAt.getTime());
      // …the non-matching pin rode through verbatim (both sides)…
      const localPin = await localDb.collection("filaments").findOne({ syncId: "fil-transit-pin" });
      expect(localPin!.settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.8");
      const remotePin = await remoteDb.collection("filaments").findOne({ syncId: "fil-transit-pin" });
      expect(remotePin!.settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.8");
      // …and the durable retry queue is empty (the pair converged in-cycle).
      const queue = await localDb.collection("_migrations").findOne({ _id: "legacyTransitClears" as never });
      expect(queue?.entries ?? []).toEqual([]);
    });

    it("drains a queued pair-clear left by a prior partial failure (r25 durable retry)", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      for (const dbh of [localDb, remoteDb]) {
        await dbh.collection("_migrations").deleteOne({ _id: "legacyNozzleConditions" as never });
        await dbh.collection("_migrations").insertOne({
          _id: "legacyNozzleConditions" as never,
          claimedAt: now,
          completed: true,
          processed: [],
        });
      }
      // The partial state a crashed prior cycle can leave: target already
      // cleared, source still stale, both at the SAME updatedAt (frozen for
      // plain LWW) — with the pending pairs durably queued, each carrying
      // its provenance (r26).
      const rNoz04 = (await remoteDb.collection("nozzles").insertOne({
        name: "LNC q 0.4", diameter: 0.4, _deletedAt: null, syncId: "noz-q04", createdAt: now, updatedAt: now,
      })).insertedId;
      const rNozDrift = (await remoteDb.collection("nozzles").insertOne({
        name: "LNC q drift", diameter: 0.8, _deletedAt: null, syncId: "noz-qdr", createdAt: now, updatedAt: now,
      })).insertedId;
      const ts = new Date(now.getTime() + 1000);
      for (const [syncId, name] of [["fil-queued", "QueuedPair"], ["fil-drift", "DriftPair"]] as const) {
        await localDb.collection("filaments").insertOne({
          name, vendor: "T", type: "PLA",
          settings: { compatible_printers_condition: "" },
          syncId, _deletedAt: null, createdAt: now, updatedAt: ts,
        });
        await remoteDb.collection("filaments").insertOne({
          name, vendor: "T", type: "PLA",
          settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4" },
          syncId, _deletedAt: null, createdAt: now, updatedAt: ts,
        });
      }
      await localDb.collection("_migrations").updateOne(
        { _id: "legacyTransitClears" as never },
        {
          $addToSet: {
            entries: {
              $each: [
                // Provenance still derives ==0.4 → replay clears the source.
                { d: "toLocal", s: "fil-queued", c: "nozzle_diameter[0]==0.4", u: ts, p: null, r: [rNoz04] },
                // Provenance DRIFTED since the enqueue (this nozzle is now
                // 0.8) → the replay must DROP the entry without clearing:
                // the surviving value is a possible user pin (r26).
                { d: "toLocal", s: "fil-drift", c: "nozzle_diameter[0]==0.4", u: ts, p: null, r: [rNozDrift] },
              ],
            },
          },
        },
        { upsert: true },
      );

      sync = makeSync();
      await sync.sync();

      // The verified pair was cleared (timestamps untouched)…
      const remoteRow = await remoteDb.collection("filaments").findOne({ syncId: "fil-queued" });
      expect(remoteRow!.settings.compatible_printers_condition).toBe("");
      expect(remoteRow!.updatedAt.getTime()).toBe(ts.getTime());
      const localQueued = await localDb.collection("filaments").findOne({ syncId: "fil-queued" });
      expect(localQueued!.settings.compatible_printers_condition).toBe("");
      // …the drifted-provenance pair kept its (possible pin) value on the
      // source AND had it RESTORED onto the partially-cleared side before
      // the entry was dropped (r27) — no frozen ""/pin divergence…
      const driftRow = await remoteDb.collection("filaments").findOne({ syncId: "fil-drift" });
      expect(driftRow!.settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
      const localDrift = await localDb.collection("filaments").findOne({ syncId: "fil-drift" });
      expect(localDrift!.settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
      expect(localDrift!.updatedAt.getTime()).toBe(ts.getTime());
      // …and both entries are dequeued (cleared vs reconciled-and-dropped).
      const queue = await localDb.collection("_migrations").findOne({ _id: "legacyTransitClears" as never });
      expect(queue?.entries ?? []).toEqual([]);
    });

    it("drains a pair-clear queued on the REMOTE db (r27: enqueue fallback survives service recreation)", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      for (const dbh of [localDb, remoteDb]) {
        await dbh.collection("_migrations").deleteOne({ _id: "legacyNozzleConditions" as never });
        await dbh.collection("_migrations").insertOne({
          _id: "legacyNozzleConditions" as never,
          claimedAt: now,
          completed: true,
          processed: [],
        });
      }
      const rNoz = (await remoteDb.collection("nozzles").insertOne({
        name: "LNC rq 0.4", diameter: 0.4, _deletedAt: null, syncId: "noz-rq", createdAt: now, updatedAt: now,
      })).insertedId;
      const ts = new Date(now.getTime() + 1000);
      await localDb.collection("filaments").insertOne({
        name: "RemoteQueued", vendor: "T", type: "PLA",
        settings: { compatible_printers_condition: "" },
        syncId: "fil-rqueued", _deletedAt: null, createdAt: now, updatedAt: ts,
      });
      await remoteDb.collection("filaments").insertOne({
        name: "RemoteQueued", vendor: "T", type: "PLA",
        settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4" },
        syncId: "fil-rqueued", _deletedAt: null, createdAt: now, updatedAt: ts,
      });
      // A cycle whose LOCAL enqueue failed fell back to the REMOTE queue —
      // and the service was recreated since. The drain must read it there.
      await remoteDb.collection("_migrations").updateOne(
        { _id: "legacyTransitClears" as never },
        { $addToSet: { entries: { d: "toLocal", s: "fil-rqueued", c: "nozzle_diameter[0]==0.4", u: ts, p: null, r: [rNoz] } } },
        { upsert: true },
      );

      sync = makeSync();
      await sync.sync();

      const remoteRow = await remoteDb.collection("filaments").findOne({ syncId: "fil-rqueued" });
      expect(remoteRow!.settings.compatible_printers_condition).toBe("");
      const remoteQueue = await remoteDb.collection("_migrations").findOne({ _id: "legacyTransitClears" as never });
      expect(remoteQueue?.entries ?? []).toEqual([]);
    });

    it("strips a PARENT-provenance transit row via the deferred post-sync revalidation (r22)", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      for (const dbh of [localDb, remoteDb]) {
        await dbh.collection("_migrations").deleteOne({ _id: "legacyNozzleConditions" as never });
        await dbh.collection("_migrations").insertOne({
          _id: "legacyNozzleConditions" as never,
          claimedAt: now,
          completed: true,
          processed: [],
        });
      }
      const rNoz = (await remoteDb.collection("nozzles").insertOne({
        name: "LNC dp 0.4", diameter: 0.4, _deletedAt: null, syncId: "noz-dp", createdAt: now, updatedAt: now,
      })).insertedId;
      // Parent (stable ticks) + inheriting child stamped from those ticks —
      // both only on the remote, both newer than (absent) local rows.
      const rParent = (await remoteDb.collection("filaments").insertOne({
        name: "DeferParent", vendor: "T", type: "PLA",
        compatibleNozzles: [rNoz],
        syncId: "fil-defer-parent", _deletedAt: null, createdAt: now, updatedAt: now,
      })).insertedId;
      await remoteDb.collection("filaments").insertOne({
        name: "DeferChild", vendor: "T", type: "PLA",
        compatibleNozzles: [], parentId: rParent,
        settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4", cooling: "1" },
        syncId: "fil-defer-child", _deletedAt: null, createdAt: now, updatedAt: now,
      });

      sync = makeSync();
      await sync.sync();

      // The deferred post-sync revalidation confirmed the CURRENT remote
      // parent still derives the condition → the field-level pair-clear set
      // it to "" on BOTH sides in the same cycle, timestamps untouched.
      const localChild = await localDb.collection("filaments").findOne({ syncId: "fil-defer-child" });
      expect(localChild!.settings.compatible_printers_condition).toBe("");
      expect(localChild!.settings.cooling).toBe("1");
      const remoteChild = await remoteDb.collection("filaments").findOne({ syncId: "fil-defer-child" });
      expect(remoteChild!.settings.compatible_printers_condition).toBe("");
      expect(remoteChild!.settings.cooling).toBe("1");
    });

    it("preserves a child condition when the SAME pass moved the parent's ticks away from it (r22 regression)", async () => {
      const localDb = localClient.db("filament-db");
      const remoteDb = remoteClient.db("filament-db");
      const now = new Date();
      for (const dbh of [localDb, remoteDb]) {
        await dbh.collection("_migrations").deleteOne({ _id: "legacyNozzleConditions" as never });
        await dbh.collection("_migrations").insertOne({
          _id: "legacyNozzleConditions" as never,
          claimedAt: now,
          completed: true,
          processed: [],
        });
      }
      // Nozzles exist on both sides with a shared syncId.
      await localDb.collection("nozzles").insertOne({
        name: "LNC r22 0.4", diameter: 0.4, _deletedAt: null, syncId: "noz-r22-04", createdAt: now, updatedAt: now,
      });
      const lNoz08 = (await localDb.collection("nozzles").insertOne({
        name: "LNC r22 0.8", diameter: 0.8, _deletedAt: null, syncId: "noz-r22-08", createdAt: now, updatedAt: now,
      })).insertedId;
      const rNoz04 = (await remoteDb.collection("nozzles").insertOne({
        name: "LNC r22 0.4", diameter: 0.4, _deletedAt: null, syncId: "noz-r22-04", createdAt: now, updatedAt: now,
      })).insertedId;
      await remoteDb.collection("nozzles").insertOne({
        name: "LNC r22 0.8", diameter: 0.8, _deletedAt: null, syncId: "noz-r22-08", createdAt: now, updatedAt: now,
      });
      // The parent exists on BOTH sides: the LOCAL copy is NEWER with ticks
      // moved to 0.8; the REMOTE copy still has the old 0.4 ticks. The same
      // pass will push local's 0.8 ticks onto the remote parent…
      await localDb.collection("filaments").insertOne({
        name: "R22Parent", vendor: "T", type: "PLA",
        compatibleNozzles: [lNoz08],
        syncId: "fil-r22-parent", _deletedAt: null, createdAt: now,
        updatedAt: new Date(now.getTime() + 10_000),
      });
      const rParent = (await remoteDb.collection("filaments").insertOne({
        name: "R22Parent", vendor: "T", type: "PLA",
        compatibleNozzles: [rNoz04],
        syncId: "fil-r22-parent", _deletedAt: null, createdAt: now, updatedAt: now,
      })).insertedId;
      // …while the REMOTE child (newer than absent-local) carries a condition
      // matching the parent's OLD 0.4 ticks. Under the settled state (parent
      // ticks 0.8) that condition is a PIN and must survive on both sides.
      await remoteDb.collection("filaments").insertOne({
        name: "R22Child", vendor: "T", type: "PLA",
        compatibleNozzles: [], parentId: rParent,
        settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4" },
        syncId: "fil-r22-child", _deletedAt: null, createdAt: now,
        updatedAt: new Date(now.getTime() + 5_000),
      });

      sync = makeSync();
      await sync.sync();

      // The pre-fix stale tick map would have judged the child against the
      // OLD 0.4 ticks and stripped it; the deferred revalidation reads the
      // parent AS IT NOW STANDS (0.8 after the pass) and preserves the pin.
      const localChild = await localDb.collection("filaments").findOne({ syncId: "fil-r22-child" });
      expect(localChild!.settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
      const remoteChild = await remoteDb.collection("filaments").findOne({ syncId: "fil-r22-child" });
      expect(remoteChild!.settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
      // Sanity: the parent's ticks DID converge to the newer 0.8 set.
      const remoteParent = await remoteDb.collection("filaments").findOne({ syncId: "fil-r22-parent" });
      expect(String(remoteParent!.compatibleNozzles[0])).toBe(String((await remoteDb.collection("nozzles").findOne({ syncId: "noz-r22-08" }))!._id));
    });
  });
});

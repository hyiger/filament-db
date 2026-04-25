import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import { SyncService } from "../electron/sync-service";

/**
 * GH #116 regression guard.
 *
 * Before the fix, SyncService only synced nozzles, printers, and filaments.
 * Locations (added in v1.11) had no syncCollection call, so:
 *   - A location created on a Docker instance never reached desktop apps
 *     running in hybrid mode.
 *   - A location created on a hybrid desktop never reached Atlas (and
 *     therefore never reached other instances).
 *   - Filaments did sync, but each spool's locationId was a local ObjectId
 *     that didn't exist on the target side.
 *
 * The fix adds locations as a synced collection AND extends the filament
 * transform to remap spools[].locationId through the syncId map. These tests
 * pin both behaviors against two independent in-memory MongoDB instances
 * standing in for the local and remote databases.
 */
describe("SyncService — locations and spool.locationId remap", () => {
  let localServer: MongoMemoryServer;
  let remoteServer: MongoMemoryServer;
  let localClient: MongoClient;
  let remoteClient: MongoClient;
  let sync: SyncService;

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
    // Reproduce Mongoose's partial-unique name index on locations so the
    // duplicate-name reconciliation tests actually exercise the constraint
    // SyncService is guarding against. Without this, raw insertOne calls
    // wouldn't trip E11000 even on conflicting names.
    for (const db of [localClient.db("filament-db"), remoteClient.db("filament-db")]) {
      await db.collection("locations").createIndex(
        { name: 1 },
        { unique: true, partialFilterExpression: { _deletedAt: null } },
      ).catch(() => {});
    }
  }, 120_000);

  afterEach(async () => {
    // Reset both databases between tests so syncId state from one test
    // doesn't bleed into the next.
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");
    for (const col of ["locations", "filaments", "nozzles", "printers"]) {
      await localDb.collection(col).deleteMany({}).catch(() => {});
      await remoteDb.collection(col).deleteMany({}).catch(() => {});
    }
    sync?.destroy();
  });

  function makeSync() {
    return new SyncService(localServer.getUri(), remoteServer.getUri());
  }

  it("pushes a local-only location up to the remote DB", async () => {
    const localDb = localClient.db("filament-db");
    await localDb.collection("locations").insertOne({
      name: "Drybox #1",
      kind: "drybox",
      humidity: 18,
      notes: "",
      _deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    sync = makeSync();
    const results = await sync.sync();

    const locationResult = results.find((r) => r.collection === "locations");
    expect(locationResult).toBeDefined();
    expect(locationResult?.pushed).toBe(1);

    const remoteDb = remoteClient.db("filament-db");
    const remoteLocation = await remoteDb.collection("locations").findOne({ name: "Drybox #1" });
    expect(remoteLocation).not.toBeNull();
    expect(remoteLocation?.kind).toBe("drybox");
    // The push assigned a syncId to the source row that should now exist on both sides.
    expect(remoteLocation?.syncId).toBeTruthy();
    const localLocation = await localDb.collection("locations").findOne({ name: "Drybox #1" });
    expect(localLocation?.syncId).toBe(remoteLocation?.syncId);
  });

  it("pulls a remote-only location down to the local DB", async () => {
    const remoteDb = remoteClient.db("filament-db");
    await remoteDb.collection("locations").insertOne({
      name: "Top shelf",
      kind: "shelf",
      humidity: null,
      notes: "made on Docker",
      _deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    sync = makeSync();
    const results = await sync.sync();
    expect(results.find((r) => r.collection === "locations")?.pulled).toBe(1);

    const localDb = localClient.db("filament-db");
    const local = await localDb.collection("locations").findOne({ name: "Top shelf" });
    expect(local).not.toBeNull();
    expect(local?.notes).toBe("made on Docker");
  });

  it("remaps spools[].locationId so the reference points at the target DB's location ObjectId", async () => {
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");

    // Seed the same location on both sides with a shared syncId so the maps
    // know they're the same row. The two ObjectIds intentionally differ —
    // that's the whole point of the remap.
    const sharedSyncId = "loc-shared-syncid";
    const localLocId = new ObjectId();
    const remoteLocId = new ObjectId();
    await localDb.collection("locations").insertOne({
      _id: localLocId, syncId: sharedSyncId,
      name: "Cabinet", kind: "cabinet", humidity: null, notes: "",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    await remoteDb.collection("locations").insertOne({
      _id: remoteLocId, syncId: sharedSyncId,
      name: "Cabinet", kind: "cabinet", humidity: null, notes: "",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });

    // Seed a filament locally whose spool references the *local* location ObjectId.
    await localDb.collection("filaments").insertOne({
      name: "Test PLA", vendor: "Test", type: "PLA",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      spools: [
        { _id: new ObjectId(), label: "Spool A", totalWeight: 1000, locationId: localLocId },
      ],
    });

    sync = makeSync();
    await sync.sync();

    // After sync the filament should have been pushed and its spool's
    // locationId rewritten to point at the *remote* location's ObjectId.
    const remoteFilament = await remoteDb.collection("filaments").findOne({ name: "Test PLA" });
    expect(remoteFilament).not.toBeNull();
    expect(remoteFilament?.spools).toHaveLength(1);
    const remoteSpoolLocId = remoteFilament!.spools[0].locationId;
    expect(remoteSpoolLocId).toBeInstanceOf(ObjectId);
    expect(remoteSpoolLocId.toString()).toBe(remoteLocId.toString());
    expect(remoteSpoolLocId.toString()).not.toBe(localLocId.toString());
  });

  it("clears spool.locationId to null when the source location doesn't exist on the target (no silent miswiring)", async () => {
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");

    // A local location that has NO counterpart on the remote (and won't get
    // synced in the same cycle for this test we soft-delete it so it's
    // excluded from the syncId map).
    const orphanLocId = new ObjectId();
    await localDb.collection("locations").insertOne({
      _id: orphanLocId, syncId: "orphan-loc",
      name: "Orphan", kind: "shelf", humidity: null, notes: "",
      _deletedAt: new Date(), // soft-deleted → excluded from the active-location map
      createdAt: new Date(), updatedAt: new Date(),
    });
    // Also delete-marked on the remote so the deletion stays on both sides.
    await remoteDb.collection("locations").insertOne({
      _id: new ObjectId(), syncId: "orphan-loc",
      name: "Orphan", kind: "shelf", humidity: null, notes: "",
      _deletedAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(),
    });

    await localDb.collection("filaments").insertOne({
      name: "Filament with orphan loc", vendor: "Test", type: "PLA",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      spools: [
        { _id: new ObjectId(), label: "Spool", totalWeight: 1000, locationId: orphanLocId },
      ],
    });

    sync = makeSync();
    await sync.sync();

    const remoteFilament = await remoteDb.collection("filaments").findOne({ name: "Filament with orphan loc" });
    expect(remoteFilament?.spools[0].locationId).toBeNull();
  });

  // Codex P1 follow-up to PR #118.
  it("reconciles same-name locations across DBs without tripping the unique-name index", async () => {
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");

    // Two locally-minted "Drybox #1" rows with different syncIds, exactly the
    // shape produced when v1.11.2 desktops independently created locations
    // before sync was added in v1.11.3. A naive insertOne push would throw
    // E11000 on the partial-unique name index and abort the whole sync cycle.
    await localDb.collection("locations").insertOne({
      _id: new ObjectId(), syncId: "local-syncid",
      name: "Drybox #1", kind: "drybox", humidity: 20, notes: "",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(Date.now() - 60_000),
    });
    await remoteDb.collection("locations").insertOne({
      _id: new ObjectId(), syncId: "remote-syncid",
      name: "Drybox #1", kind: "drybox", humidity: 25, notes: "",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });

    sync = makeSync();
    const results = await sync.sync();

    // Sync completes (didn't error) and locations collapsed to one row per side.
    expect(results.find((r) => r.collection === "locations")).toBeDefined();
    const localCount = await localDb.collection("locations").countDocuments({ name: "Drybox #1", _deletedAt: null });
    const remoteCount = await remoteDb.collection("locations").countDocuments({ name: "Drybox #1", _deletedAt: null });
    expect(localCount).toBe(1);
    expect(remoteCount).toBe(1);

    // Both sides now share the local syncId (local-wins tie-break).
    const local = await localDb.collection("locations").findOne({ name: "Drybox #1" });
    const remote = await remoteDb.collection("locations").findOne({ name: "Drybox #1" });
    expect(local?.syncId).toBe("local-syncid");
    expect(remote?.syncId).toBe("local-syncid");

    // Last-write-wins picked the newer (remote) row's payload across the merge.
    expect(local?.humidity).toBe(25);
    expect(remote?.humidity).toBe(25);
  });

  it("reconciles same-name locations when neither side has a syncId yet", async () => {
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");

    // Pre-sync state: both sides have a "Top shelf" with no syncId field at all
    // (i.e. created before sync was even thinking about locations).
    await localDb.collection("locations").insertOne({
      _id: new ObjectId(),
      name: "Top shelf", kind: "shelf", humidity: null, notes: "",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    await remoteDb.collection("locations").insertOne({
      _id: new ObjectId(),
      name: "Top shelf", kind: "shelf", humidity: null, notes: "",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });

    sync = makeSync();
    await sync.sync();

    const local = await localDb.collection("locations").findOne({ name: "Top shelf" });
    const remote = await remoteDb.collection("locations").findOne({ name: "Top shelf" });
    expect(local?.syncId).toBeTruthy();
    expect(remote?.syncId).toBeTruthy();
    expect(local?.syncId).toBe(remote?.syncId); // shared minted UUID
    // Still one row per side — no duplicate from the push.
    expect(await localDb.collection("locations").countDocuments({ name: "Top shelf" })).toBe(1);
    expect(await remoteDb.collection("locations").countDocuments({ name: "Top shelf" })).toBe(1);
  });

  // Codex P2 follow-up to PR #118.
  it("repairs filaments left with stale spool.locationId by pre-#116 syncs (equal updatedAt)", async () => {
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");

    // Same location on both sides, sharing a syncId — i.e. already reconciled.
    const sharedSyncId = "shared-loc";
    const localLocId = new ObjectId();
    const remoteLocId = new ObjectId();
    const sameTimestamp = new Date();
    await localDb.collection("locations").insertOne({
      _id: localLocId, syncId: sharedSyncId,
      name: "Drybox", kind: "drybox", humidity: null, notes: "",
      _deletedAt: null, createdAt: sameTimestamp, updatedAt: sameTimestamp,
    });
    await remoteDb.collection("locations").insertOne({
      _id: remoteLocId, syncId: sharedSyncId,
      name: "Drybox", kind: "drybox", humidity: null, notes: "",
      _deletedAt: null, createdAt: sameTimestamp, updatedAt: sameTimestamp,
    });

    // A filament that was synced by the *old* (pre-#116) code: identical
    // updatedAt on both sides, both pointing the spool at the LOCAL ObjectId.
    // The remote copy is dangling — that locationId doesn't exist on remote.
    // The new filament-sync transform won't touch this row because the equal
    // timestamps short-circuit syncCollection's "no action needed" path.
    const sharedFilamentSyncId = "shared-filament";
    await localDb.collection("filaments").insertOne({
      _id: new ObjectId(), syncId: sharedFilamentSyncId,
      name: "PLA Black", vendor: "Test", type: "PLA",
      _deletedAt: null, createdAt: sameTimestamp, updatedAt: sameTimestamp,
      spools: [{ _id: new ObjectId(), label: "Spool A", totalWeight: 1000, locationId: localLocId }],
    });
    await remoteDb.collection("filaments").insertOne({
      _id: new ObjectId(), syncId: sharedFilamentSyncId,
      name: "PLA Black", vendor: "Test", type: "PLA",
      _deletedAt: null, createdAt: sameTimestamp, updatedAt: sameTimestamp,
      spools: [{ _id: new ObjectId(), label: "Spool A", totalWeight: 1000, locationId: localLocId }],
    });

    sync = makeSync();
    await sync.sync();

    // Remote filament's spool should now point at the REMOTE location id,
    // not the leftover localLocId. (Local was already correct.)
    const remoteFilament = await remoteDb.collection("filaments").findOne({ syncId: sharedFilamentSyncId });
    expect(remoteFilament?.spools[0].locationId.toString()).toBe(remoteLocId.toString());
    expect(remoteFilament?.spools[0].locationId.toString()).not.toBe(localLocId.toString());

    const localFilament = await localDb.collection("filaments").findOne({ syncId: sharedFilamentSyncId });
    expect(localFilament?.spools[0].locationId.toString()).toBe(localLocId.toString());
  });

  it("clears spool.locationId to null when the dangling reference has no syncId match anywhere", async () => {
    const remoteDb = remoteClient.db("filament-db");

    // No locations at all on either side — but a remote filament still
    // carries an arbitrary locationId from some long-deleted row.
    const orphanId = new ObjectId();
    await remoteDb.collection("filaments").insertOne({
      _id: new ObjectId(),
      name: "PLA w/ orphan ref", vendor: "Test", type: "PLA",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      spools: [{ _id: new ObjectId(), label: "Spool", totalWeight: 1000, locationId: orphanId }],
    });

    sync = makeSync();
    await sync.sync();

    const remoteFilament = await remoteDb.collection("filaments").findOne({ name: "PLA w/ orphan ref" });
    expect(remoteFilament?.spools[0].locationId).toBeNull();
  });

  // Codex P1 follow-up to PR #119 — guards against data loss in the repair pass.
  it("repair pass preserves updatedAt so subsequent filament sync respects real edit recency", async () => {
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");

    // Reconciled location on both sides (different ObjectIds, shared syncId).
    const sharedLocSyncId = "shared-loc";
    const localLocId = new ObjectId();
    const remoteLocId = new ObjectId();
    await localDb.collection("locations").insertOne({
      _id: localLocId, syncId: sharedLocSyncId,
      name: "Drybox", kind: "drybox", humidity: null, notes: "",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    await remoteDb.collection("locations").insertOne({
      _id: remoteLocId, syncId: sharedLocSyncId,
      name: "Drybox", kind: "drybox", humidity: null, notes: "",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });

    // Setup: the user just edited filament F on LOCAL (newer updatedAt) — say
    // they bumped nozzle temp from 215 to 220. Local's spool happens to be
    // already correct.
    // REMOTE has the older snapshot of F (nozzle 215) AND a dangling
    // spool.locationId (carries localLocId from some pre-#116 sync).
    //
    // Pre-fix, the repair pass on remote bumped updatedAt to "now" — which
    // would have made remote *appear* newer than local at the filament-sync
    // step, pushing the stale nozzle=215 over local's correct nozzle=220.
    // Test asserts that doesn't happen.
    const sharedFilamentSyncId = "f-shared";
    const remoteOlderTime = new Date(Date.now() - 60_000);
    const localNewerTime = new Date();
    await localDb.collection("filaments").insertOne({
      _id: new ObjectId(), syncId: sharedFilamentSyncId,
      name: "PLA Black", vendor: "Test", type: "PLA",
      temperatures: { nozzle: 220 }, // user's recent edit
      _deletedAt: null, createdAt: remoteOlderTime, updatedAt: localNewerTime,
      spools: [{ _id: new ObjectId(), label: "Spool A", totalWeight: 1000, locationId: localLocId }],
    });
    await remoteDb.collection("filaments").insertOne({
      _id: new ObjectId(), syncId: sharedFilamentSyncId,
      name: "PLA Black", vendor: "Test", type: "PLA",
      temperatures: { nozzle: 215 }, // stale value
      _deletedAt: null, createdAt: remoteOlderTime, updatedAt: remoteOlderTime,
      // Dangling: points at LOCAL's location ObjectId, which doesn't exist on remote.
      spools: [{ _id: new ObjectId(), label: "Spool A", totalWeight: 1000, locationId: localLocId }],
    });

    sync = makeSync();
    await sync.sync();

    // Local's newer nozzle temp must win the merge — both sides should now
    // see 220, NOT remote's stale 215.
    const localF = await localDb.collection("filaments").findOne({ syncId: sharedFilamentSyncId });
    const remoteF = await remoteDb.collection("filaments").findOne({ syncId: sharedFilamentSyncId });
    expect(localF?.temperatures?.nozzle).toBe(220);
    expect(remoteF?.temperatures?.nozzle).toBe(220);

    // And the spool ref ends up correct on both sides via the filament push
    // transform (not via the repair, which never touched local at all).
    expect(localF?.spools[0].locationId.toString()).toBe(localLocId.toString());
    expect(remoteF?.spools[0].locationId.toString()).toBe(remoteLocId.toString());
  });

  // GH #128 — fresh hybrid install pulled all filaments but lost every
  // parent/child link. The transform's `localFilamentBySyncId` map was
  // built before the inserts, so on first sync every variant's parentId
  // remap returned undefined and got nulled.
  it("preserves parent/child links when a fresh-install pulls a parent + variant from remote", async () => {
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");

    // Remote has a parent and a variant referencing it. Local has nothing.
    const parentRemoteId = new ObjectId();
    const variantRemoteId = new ObjectId();
    const parentSyncId = "parent-sync";
    const variantSyncId = "variant-sync";

    await remoteDb.collection("filaments").insertOne({
      _id: parentRemoteId, syncId: parentSyncId,
      name: "Prusament PC Blend", vendor: "Prusament", type: "PC",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      parentId: null,
    });
    await remoteDb.collection("filaments").insertOne({
      _id: variantRemoteId, syncId: variantSyncId,
      name: "Prusament PC Blend — Galaxy Black", vendor: "Prusament", type: "PC",
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      parentId: parentRemoteId, // <- references remote's parent _id
    });

    sync = makeSync();
    await sync.sync();

    // Both filaments should now exist locally with DIFFERENT _ids than remote
    // (insertOne mints a fresh _id per side), but the variant's parentId must
    // still point at the local parent's _id — recovered by the post-sync
    // repair pass.
    const localParent = await localDb.collection("filaments").findOne({ syncId: parentSyncId });
    const localVariant = await localDb.collection("filaments").findOne({ syncId: variantSyncId });

    expect(localParent).not.toBeNull();
    expect(localVariant).not.toBeNull();
    expect(localParent!._id.toString()).not.toBe(parentRemoteId.toString()); // sanity: ids differ across DBs
    expect(localVariant!.parentId).not.toBeNull();
    expect(localVariant!.parentId.toString()).toBe(localParent!._id.toString());
  });

  it("does not overwrite a valid parentId that diverges from the remote (last-write-wins owns that)", async () => {
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");

    // Two parents, A and B. Local variant points at A, remote variant points at B.
    // The repair pass should leave local alone — divergence is a real edit and
    // belongs to syncCollection's last-write-wins comparison, not to repair.
    const parentASyncId = "parent-a";
    const parentBSyncId = "parent-b";
    const variantSyncId = "v-sync";
    const localParentAId = new ObjectId();
    const remoteParentAId = new ObjectId();
    const localParentBId = new ObjectId();
    const remoteParentBId = new ObjectId();
    const localVariantId = new ObjectId();
    const remoteVariantId = new ObjectId();

    for (const [db, parentAId, parentBId, variantId, variantParentId] of [
      [localDb, localParentAId, localParentBId, localVariantId, localParentAId],
      [remoteDb, remoteParentAId, remoteParentBId, remoteVariantId, remoteParentBId],
    ] as const) {
      await db.collection("filaments").insertOne({
        _id: parentAId, syncId: parentASyncId,
        name: "Parent A", vendor: "Test", type: "PLA",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
        parentId: null,
      });
      await db.collection("filaments").insertOne({
        _id: parentBId, syncId: parentBSyncId,
        name: "Parent B", vendor: "Test", type: "PLA",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
        parentId: null,
      });
      await db.collection("filaments").insertOne({
        _id: variantId, syncId: variantSyncId,
        name: "Variant", vendor: "Test", type: "PLA",
        _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
        parentId: variantParentId,
      });
    }

    sync = makeSync();
    await sync.sync();

    // After sync, the filament-sync syncCollection or repair shouldn't have
    // forced local's parentId to point at parentB. Whichever side's
    // updatedAt is newer wins — the test seeds equal timestamps so neither
    // wins; both should retain their original (valid) parentIds.
    const localVariant = await localDb.collection("filaments").findOne({ syncId: variantSyncId });
    const remoteVariant = await remoteDb.collection("filaments").findOne({ syncId: variantSyncId });
    // Local variant's parentId resolves through the local map for parent A's syncId.
    const localParentAFresh = await localDb.collection("filaments").findOne({ syncId: parentASyncId });
    const remoteParentBFresh = await remoteDb.collection("filaments").findOne({ syncId: parentBSyncId });
    expect(localVariant!.parentId.toString()).toBe(localParentAFresh!._id.toString());
    expect(remoteVariant!.parentId.toString()).toBe(remoteParentBFresh!._id.toString());
  });
});

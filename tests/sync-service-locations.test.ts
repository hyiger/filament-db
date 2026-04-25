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
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { SyncService } from "../electron/sync-service";

/**
 * GH #369: per-collection error isolation.
 *
 * Pre-fix, the entire 7-collection sync was wrapped in a single try/catch.
 * If any one syncCollection call threw, the cycle aborted with no signal
 * about which collections did converge. These tests exercise the new
 * trySync wrapper that traps per-collection errors and surfaces them in
 * both the returned SyncResult[] and the SyncStatus state.
 */
describe("SyncService — per-collection error isolation (GH #369)", () => {
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

  afterEach(async () => {
    const localDb = localClient.db("filament-db");
    const remoteDb = remoteClient.db("filament-db");
    for (const col of ["bedtypes", "filaments", "locations", "nozzles", "printers", "printhistories", "sharedcatalogs"]) {
      await localDb.collection(col).deleteMany({}).catch(() => {});
      await remoteDb.collection(col).deleteMany({}).catch(() => {});
    }
    sync?.destroy();
    sync = null;
    vi.restoreAllMocks();
  });

  function makeSync() {
    return new SyncService(localServer.getUri(), remoteServer.getUri());
  }

  it("returns an errored SyncResult for the failing collection and lets others succeed", async () => {
    // Seed a nozzle on local so the nozzle sync has real work to do
    // (the success path needs to actually push something to prove it ran).
    await localClient.db("filament-db").collection("nozzles").insertOne({
      name: "0.4 brass", diameter: 0.4, type: "brass", highFlow: false,
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });

    sync = makeSync();
    // Force the printers sync to throw — printers is upstream of filaments
    // and downstream of bedtypes, so isolating it proves both directions
    // continue to run independently.
    const realSync = (sync as unknown as {
      syncCollection: (...args: unknown[]) => Promise<unknown>;
    }).syncCollection.bind(sync);
    const spy = vi
      .spyOn(sync as unknown as { syncCollection: typeof realSync }, "syncCollection")
      .mockImplementation(async (...args: unknown[]) => {
        if (args[2] === "printers") {
          throw new Error("simulated transient printers sync failure");
        }
        return realSync(...args);
      });

    const results = await sync.sync();
    spy.mockRestore();

    // Every collection still produced a SyncResult — including the failed one.
    const byName = new Map(results.map(r => [r.collection, r]));
    expect(Array.from(byName.keys()).sort()).toEqual(
      ["bedtypes", "filaments", "locations", "nozzles", "printers", "printhistories", "sharedcatalogs"].sort(),
    );

    // Printers result carries the error; counters are zero.
    const printers = byName.get("printers")!;
    expect(printers.error).toMatch(/simulated transient printers sync failure/);
    expect(printers.pushed).toBe(0);
    expect(printers.pulled).toBe(0);

    // Upstream collection (nozzles) actually ran and pushed the seeded row.
    const nozzles = byName.get("nozzles")!;
    expect(nozzles.error).toBeFalsy();
    expect(nozzles.pushed).toBe(1);

    // Downstream collections that don't structurally depend on printers
    // for their existence (filaments will run, just with imperfect printer
    // remapping for any that referenced printers) still produced results
    // without errors.
    expect(byName.get("filaments")!.error).toBeFalsy();
    expect(byName.get("sharedcatalogs")!.error).toBeFalsy();

    // Status reports "partial" — recoverable, not the all-or-nothing red pill.
    expect(sync.getStatus().state).toBe("partial");
    expect(sync.getStatus().error).toMatch(/printers/);
  });

  it("uses state: 'error' when every collection fails", async () => {
    sync = makeSync();
    // Force every syncCollection call to throw — simulates a connection-
    // level failure that hits each collection identically (e.g. an Atlas
    // auth error). The user shouldn't see "partial" in that case; they
    // should see a hard error.
    vi.spyOn(
      sync as unknown as { syncCollection: (...args: unknown[]) => Promise<unknown> },
      "syncCollection",
    ).mockImplementation(async () => {
      throw new Error("simulated total failure");
    });

    const results = await sync.sync();
    expect(results.every(r => r.error)).toBe(true);
    expect(sync.getStatus().state).toBe("error");
  });

  it("stays at state: 'idle' when all seven collections succeed", async () => {
    sync = makeSync();
    const results = await sync.sync();

    expect(results).toHaveLength(7);
    expect(results.every(r => !r.error)).toBe(true);
    expect(sync.getStatus().state).toBe("idle");
    expect(sync.getStatus().error).toBeNull();
  });
});

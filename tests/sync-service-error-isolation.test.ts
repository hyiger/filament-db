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

  it("returns an errored SyncResult for the failing collection and lets independent ones succeed", async () => {
    // Seed a nozzle on local so the nozzle sync has real work to do
    // (the success path needs to actually push something to prove it ran).
    await localClient.db("filament-db").collection("nozzles").insertOne({
      name: "0.4 brass", diameter: 0.4, type: "brass", highFlow: false,
      _deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });

    sync = makeSync();
    // Force the printers sync to throw — printers is downstream of
    // nozzles/bedtypes and upstream of filaments/printhistories, so this
    // exercises both "upstream still runs" AND "downstream cascade-skips".
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

    // Printers result carries the direct error; counters are zero.
    const printers = byName.get("printers")!;
    expect(printers.error).toMatch(/simulated transient printers sync failure/);
    expect(printers.pushed).toBe(0);
    expect(printers.pulled).toBe(0);

    // Upstream collection (nozzles) actually ran and pushed the seeded row.
    const nozzles = byName.get("nozzles")!;
    expect(nozzles.error).toBeFalsy();
    expect(nozzles.pushed).toBe(1);

    // Independent collections (no dependency on printers) still ran clean.
    expect(byName.get("bedtypes")!.error).toBeFalsy();
    expect(byName.get("locations")!.error).toBeFalsy();
    expect(byName.get("sharedcatalogs")!.error).toBeFalsy();

    // Status reports "partial" — recoverable, not the all-or-nothing red pill.
    expect(sync.getStatus().state).toBe("partial");
    expect(sync.getStatus().error).toMatch(/printers/);
  });

  // GH #369 (Codex follow-up): when a syncCollection fails, every
  // downstream collection that consumes its syncId map must be SKIPPED
  // rather than run against a stale map. The remap transforms drop
  // unresolved refs to null — so a transient nozzle failure used to
  // become permanent ref loss on printers + filaments + printhistories
  // that referenced those nozzles.
  it("skips downstream collections when a prerequisite fails (prevents ref-loss cascade)", async () => {
    sync = makeSync();
    const realSync = (sync as unknown as {
      syncCollection: (...args: unknown[]) => Promise<unknown>;
    }).syncCollection.bind(sync);

    // Fail the nozzle sync. nozzles is a prerequisite (directly or
    // transitively) for printers, filaments, and printhistories — all
    // three must be skipped. bedtypes, locations, sharedcatalogs are
    // independent of nozzles → still run.
    vi.spyOn(
      sync as unknown as { syncCollection: typeof realSync },
      "syncCollection",
    ).mockImplementation(async (...args: unknown[]) => {
      if (args[2] === "nozzles") throw new Error("nozzle sync exploded");
      return realSync(...args);
    });

    const results = await sync.sync();
    const byName = new Map(results.map(r => [r.collection, r]));

    // Direct failure on the prerequisite.
    expect(byName.get("nozzles")!.error).toMatch(/nozzle sync exploded/);

    // Cascaded skips: error messages name the failing prerequisite so the
    // user can re-run the right thing.
    expect(byName.get("printers")!.error).toMatch(/skipped.*prerequisite.*nozzles/);
    expect(byName.get("filaments")!.error).toMatch(/skipped.*prerequisite.*nozzles/);
    expect(byName.get("printhistories")!.error).toMatch(/skipped.*prerequisite/);

    // Independent collections still synced — no cross-contamination.
    expect(byName.get("bedtypes")!.error).toBeFalsy();
    expect(byName.get("locations")!.error).toBeFalsy();
    expect(byName.get("sharedcatalogs")!.error).toBeFalsy();

    // Some succeeded, some failed → state is "partial".
    expect(sync.getStatus().state).toBe("partial");
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

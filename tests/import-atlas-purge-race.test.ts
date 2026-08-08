import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { NextRequest } from "next/server";
import { POST as importAtlas } from "@/app/api/filaments/import-atlas/route";
import Filament from "@/models/Filament";

// Same bypass as tests/import-atlas-legacy-condition.test.ts (GH #626):
// assertSafeMongoUri would reject the in-memory mongod's plain
// mongodb://127.0.0.1 URI; the guard has its own dedicated suite.
vi.mock("@/lib/mongoUriGuard", () => ({
  assertSafeMongoUri: vi.fn(async () => {}),
}));

/**
 * GH #1079 item 2 (GH #1004 F1 parity) — the Atlas import's resurrect path
 * checked `_purged: { $ne: true }` on the READ only. A permanent delete
 * landing between that read and the resurrect `updateOne` (the loop does
 * per-row remote round-trips, so the window is real) flipped
 * `_deletedAt: null` on a row whose `_purged: true` was just set — the
 * active-but-purged "zombie" every sibling importer already guards against
 * with a write-side re-check + fresh-create fallback
 * (`src/lib/importFilaments.ts`, `iniImportApply.ts`, the bambustudio bulk
 * route).
 */
describe("POST /api/filaments/import-atlas — purge race on resurrect (GH #1079)", () => {
  function remoteUri() {
    const parsed = new URL(
      (process.env.MONGODB_URI as string).replace("mongodb://", "http://"),
    );
    return `mongodb://${parsed.host}/atlas-purge-src`;
  }
  function postReq(body: unknown) {
    return new NextRequest("http://localhost/api/filaments/import-atlas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function seedRemote(name: string): Promise<ObjectId> {
    const client = await new MongoClient(remoteUri()).connect();
    try {
      const remoteId = new ObjectId();
      await client.db().collection("filaments").insertOne({
        _id: remoteId,
        name,
        vendor: "R",
        type: "PLA",
        density: 1.24,
        _deletedAt: null,
      });
      return remoteId;
    } finally {
      await client.close();
    }
  }

  beforeEach(async () => {
    const client = await new MongoClient(remoteUri()).connect();
    try {
      await client.db().dropDatabase();
    } finally {
      await client.close();
    }
    await Filament.deleteMany({ name: /^AtlasPurge / });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a FRESH doc (no zombie) when the tombstone is purged between the read and the resurrect write", async () => {
    // A trashed-but-not-purged local row — the resurrect candidate the
    // route's read-side filter still returns.
    const tombstone = await Filament.create({
      name: "AtlasPurge PLA",
      vendor: "L",
      type: "PLA",
    });
    await Filament.updateOne(
      { _id: tombstone._id },
      { $set: { _deletedAt: new Date() } },
    );

    const remoteId = await seedRemote("AtlasPurge PLA");

    // Simulate the race window: the route's soft-deleted lookup resolves the
    // pre-purge view of the row, and the ACTUAL permanent delete lands
    // before the route's updateOne fires. The real updateOne then runs its
    // `_purged: { $ne: true }` filter against the genuinely-purged row.
    const realFindOne = Filament.findOne.bind(Filament);
    vi.spyOn(Filament, "findOne").mockImplementation(((
      ...args: unknown[]
    ) => {
      const query = args[0] as Record<string, unknown> | undefined;
      const isResurrectLookup =
        query != null &&
        typeof query._deletedAt === "object" &&
        query._deletedAt !== null;
      if (!isResurrectLookup) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realFindOne as any)(...args);
      }
      return (async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = await (realFindOne as any)(...args);
        // The purge lands NOW — after the read, before the route's write.
        // Permanent delete keeps `_deletedAt` set (the partial-unique name
        // index reasoning the route relies on).
        await Filament.collection.updateOne(
          { _id: tombstone._id },
          { $set: { _purged: true } },
        );
        return doc;
      })();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const res = await importAtlas(
      postReq({ uri: remoteUri(), filamentIds: [String(remoteId)] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.updated).toBe(0);

    // The purged tombstone stays gone-forever: `_purged` intact, still
    // soft-deleted — NOT flipped back to active.
    const dead = await Filament.findById(tombstone._id).lean();
    expect(dead!._purged).toBe(true);
    expect(dead!._deletedAt).not.toBeNull();

    // The row was recreated FRESH from the remote data under a new _id.
    const active = await Filament.findOne({
      name: "AtlasPurge PLA",
      _deletedAt: null,
    }).lean();
    expect(active).not.toBeNull();
    expect(String(active!._id)).not.toBe(String(tombstone._id));
    expect(active!._purged).not.toBe(true);
    expect(active!.vendor).toBe("R");
    expect(active!.density).toBe(1.24);
  });

  it("still resurrects a plain trashed (non-purged) row in place (regression)", async () => {
    const tombstone = await Filament.create({
      name: "AtlasPurge Resurrect PLA",
      vendor: "L",
      type: "PLA",
    });
    await Filament.updateOne(
      { _id: tombstone._id },
      { $set: { _deletedAt: new Date() } },
    );

    const remoteId = await seedRemote("AtlasPurge Resurrect PLA");

    const res = await importAtlas(
      postReq({ uri: remoteUri(), filamentIds: [String(remoteId)] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.updated).toBe(1);

    const revived = await Filament.findById(tombstone._id).lean();
    expect(revived!._deletedAt).toBeNull();
    expect(revived!.vendor).toBe("R");
    expect(
      await Filament.countDocuments({ name: "AtlasPurge Resurrect PLA" }),
    ).toBe(1);
  });
});

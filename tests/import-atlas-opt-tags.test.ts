import { describe, it, expect, beforeEach, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { NextRequest } from "next/server";
import { POST as importAtlas } from "@/app/api/filaments/import-atlas/route";
import Filament from "@/models/Filament";

// Same bypass as tests/import-atlas-template-spools.test.ts (GH #626):
// assertSafeMongoUri would reject the in-memory mongod's plain
// mongodb://127.0.0.1 URI; the guard has its own dedicated suite.
vi.mock("@/lib/mongoUriGuard", () => ({
  assertSafeMongoUri: vi.fn(async () => {}),
}));

/**
 * GH #1227 — the Atlas import copies the OpenPrintTag numbering marker
 * EXPLICITLY (never the schema default: an absent marker on the source means
 * its rows await review), and ONLY together with the `optTags` array it
 * describes (Codex P2 r13 on PR #1228): a source row that omits `optTags`
 * leaves the local array in place, so its marker must stay too — copied
 * unconditionally, a tag-less source row marked verified stamped a same-name
 * local unreviewed legacy `[2]` as spec antibacterial with no review.
 */
describe("POST /api/filaments/import-atlas — optTagsSpec travels with optTags (GH #1227)", () => {
  function remoteUri() {
    const parsed = new URL((process.env.MONGODB_URI as string).replace("mongodb://", "http://"));
    return `mongodb://${parsed.host}/atlas-opt-tags-src`;
  }

  async function importRemote(doc: Record<string, unknown>) {
    const client = await new MongoClient(remoteUri()).connect();
    try {
      const _id = new ObjectId();
      await client.db().collection("filaments").insertOne({ _id, vendor: "R", type: "PLA", _deletedAt: null, ...doc });
      const res = await importAtlas(
        new NextRequest("http://localhost/api/filaments/import-atlas", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uri: remoteUri(), filamentIds: [String(_id)] }),
        }),
      );
      expect(res.status).toBe(200);
      return res.json();
    } finally {
      await client.close();
    }
  }

  const local = (name: string) => Filament.collection.findOne({ name, _deletedAt: null });

  /** A row the pre-v1.83 app saved: schema-shaped, marker absent. */
  async function createUnreviewed(doc: Record<string, unknown>) {
    const created = await Filament.create(doc);
    await Filament.collection.updateOne({ _id: created._id }, { $unset: { optTagsSpec: "" } });
    return created._id;
  }

  beforeEach(async () => {
    const client = await new MongoClient(remoteUri()).connect();
    try {
      await client.db().dropDatabase();
    } finally {
      await client.close();
    }
    await Filament.deleteMany({ name: /^Atlas / });
  });

  it("a source row WITHOUT optTags leaves the local unreviewed array AND its marker alone", async () => {
    await createUnreviewed({ name: "Atlas Legacy", vendor: "L", type: "PLA", optTags: [2], density: 1.24 });
    // The remote pass marked a tag-less source row verified (nothing to review there).
    const body = await importRemote({ name: "Atlas Legacy", optTagsSpec: true, density: 1.3 });
    expect(body.updated).toBe(1);
    const row = await local("Atlas Legacy");
    expect(row).toMatchObject({ optTags: [2], density: 1.3 }); // the allow-listed field moved, the array did not
    expect(row?.optTagsSpec).toBeUndefined(); // still the user's call on Data health
  });

  it("a source row WITH optTags carries its marker: true copies true, absent copies false — on create and on update", async () => {
    await importRemote({ name: "Atlas Spec", optTags: [20], optTagsSpec: true });
    expect(await local("Atlas Spec")).toMatchObject({ optTags: [20], optTagsSpec: true });

    await importRemote({ name: "Atlas Unmarked", optTags: [2] });
    expect(await local("Atlas Unmarked")).toMatchObject({ optTags: [2], optTagsSpec: false }); // never the schema default

    // A verified local row re-imported from an unmarked source array must
    // await review again: the array is the source's, so the marker is too.
    await Filament.create({ name: "Atlas Verified", vendor: "L", type: "PLA", optTags: [20] });
    const body = await importRemote({ name: "Atlas Verified", optTags: [2] });
    expect(body.updated).toBe(1);
    expect(await local("Atlas Verified")).toMatchObject({ optTags: [2], optTagsSpec: false });
  });

  it("a source row WITHOUT optTags creates a trivially-spec row under the schema default", async () => {
    const body = await importRemote({ name: "Atlas Plain", density: 1.2 });
    expect(body.created).toBe(1);
    expect(await local("Atlas Plain")).toMatchObject({ optTags: [], optTagsSpec: true });
  });
});

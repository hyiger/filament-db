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
 * GH #1213 — `secondaryColors` was missing from the Atlas import's
 * allow-list, so a coextruded filament (null primary, colors in
 * `secondaryColors`) imported with no colors at all, and a re-import left
 * the local row's old secondaries in place.
 */
describe("POST /api/filaments/import-atlas — secondaryColors (GH #1213)", () => {
  function remoteUri() {
    const parsed = new URL((process.env.MONGODB_URI as string).replace("mongodb://", "http://"));
    return `mongodb://${parsed.host}/atlas-secondary-src`;
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

  const local = (name: string) => Filament.findOne({ name, _deletedAt: null }).lean();

  beforeEach(async () => {
    const client = await new MongoClient(remoteUri()).connect();
    try {
      await client.db().dropDatabase();
    } finally {
      await client.close();
    }
    await Filament.deleteMany({ name: /^Atlas / });
  });

  it("creates a coextruded filament with its colors (the issue's case)", async () => {
    const body = await importRemote({
      name: "Atlas Dual",
      color: null,
      secondaryColors: ["#FF0000", "#0000FF"],
      optTags: [28],
      spools: [],
    });
    expect(body.created).toBe(1);
    expect(body.errors).toBeUndefined();
    const row = await local("Atlas Dual");
    expect(row!.color).toBeNull();
    expect(row!.secondaryColors).toEqual(["#FF0000", "#0000FF"]);
    expect(row!.optTags).toEqual([28]);
  });

  it("creates a gradient filament with its primary and secondaries", async () => {
    await importRemote({
      name: "Atlas Gradient",
      color: "#FF0000",
      secondaryColors: ["#00FF00", "#0000ff"],
      optTags: [27],
    });
    const row = await local("Atlas Gradient");
    expect(row!.color).toBe("#FF0000");
    expect(row!.secondaryColors).toEqual(["#00FF00", "#0000ff"]);
  });

  it("replaces a re-imported row's stale secondaries", async () => {
    await Filament.create({ name: "Atlas Dual", vendor: "L", type: "PLA", color: null, secondaryColors: ["#111111", "#222222"] });
    const body = await importRemote({ name: "Atlas Dual", color: null, secondaryColors: ["#FF0000", "#0000FF"] });
    expect(body.updated).toBe(1);
    expect((await local("Atlas Dual"))!.secondaryColors).toEqual(["#FF0000", "#0000FF"]);
  });

  it("clears the local secondaries on an explicit empty array", async () => {
    await Filament.create({ name: "Atlas Solid", vendor: "L", type: "PLA", secondaryColors: ["#111111"] });
    await importRemote({ name: "Atlas Solid", color: "#123456", secondaryColors: [] });
    expect((await local("Atlas Solid"))!.secondaryColors).toEqual([]);
  });

  it.each([
    ["absent", {}],
    ["null", { secondaryColors: null }],
    ["a string", { secondaryColors: "#FF0000" }],
  ])("leaves the local secondaries alone when the source field is %s", async (_label, extra) => {
    await Filament.create({ name: "Atlas Keep", vendor: "L", type: "PLA", secondaryColors: ["#111111"] });
    const body = await importRemote({ name: "Atlas Keep", color: "#123456", ...extra });
    expect(body.updated).toBe(1);
    expect((await local("Atlas Keep"))!.secondaryColors).toEqual(["#111111"]);
  });

  it("does not read an array with no valid entry as a clear", async () => {
    await Filament.create({ name: "Atlas Keep", vendor: "L", type: "PLA", secondaryColors: ["#111111"] });
    const body = await importRemote({ name: "Atlas Keep", secondaryColors: ["red", 42, { a: 1 }] });
    expect(body.updated).toBe(1);
    expect(body.errors).toEqual(["Atlas Keep: skipped 3 invalid or excess secondary color(s)"]);
    expect((await local("Atlas Keep"))!.secondaryColors).toEqual(["#111111"]);
  });

  it("keeps the valid entries, caps at five, and notes what it skipped", async () => {
    const body = await importRemote({
      name: "Atlas Many",
      color: null,
      secondaryColors: ["#000001", "nope", "#000002", "#000003", "#000004", "#000005", "#000006"],
    });
    expect(body.created).toBe(1);
    expect(body.errors).toEqual(["Atlas Many: skipped 2 invalid or excess secondary color(s)"]);
    expect((await local("Atlas Many"))!.secondaryColors).toEqual([
      "#000001",
      "#000002",
      "#000003",
      "#000004",
      "#000005",
    ]);
  });
});

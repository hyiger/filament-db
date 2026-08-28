import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  repairMalformedTombstones,
  isReadableTombstone,
  TOMBSTONE_COLLECTIONS,
  type MinimalTombstoneCollection,
} from "@/lib/malformedTombstones";

/**
 * GH #1152. The raw-driver `_deletedAt: ""` shape sits between the engine's
 * two classifications — outside the partial unique index, yet deleted to the
 * sync loop — and every reader had to be defended against it separately.
 * The repair removes the shape; these tests pin what it touches and, just as
 * load-bearing, what it leaves alone.
 */
describe("repairMalformedTombstones (GH #1152)", () => {
  const col = () => mongoose.connection.collection("bedtypes");
  const minimal = () => col() as unknown as MinimalTombstoneCollection;

  beforeEach(async () => {
    await col().deleteMany({});
  });

  it("stamps a raw _deletedAt:\"\" to EPOCH — the arithmetic-preserving choice", async () => {
    await col().insertOne({ name: "Broken", _deletedAt: "" });
    expect(await repairMalformedTombstones(minimal())).toBe(1);
    const row = await col().findOne({ name: "Broken" });
    // Epoch, not now: the engine already treated the unreadable value as time
    // zero (`readTimestamp(x) ?? 0`), so a live peer with any real updatedAt
    // still wins and resurrects. A fresh date would promote the malformed
    // tombstone into a delete that beats older live edits.
    expect(row?._deletedAt).toEqual(new Date(0));
  });

  it("repairs other unreadable shapes a raw write can produce", async () => {
    await col().insertMany([
      { name: "Text", _deletedAt: "not-a-date" },
      { name: "Obj", _deletedAt: { nested: true } },
      { name: "Bool", _deletedAt: true },
    ]);
    expect(await repairMalformedTombstones(minimal())).toBe(3);
    for (const name of ["Text", "Obj", "Bool"]) {
      expect((await col().findOne({ name }))?._deletedAt).toEqual(new Date(0));
    }
  });

  it("leaves every readable value alone — repairing those would CHANGE their LWW arithmetic", async () => {
    const real = new Date("2026-01-02T03:04:05.000Z");
    await col().insertMany([
      { name: "Active", _deletedAt: null },
      { name: "Missing" },
      { name: "RealDate", _deletedAt: real },
      { name: "IsoString", _deletedAt: "2026-01-02T03:04:05.000Z" },
      { name: "EpochNum", _deletedAt: 1735786800000 },
    ]);
    expect(await repairMalformedTombstones(minimal())).toBe(0);
    expect((await col().findOne({ name: "Active" }))?._deletedAt).toBeNull();
    expect((await col().findOne({ name: "RealDate" }))?._deletedAt).toEqual(real);
    expect((await col().findOne({ name: "IsoString" }))?._deletedAt).toBe(
      "2026-01-02T03:04:05.000Z",
    );
    expect((await col().findOne({ name: "EpochNum" }))?._deletedAt).toBe(1735786800000);
  });

  it("is idempotent — a repaired row no longer matches", async () => {
    await col().insertOne({ name: "Once", _deletedAt: "" });
    expect(await repairMalformedTombstones(minimal())).toBe(1);
    expect(await repairMalformedTombstones(minimal())).toBe(0);
  });

  it("does NOT normalize to null — that would resurrect the row into the unique index", async () => {
    // The rejected alternative, pinned: null would move the row back into the
    // partial unique name index mid-pass, where it can E11000 against an
    // active same-name row — the #1116 zombie failure mode — and silently
    // resurrect rows in the UI.
    await col().insertOne({ name: "StaysDead", _deletedAt: "" });
    await repairMalformedTombstones(minimal());
    const row = await col().findOne({ name: "StaysDead" });
    expect(row?._deletedAt).not.toBeNull();
    expect(row?._deletedAt).toBeInstanceOf(Date);
  });

  it("repairs a date-containing ARRAY — query-form $type would have hidden it (Codex P2)", async () => {
    // `$type: "date"` matches array ELEMENTS, so a `$not` exclusion dropped
    // `[new Date()]` from the scan while the engine still cannot read it.
    await col().insertOne({ name: "ArrayDate", _deletedAt: [new Date()] });
    expect(await repairMalformedTombstones(minimal())).toBe(1);
    expect((await col().findOne({ name: "ArrayDate" }))?._deletedAt).toEqual(new Date(0));
  });

  it("repairs a null-containing array — $nin has the same multikey trap $type did (Codex P2)", async () => {
    // `$nin: [null]` evaluates against array ELEMENTS, so `[null]` and
    // `[null, "bad"]` were excluded from the scan while the sync loop still
    // reads them as deleted and readTimestamp cannot parse them.
    await col().insertMany([
      { name: "NullArr", _deletedAt: [null] },
      { name: "MixedArr", _deletedAt: [null, "bad"] },
    ]);
    expect(await repairMalformedTombstones(minimal())).toBe(2);
    for (const name of ["NullArr", "MixedArr"]) {
      expect((await col().findOne({ name }))?._deletedAt).toEqual(new Date(0));
    }
  });

    it("repairs a BSON-regex value — implicit equality would loop forever (Codex P2)", async () => {
    // In query position a regex is a regex QUERY, which never matches the
    // regex-valued row: the conditional write would no-match every cycle and
    // the row would stay malformed forever. `$eq` compares it as a literal.
    await col().insertOne({ name: "RegexVal", _deletedAt: /not-a-date/ });
    expect(await repairMalformedTombstones(minimal())).toBe(1);
    expect((await col().findOne({ name: "RegexVal" }))?._deletedAt).toEqual(new Date(0));
    // And it stays repaired — the loop-forever shape is the regression.
    expect(await repairMalformedTombstones(minimal())).toBe(0);
  });

  it("conditions every write on the OBSERVED malformed value (Codex P1)", async () => {
    // The TOCTOU this pins: an API restore or snapshot replacement landing
    // between the repair's read and its write must NOT have its fresh value
    // overwritten — an _id-only filter would silently RE-DELETE a row the
    // user just restored. A double records what the repair actually sends.
    const ops: Array<{ updateOne: { filter: Record<string, unknown> } }> = [];
    const double = {
      find: () => ({
        toArray: async () => [
          { _id: "id1", _deletedAt: "" },
          { _id: "id2", _deletedAt: "garbage" },
        ],
      }),
      bulkWrite: async (operations: typeof ops) => {
        ops.push(...operations);
        return { modifiedCount: operations.length };
      },
    };
    expect(await repairMalformedTombstones(double as never)).toBe(2);
    // `$eq` wrapping is part of the contract: it is what keeps a BSON regex
    // or operator-shaped observed value a LITERAL rather than live query
    // syntax.
    expect(ops.map((o) => o.updateOne.filter)).toEqual([
      { _id: "id1", _deletedAt: { $eq: "" } },
      { _id: "id2", _deletedAt: { $eq: "garbage" } },
    ]);
  });

  it("a row that changed between read and write is left alone", async () => {
    // The live half of the same contract, against a real collection: seed the
    // malformed value, then simulate the concurrent restore by changing the
    // row before the (conditional) write would land. With the observed-value
    // filter the write no-matches; an _id-only filter would clobber it.
    await col().insertOne({ name: "Restored", _deletedAt: "" });
    const real = minimal();
    const raced: MinimalTombstoneCollection = {
      find: (f, o) => real.find(f, o),
      bulkWrite: async (operations) => {
        // The "restore" lands after the read, before the write.
        await col().updateOne({ name: "Restored" }, { $set: { _deletedAt: null } });
        return real.bulkWrite(operations);
      },
    };
    expect(await repairMalformedTombstones(raced)).toBe(0);
    expect((await col().findOne({ name: "Restored" }))?._deletedAt).toBeNull();
  });

  it("covers every synced collection in the constant", () => {
    expect([...TOMBSTONE_COLLECTIONS].sort()).toEqual(
      [
        "bedtypes",
        "filaments",
        "locations",
        "nozzles",
        "printers",
        "printhistories",
        "sharedcatalogs",
      ].sort(),
    );
  });
});

describe("isReadableTombstone mirrors readTimestamp's acceptance", () => {
  it("accepts what the engine can read", () => {
    expect(isReadableTombstone(null)).toBe(true);
    expect(isReadableTombstone(undefined)).toBe(true);
    expect(isReadableTombstone(new Date())).toBe(true);
    expect(isReadableTombstone("2026-01-01")).toBe(true);
    expect(isReadableTombstone(0)).toBe(true); // epoch number is legitimate (GH #317)
  });

  it("rejects what the engine cannot", () => {
    expect(isReadableTombstone("")).toBe(false);
    expect(isReadableTombstone("garbage")).toBe(false);
    expect(isReadableTombstone(NaN)).toBe(false);
    expect(isReadableTombstone(new Date(NaN))).toBe(false);
    expect(isReadableTombstone({})).toBe(false);
    expect(isReadableTombstone(true)).toBe(false);
  });
});

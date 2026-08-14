import { describe, it, expect } from "vitest";
import {
  type TrimNameConflict,
  scanTrimConflicts,
  TRIMMABLE_COLLECTIONS,
  EDGE_WHITESPACE_PATTERN,
  castNameLikeSchema,
  hasEdgeWhitespace,
  trimEntityNames,
  describeTrimResult,
  findTrimmedNameCollision,
  trimBlockedCount,
  type MinimalTrimDb,
} from "@/lib/trimEntityNames";

/**
 * A driver-shaped fake: one in-memory array per collection, with a unique
 * constraint on the ACTIVE names so the collision branch is exercised the way
 * the real partial index would exercise it.
 */
function makeDb(
  seed: Partial<
    Record<string, { _id: string; name?: unknown; _deletedAt?: unknown; _purged?: unknown }[]>
  >,
) {
  const store: Record<
    string,
    { _id: string; name?: unknown; _deletedAt?: unknown; _purged?: unknown }[]
  > = {};
  for (const c of TRIMMABLE_COLLECTIONS) store[c] = seed[c] ? [...seed[c]!] : [];

  const db: MinimalTrimDb = {
    collection(name: string) {
      const rows = store[name] ?? [];
      return {
        find(filter: Record<string, unknown>) {
          return {
            async toArray() {
              // The pre-write collision check queries by exact name.
              if (typeof filter.name === "string") {
                return rows.filter(
                  (r) => r.name === filter.name && (r._deletedAt ?? null) === null,
                );
              }
              const spec = (filter.name as { $regex: string }).$regex;
              const re = new RegExp(spec, "u");
              return rows.filter(
                (r) => typeof r.name === "string" && re.test(r.name),
              );
            },
          };
        },
        async updateOne(
          f: Record<string, unknown>,
          update: Record<string, unknown>,
        ) {
          const next = (update.$set as { name: string }).name;
          // Honour the conditional filter the helper now sends.
          const matched = rows.find(
            (r) => r._id === f._id && (f.name === undefined || r.name === f.name),
          );
          if (!matched) return { matchedCount: 0 };
          // Partial index: it covers ACTIVE rows only, so a trashed row is
          // neither constrained by it nor able to collide with one.
          const target = rows.find((r) => r._id === f._id);
          const targetActive = (target?._deletedAt ?? null) === null;
          if (
            targetActive &&
            rows.some(
              (r) =>
                r._id !== f._id &&
                r.name === next &&
                (r._deletedAt ?? null) === null,
            )
          ) {
            throw Object.assign(new Error("E11000 duplicate key error"), {
              code: 11000,
            });
          }
          if (target) target.name = next;
          return { matchedCount: 1 };
        },
      };
    },
  };
  return { db, store };
}

describe("hasEdgeWhitespace", () => {
  it("agrees with String.prototype.trim, which is what the schema setter uses", () => {
    expect(hasEdgeWhitespace("Drybox #1 ")).toBe(true);
    expect(hasEdgeWhitespace(" Drybox #1")).toBe(true);
    expect(hasEdgeWhitespace("Drybox #1")).toBe(false);
    // Interior whitespace is not edge whitespace — the name is legitimate.
    expect(hasEdgeWhitespace("Dry box  #1")).toBe(false);
    // trim() covers tabs, newlines and the Unicode space separators.
    expect(hasEdgeWhitespace("X\t")).toBe(true);
    expect(hasEdgeWhitespace("X\n")).toBe(true);
    expect(hasEdgeWhitespace(" X")).toBe(true);
  });
});

/** GH #1149 widened TrimNameConflict; this fills the identity fields for
 *  fixtures that only exercise collection/name/active. */
function asConflict(c: {
  collection: TrimNameConflict["collection"];
  name: string;
  active: boolean;
}): TrimNameConflict {
  return { ...c, id: "x", trimsTo: null, reason: "empty-name", collidesWith: null };
}

describe("scanTrimConflicts (GH #1149)", () => {
  /** One fixture per classification arm, shared with the migration run so
   *  the parity assertion sweeps every branch of the shared classifier. */
  const FIXTURES = {
    locations: [
      { _id: "l1", name: "Drybox #1" },
      { _id: "l2", name: "Drybox #1 " }, // collision with an active twin
    ],
    nozzles: [{ _id: "n1", name: "   " }], // whitespace-only
    filaments: [
      { _id: "z", name: "X", _deletedAt: null, _purged: true }, // hidden zombie
      { _id: "v", name: "X ", _deletedAt: null }, // clash vs zombie → inactive
      { _id: "t", name: " PLA", _deletedAt: null }, // trimmable → NOT a conflict
    ],
    printers: [{ _id: "p1", name: "  ", _deletedAt: "2026-01-01" }], // tombstoned
  };

  it("classifies exactly as the migration does (parity)", async () => {
    // Fresh copies — the migration MUTATES (it trims " PLA").
    const scanned = await scanTrimConflicts(makeDb(structuredClone(FIXTURES)).db);
    const migrated = await trimEntityNames(makeDb(structuredClone(FIXTURES)).db);
    expect(scanned).toEqual(migrated.conflicts);
    // And the fixture genuinely exercises all three shapes.
    expect(scanned.map((c) => c.reason).sort()).toEqual([
      "collision", "collision", "empty-name", "empty-name",
    ]);
    expect(scanned.some((c) => !c.active)).toBe(true);
  });

  it("matches the migration on an ordered MUTUAL-trim pair (no stored twin)", async () => {
    // " X" and "X " with no stored "X": the migration trims the FIRST and the
    // second then collides against the freshly-written "X" — a mid-pass
    // write a per-row classification can't see. The scan emulates the claim.
    const PAIR = {
      locations: [
        { _id: "m1", name: " X" },
        { _id: "m2", name: "X " },
      ],
    };
    const scanned = await scanTrimConflicts(makeDb(structuredClone(PAIR)).db);
    const migrated = await trimEntityNames(makeDb(structuredClone(PAIR)).db);
    expect(migrated.trimmed).toBe(1);
    expect(scanned).toEqual(migrated.conflicts);
    expect(scanned).toEqual([
      {
        collection: "locations", name: "X ", active: true,
        id: "m2", trimsTo: "X", reason: "collision",
        collidesWith: { id: "m1", name: "X" },
      },
    ]);
  });

  it("a hidden-zombie CLAIMER makes the pair's conflict inactive, like the real clash branch", async () => {
    // The zombie " Z" trims first (it is in the partial index, so its write
    // claims "Z" for the later clash check) but is invisible — so the later
    // row's conflict must be INACTIVE, exactly as the migration classifies
    // it via resolvableByAHuman.
    const PAIR = {
      filaments: [
        { _id: "z1", name: " Z", _deletedAt: null, _purged: true },
        { _id: "v1", name: "Z ", _deletedAt: null },
      ],
    };
    const scanned = await scanTrimConflicts(makeDb(structuredClone(PAIR)).db);
    const migrated = await trimEntityNames(makeDb(structuredClone(PAIR)).db);
    expect(scanned).toEqual(migrated.conflicts);
    expect(scanned).toEqual([
      {
        collection: "filaments", name: "Z ", active: false,
        id: "v1", trimsTo: "Z", reason: "collision",
        collidesWith: { id: "z1", name: "Z" },
      },
    ]);
  });

  it("performs zero writes and builds no index", async () => {
    const { db, store } = makeDb(structuredClone(FIXTURES));
    let writes = 0;
    const counting: MinimalTrimDb = {
      collection(name: string) {
        const real = db.collection(name);
        return {
          find: (f: Record<string, unknown>, o?: Record<string, unknown>) => real.find(f, o),
          updateOne: async () => {
            writes++;
            return {};
          },
          createIndex: async () => {
            writes++;
            return {};
          },
        };
      },
    };
    const conflicts = await scanTrimConflicts(counting);
    expect(conflicts.length).toBe(4);
    expect(writes).toBe(0);
    // The trimmable row is untouched — scanning must never repair.
    expect(store.filaments.find((r) => r._id === "t")?.name).toBe(" PLA");
  });
});

describe("trimEntityNames", () => {
  it("trims stored names across every collection", async () => {
    const { db, store } = makeDb({
      locations: [{ _id: "l1", name: "Drybox #1 " }],
      filaments: [{ _id: "f1", name: " PLA Basic" }],
      nozzles: [{ _id: "n1", name: "0.4 Brass\t" }],
      printers: [{ _id: "p1", name: "MK4 " }],
      bedtypes: [{ _id: "b1", name: " Textured PEI " }],
    });
    const res = await trimEntityNames(db);
    expect(res.trimmed).toBe(5);
    expect(res.conflicts).toEqual([]);
    expect(store.locations[0].name).toBe("Drybox #1");
    expect(store.filaments[0].name).toBe("PLA Basic");
    expect(store.bedtypes[0].name).toBe("Textured PEI");
  });

  it("is idempotent — a second run over a clean DB writes nothing", async () => {
    const { db } = makeDb({ locations: [{ _id: "l1", name: "Drybox #1 " }] });
    expect((await trimEntityNames(db)).trimmed).toBe(1);
    expect((await trimEntityNames(db)).trimmed).toBe(0);
  });

  it("leaves a colliding row ALONE and names it, rather than merging", async () => {
    // Merging is a human decision: a Location merge has to re-point every
    // spools[].locationId, a Filament merge has to reconcile two spool arrays.
    const { db, store } = makeDb({
      locations: [
        { _id: "l1", name: "Drybox #1" },
        { _id: "l2", name: "Drybox #1 " },
      ],
    });
    const res = await trimEntityNames(db);
    expect(res.trimmed).toBe(0);
    expect(res.conflicts).toEqual([
      {
        collection: "locations", name: "Drybox #1 ", active: true,
        id: "l2", trimsTo: "Drybox #1", reason: "collision",
        collidesWith: { id: "l1", name: "Drybox #1" },
      },
    ]);
    // Untouched — still visible and editable in the app.
    expect(store.locations[1].name).toBe("Drybox #1 ");
  });

  it("reports a whitespace-only name instead of writing an empty required field", async () => {
    const { db, store } = makeDb({ nozzles: [{ _id: "n1", name: "   " }] });
    const res = await trimEntityNames(db);
    expect(res.trimmed).toBe(0);
    expect(res.conflicts).toEqual([
      {
        collection: "nozzles", name: "   ", active: true,
        id: "n1", trimsTo: null, reason: "empty-name", collidesWith: null,
      },
    ]);
    expect(store.nozzles[0].name).toBe("   ");
  });

  it("honours _purged ONLY on filaments (Codex P2)", async () => {
    // Nozzle / Printer / BedType / Location don't declare `_purged`, so their
    // APIs expose rows on `_deletedAt: null` alone — a stray marker from
    // legacy or raw-synced data leaves the row VISIBLE, hence resolvable,
    // hence a legitimate gate. Treating it as hidden would let hybrid sync
    // proceed with two visible colliding names.
    const { db } = makeDb({
      locations: [
        { _id: "z", name: "Shelf", _deletedAt: null, _purged: true },
        { _id: "v", name: "Shelf ", _deletedAt: null },
      ],
    });
    const res = await trimEntityNames(db);
    expect(res.conflicts).toEqual([
      {
        collection: "locations", name: "Shelf ", active: true,
        id: "v", trimsTo: "Shelf", reason: "collision",
        collidesWith: { id: "z", name: "Shelf" },
      },
    ]);
  });

  it("a stray _purged on a NON-filament candidate still gates", async () => {
    const { db } = makeDb({
      nozzles: [{ _id: "n1", name: "  ", _deletedAt: null, _purged: true }],
    });
    const res = await trimEntityNames(db);
    expect(res.conflicts).toEqual([
      {
        collection: "nozzles", name: "  ", active: true,
        id: "n1", trimsTo: null, reason: "empty-name", collidesWith: null,
      },
    ]);
  });

  it("marks a clash against a hidden ZOMBIE as inactive too (Codex P1)", async () => {
    // Mirror of the case below: here the CANDIDATE is a visible active row
    // and the thing blocking it is an untombstoned purge zombie. Still a real
    // clash — the index covers it — but nothing a human can act on, since the
    // zombie isn't in the trash and the remote never runs the migration that
    // would repair it.
    const { db } = makeDb({
      filaments: [
        { _id: "z", name: "X", _deletedAt: null, _purged: true },
        { _id: "v", name: "X ", _deletedAt: null },
      ],
    });
    const res = await trimEntityNames(db);
    expect(res.trimmed).toBe(0);
    expect(res.conflicts).toEqual([
      {
        collection: "filaments", name: "X ", active: false,
        id: "v", trimsTo: "X", reason: "collision",
        // The zombie is the only clash, so it is named even though hidden.
        collidesWith: { id: "z", name: "X" },
      },
    ]);
  });

  it("still gates when a VISIBLE row is the one in the way", async () => {
    const { db } = makeDb({
      filaments: [
        { _id: "a", name: "X", _deletedAt: null },
        { _id: "b", name: "X ", _deletedAt: null },
      ],
    });
    const res = await trimEntityNames(db);
    expect(res.conflicts).toEqual([
      {
        collection: "filaments", name: "X ", active: true,
        id: "b", trimsTo: "X", reason: "collision",
        collidesWith: { id: "a", name: "X" },
      },
    ]);
  });

  it("marks a conflict on a PURGED-but-untombstoned row as inactive (Codex P1)", async () => {
    // An Atlas zombie: `_purged: true` with `_deletedAt` still null, because
    // the REMOTE never runs dbConnect and so never runs the purgedZombies
    // migration. Gating on it would block filament + print-history sync
    // permanently, with the row invisible in the UI.
    const { db } = makeDb({
      filaments: [{ _id: "f1", name: "  ", _purged: true, _deletedAt: null }],
    });
    const res = await trimEntityNames(db);
    expect(res.conflicts).toEqual([
      {
        collection: "filaments", name: "  ", active: false,
        id: "f1", trimsTo: null, reason: "empty-name", collidesWith: null,
      },
    ]);
  });

  it("marks a conflict on a SOFT-DELETED row as inactive (Codex P1)", async () => {
    // The hybrid sync gates on active conflicts only: a tombstone with an
    // untrimmable name is permanent, can't collide in the partial index, and
    // isn't visible for the user to fix — gating on it would block that
    // collection's sync forever.
    const { db } = makeDb({
      filaments: [{ _id: "f1", name: "   ", _deletedAt: "2026-01-01" }],
    });
    const res = await trimEntityNames(db);
    expect(res.conflicts).toEqual([
      {
        collection: "filaments", name: "   ", active: false,
        id: "f1", trimsTo: null, reason: "empty-name", collidesWith: null,
      },
    ]);
  });

  it("re-checks each candidate in JS — the Mongo regex is only a pre-filter", async () => {
    // A driver that over-matches (as a narrower/broader \s class can) must not
    // produce a self-rewrite loop: the JS check is the decision.
    const rows = [{ _id: "x1", name: "Clean" }];
    const db: MinimalTrimDb = {
      collection: () => ({
        find: () => ({ async toArray() { return rows; } }),
        async updateOne() {
          throw new Error("must not write");
        },
      }),
    };
    expect((await trimEntityNames(db)).trimmed).toBe(0);
  });

  it("skips a non-string name rather than throwing", async () => {
    const { db } = makeDb({});
    const rows = [{ _id: "x1", name: 42 }];
    const weird: MinimalTrimDb = {
      collection: () => ({
        find: () => ({ async toArray() { return rows; } }),
        async updateOne() {
          throw new Error("must not write");
        },
      }),
    };
    expect((await trimEntityNames(weird)).trimmed).toBe(0);
    expect((await trimEntityNames(db)).conflicts).toEqual([]);
  });

  it("rethrows a non-duplicate-key write failure", async () => {
    const db: MinimalTrimDb = {
      collection: () => ({
        find: () => ({ async toArray() { return [{ _id: "x", name: "A " }]; } }),
        async updateOne() {
          throw new Error("connection reset");
        },
      }),
    };
    await expect(trimEntityNames(db)).rejects.toThrow("connection reset");
  });

  it("recognizes a duplicate-key error that lost its .code", async () => {
    const db: MinimalTrimDb = {
      collection: () => ({
        find: () => ({ async toArray() { return [{ _id: "x", name: "A " }]; } }),
        async updateOne() {
          throw new Error("E11000 duplicate key error collection: test.locations");
        },
      }),
    };
    const res = await trimEntityNames(db);
    expect(res.conflicts).toHaveLength(TRIMMABLE_COLLECTIONS.length);
  });
});

describe("the fallback index check (Codex P1)", () => {
  /** A fake whose createIndex always conflicts, so the fallback path runs,
   *  and whose indexes() we control exactly. */
  function dbWithIndexes(indexes: Record<string, unknown>[]): MinimalTrimDb {
    return {
      collection: () => ({
        createIndex: async () => {
          throw Object.assign(new Error("IndexOptionsConflict"), { code: 85 });
        },
        indexes: async () => indexes,
        find: () => ({
          async toArray() {
            return [{ _id: "x", name: "Trim Me ", _deletedAt: null }];
          },
        }),
        async updateOne() {
          return { matchedCount: 1 };
        },
      }),
    };
  }

  it("accepts the LEGACY plain unique index — no filter, so it covers everything", async () => {
    const res = await trimEntityNames(dbWithIndexes([{ key: { name: 1 }, unique: true }]));
    expect(res.skipped).toEqual([]);
    expect(res.trimmed).toBeGreaterThan(0);
  });

  it("accepts the exact partial filter the models declare", async () => {
    const res = await trimEntityNames(
      dbWithIndexes([
        { key: { name: 1 }, unique: true, partialFilterExpression: { _deletedAt: null } },
      ]),
    );
    expect(res.skipped).toEqual([]);
  });

  it("refuses a NARROWER filter that misses rows with the field absent", async () => {
    const res = await trimEntityNames(
      dbWithIndexes([
        {
          key: { name: 1 },
          unique: true,
          partialFilterExpression: { _deletedAt: { $exists: true } },
        },
      ]),
    );
    expect(res.skipped).toHaveLength(TRIMMABLE_COLLECTIONS.length);
    expect(res.trimmed).toBe(0);
  });

  it("refuses a COMPOUND key — unique over the pair, not over the name", async () => {
    const res = await trimEntityNames(
      dbWithIndexes([{ key: { name: 1, kind: 1 }, unique: true }]),
    );
    expect(res.skipped).toHaveLength(TRIMMABLE_COLLECTIONS.length);
  });

  it("refuses a NON-unique name index", async () => {
    const res = await trimEntityNames(dbWithIndexes([{ key: { name: 1 } }]));
    expect(res.skipped).toHaveLength(TRIMMABLE_COLLECTIONS.length);
  });
});

describe("describeTrimResult", () => {
  it("says nothing when there was nothing to do", () => {
    expect(describeTrimResult({ trimmed: 0, conflicts: [], skipped: [], deferred: [] })).toBeNull();
  });

  it("logs an INACTIVE conflict too — it just doesn't gate anything", () => {
    // A soft-deleted row with an untrimmable name is permanent and harmless
    // (it can't collide in a partial index), so it must not block a sync —
    // but the log should still say it exists.
    const line = describeTrimResult({
      trimmed: 0,
      conflicts: [asConflict({ collection: "filaments", name: "  ", active: false })],
      skipped: [], deferred: [],
    });
    expect(line).toContain('filaments: "  "');
  });

  it("names every conflict, since the user has to resolve them by hand", () => {
    const line = describeTrimResult({
      trimmed: 2,
      conflicts: [asConflict({ collection: "locations", name: "Drybox #1 ", active: true })],
      skipped: [], deferred: [],
    });
    expect(line).toContain("trimmed 2");
    expect(line).toContain('locations: "Drybox #1 "');
  });

  it("names a SKIPPED collection loudly", () => {
    const line = describeTrimResult({
      trimmed: 0,
      conflicts: [],
      skipped: [{ collection: "locations", reason: "already has duplicate active names" }],
      deferred: [],
    });
    expect(line).toContain("SKIPPED locations");
    expect(line).toContain("duplicate active names");
  });

  it("reports trims alone", () => {
    expect(describeTrimResult({ trimmed: 3, conflicts: [], skipped: [], deferred: [] })).toContain("trimmed 3");
  });
});

describe("findTrimmedNameCollision", () => {
  it("finds two active rows that differ only by edge whitespace", () => {
    expect(
      findTrimmedNameCollision([{ name: "X" }, { name: "Y" }, { name: "X " }]),
    ).toEqual({ name: "X", indexes: [0, 2] });
  });

  it("ignores trashed rows — the name index is partial on _deletedAt: null", () => {
    // GH #213 name reuse depends on this: a trashed row is free to share a name.
    expect(
      findTrimmedNameCollision([
        { name: "X" },
        { name: "X ", _deletedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    ).toBeNull();
  });

  it("leaves a whitespace-only name to the required validator", () => {
    expect(findTrimmedNameCollision([{ name: " " }, { name: "  " }])).toBeNull();
  });

  it("ignores rows with no usable name", () => {
    expect(findTrimmedNameCollision([null, 7, { name: {} }, {}])).toBeNull();
  });

  it("casts a non-finite JSON number, which the String path stores verbatim", () => {
    // `JSON.parse("1e400")` yields Infinity, and Mongoose's String cast is
    // `value.toString()` — so it stores "Infinity". A Number.isFinite gate
    // skipped exactly that pair and let the E11000 happen after the wipe.
    expect(findTrimmedNameCollision([{ name: 1e400 }, { name: "Infinity " }])).toEqual({
      name: "Infinity",
      indexes: [0, 1],
    });
  });

  it("mirrors the Date cast when deciding which rows are ACTIVE (Codex P2)", () => {
    // Mongoose casts "" on a Date path to null, so this row inserts ACTIVE
    // and collides — while a raw `!= null` test reads it as deleted and
    // waves the pair through.
    expect(
      findTrimmedNameCollision([{ name: "X", _deletedAt: "" }, { name: "X " }]),
    ).toEqual({ name: "X", indexes: [0, 1] });
    // undefined and an omitted field are active too.
    expect(
      findTrimmedNameCollision([{ name: "Y", _deletedAt: undefined }, { name: "Y " }]),
    ).toEqual({ name: "Y", indexes: [0, 1] });
  });

  it("accepts an object with a MEANINGFUL toString, as the String cast does (Codex P2)", async () => {
    // Mongoose's String cast takes an ObjectId or a Date and rejects only
    // plain objects and arrays. Returning null for every object made this
    // helper disagree with the cast it mirrors — and the Atlas route then
    // looked up "", missed the local row, and E11000'd on create.
    const mongoose = (await import("mongoose")).default;
    const oid = new mongoose.Types.ObjectId();
    expect(castNameLikeSchema(oid)).toBe(String(oid));
    const d = new Date("2026-01-02T03:04:05.000Z");
    expect(castNameLikeSchema(d)).toBe(String(d));
    // …and still refuses the two Mongoose refuses.
    expect(castNameLikeSchema({ a: 1 })).toBeNull();
    expect(castNameLikeSchema(["Victim"])).toBeNull();
    expect(castNameLikeSchema(Object.create(null))).toBeNull();
  });

  it("mirrors the string-`_id` clause of Mongoose's castString (Codex P2)", async () => {
    // mongoose/lib/cast/string.js checks `typeof value?._id === "string"`
    // BEFORE the toString clause — the populated-doc case. It is reachable
    // from plain JSON, so it hits the snapshot precheck too: `{"_id": "X"}`
    // beside `"X "` both store as "X" and E11000 after the wipe.
    expect(castNameLikeSchema({ _id: "X" })).toBe("X");
    // It wins over the toString clause, exactly as in the source.
    expect(castNameLikeSchema({ _id: "X", toString: () => "Y" })).toBe("X");
    // A NON-string _id doesn't take that clause; the object then falls to
    // toString and, being a plain object, is refused.
    expect(castNameLikeSchema({ _id: 7 })).toBeNull();

    // And the array clause is `!Array.isArray`, not a toString comparison:
    // an object merely carrying the array method is not an array.
    const arrayish = { toString: Array.prototype.toString, length: 0 };
    expect(castNameLikeSchema(arrayish)).toBe(String(arrayish));

    // Sanity: the real caster agrees with all of the above.
    const mongoose = (await import("mongoose")).default;
    const Probe = mongoose.models.__CastProbe
      ?? mongoose.model("__CastProbe", new mongoose.Schema({ name: String }));
    for (const v of [{ _id: "X" }, { _id: "X", toString: () => "Y" }, arrayish]) {
      expect(new Probe({ name: v }).name).toBe(castNameLikeSchema(v));
    }
  });

  it("treats a PURGED FILAMENT row as outside the index (Codex P2)", () => {
    // The restore path stamps `_deletedAt` on a `_purged` zombie before
    // inserting, so it never enters the partial unique index. Rejecting the
    // pair would refuse a file the existing zombie repair handles correctly.
    expect(
      findTrimmedNameCollision(
        [{ name: "X" }, { name: "X ", _purged: true, _deletedAt: null }],
        true,
      ),
    ).toBeNull();
    // Two ACTIVE, non-purged rows still collide.
    expect(
      findTrimmedNameCollision([{ name: "X" }, { name: "X ", _purged: false }], true),
    ).toEqual({ name: "X", indexes: [0, 1] });
  });

  it("exempts a purged row only when it will ACTUALLY be tombstoned (Codex P2)", () => {
    // normalizePurgedTombstone stamps only when `_deletedAt == null`. An
    // empty string isn't, so it survives to insertMany, where the Date cast
    // makes it null and the row inserts ACTIVE — the pair really collides.
    expect(
      findTrimmedNameCollision(
        [{ name: "X" }, { name: "X ", _purged: true, _deletedAt: "" }],
        true,
      ),
    ).toEqual({ name: "X", indexes: [0, 1] });
    // undefined and an omitted field DO get tombstoned, so they're exempt.
    expect(
      findTrimmedNameCollision(
        [{ name: "Y" }, { name: "Y ", _purged: true, _deletedAt: undefined }],
        true,
      ),
    ).toBeNull();
    expect(
      findTrimmedNameCollision([{ name: "Z" }, { name: "Z ", _purged: true }], true),
    ).toBeNull();
  });

  it("does NOT exempt _purged on the other unique-name collections (Codex P2)", () => {
    // Nozzle / Printer / BedType / Location don't declare `_purged`, so
    // strict mode strips it and the row inserts ACTIVE — and the restore
    // never re-tombstones them. Exempting there would suppress a real
    // collision and produce the post-wipe E11000 this check replaces.
    expect(
      findTrimmedNameCollision([
        { name: "X" },
        { name: "X ", _purged: true, _deletedAt: null },
      ]),
    ).toEqual({ name: "X", indexes: [0, 1] });
  });

  it("keys by the value the SCHEMA will store, not the raw JSON (Codex P2)", () => {
    // Mongoose casts a String path, so `1` and `"1 "` both validate — and
    // then insertMany stores both as `"1"` and E11000s AFTER the destructive
    // wipe, the exact failure this precheck exists to prevent.
    expect(findTrimmedNameCollision([{ name: 1 }, { name: "1 " }])).toEqual({
      name: "1",
      indexes: [0, 1],
    });
    expect(findTrimmedNameCollision([{ name: true }, { name: " true" }])).toEqual({
      name: "true",
      indexes: [0, 1],
    });
    // A value Mongoose would NOT cast is left to the per-document validation,
    // which rejects it with its own message.
    expect(findTrimmedNameCollision([{ name: { a: 1 } }, { name: "[object Object]" }])).toBeNull();
  });

  it("returns null for a clean file", () => {
    expect(findTrimmedNameCollision([{ name: "A" }, { name: "B" }])).toBeNull();
  });
});

describe("EDGE_WHITESPACE_PATTERN (Codex P2)", () => {
  it("selects exactly what String.prototype.trim strips", () => {
    // The pre-filter and the decision MUST agree. Mongo's `\s` is PCRE's —
    // ASCII-only in practice — so a name ending in U+00A0 or U+3000 was never
    // returned by the query and the JS re-check never got to repair it, while
    // the schema setter WOULD trim it on the document's next save.
    const re = new RegExp(EDGE_WHITESPACE_PATTERN, "u");
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCharCode(cp);
      const trimStrips = `a${ch}` !== `a${ch}`.trim() || `${ch}a` !== `${ch}a`.trim();
      expect(re.test(`a${ch}`) || re.test(`${ch}a`)).toBe(trimStrips);
    }
  });

  it("covers the non-ASCII cases a PCRE \\s misses", async () => {
    const { db, store } = makeDb({
      locations: [
        { _id: "l1", name: "NBSP\u00A0" },
        { _id: "l2", name: "\u3000Ideographic" },
        { _id: "l3", name: "BOM\uFEFF" },
      ],
    });
    expect((await trimEntityNames(db)).trimmed).toBe(3);
    expect(store.locations.map((r) => r.name)).toEqual([
      "NBSP",
      "Ideographic",
      "BOM",
    ]);
  });
});

describe("pre-write collision check (Codex P1)", () => {
  it("refuses without writing even when NO unique index reports it", () => {
    // The fake has no unique constraint at all — the situation on a database
    // whose partial index is missing or stale, which is exactly what
    // dbConnect's coreModelIndexes pass (running AFTER this one) repairs.
    // Relying on E11000 there let both rows write through as "X", and that
    // later pass would then skip the index rebuild entirely.
    const store: Record<string, { _id: string; name?: unknown; _deletedAt?: unknown }[]> =
      {
        locations: [
          { _id: "l1", name: "Drybox #1", _deletedAt: null },
          { _id: "l2", name: "Drybox #1 ", _deletedAt: null },
        ],
      };
    const db: MinimalTrimDb = {
      collection(name: string) {
        const rows = store[name] ?? [];
        return {
          find(filter: Record<string, unknown>) {
            return {
              async toArray() {
                if (typeof filter.name === "string") {
                  return rows.filter(
                    (r) => r.name === filter.name && (r._deletedAt ?? null) === null,
                  );
                }
                const re = new RegExp(EDGE_WHITESPACE_PATTERN, "u");
                return rows.filter(
                  (r) => typeof r.name === "string" && re.test(r.name),
                );
              },
            };
          },
          // No uniqueness enforcement whatsoever.
          async updateOne(f: Record<string, unknown>, update: Record<string, unknown>) {
            const target = rows.find(
              (r) => r._id === f._id && (f.name === undefined || r.name === f.name),
            );
            if (!target) return { matchedCount: 0 };
            target.name = (update.$set as { name: string }).name;
            return { matchedCount: 1 };
          },
        };
      },
    };
    return trimEntityNames(db).then((res) => {
      expect(res.trimmed).toBe(0);
      expect(res.conflicts).toEqual([
        {
          collection: "locations", name: "Drybox #1 ", active: true,
          id: "l2", trimsTo: "Drybox #1", reason: "collision",
          // The pre-write clash check names the twin even here — the missing
          // index only removes the SERIALIZATION, not the lookup.
          collidesWith: { id: "l1", name: "Drybox #1" },
        },
      ]);
      expect(store.locations[1].name).toBe("Drybox #1 ");
    });
  });

  it("still trims when the only same-named row is TRASHED — the index is partial", async () => {
    const { db, store } = makeDb({
      locations: [
        { _id: "l1", name: "Drybox #1", _deletedAt: "2026-01-01" },
        { _id: "l2", name: "Drybox #1 ", _deletedAt: null },
      ],
    });
    const res = await trimEntityNames(db);
    expect(res.trimmed).toBe(1);
    expect(store.locations[1].name).toBe("Drybox #1");
  });

  it("trims a TRASHED row even though an active one holds the name", async () => {
    const { db, store } = makeDb({
      locations: [
        { _id: "l1", name: "Drybox #1", _deletedAt: null },
        { _id: "l2", name: "Drybox #1 ", _deletedAt: "2026-01-01" },
      ],
    });
    const res = await trimEntityNames(db);
    expect(res.trimmed).toBe(1);
    expect(store.locations[1].name).toBe("Drybox #1");
  });
});

describe("concurrent rename during the scan (Codex P2)", () => {
  it("a user rename between the read and the write WINS", async () => {
    // The pass runs on every hybrid cycle while the app can still write to
    // either database. Filtering on `_id` alone would stamp the stale
    // candidate's trimmed value over the user's new name.
    const rows = [{ _id: "l1", name: "Drybox #1 ", _deletedAt: null }];
    let scanned = false;
    const db: MinimalTrimDb = {
      collection: () => ({
        find(filter: Record<string, unknown>) {
          return {
            async toArray() {
              if (typeof filter.name === "string") return [];
              // Hand back the pre-rename candidate, then let the "user"
              // rename land before the helper writes.
              const snapshot = rows.map((r) => ({ ...r }));
              if (!scanned) {
                scanned = true;
                rows[0].name = "Renamed By User";
              }
              return snapshot.filter(
                (r) =>
                  typeof r.name === "string" &&
                  new RegExp(EDGE_WHITESPACE_PATTERN, "u").test(r.name),
              );
            },
          };
        },
        async updateOne(f: Record<string, unknown>) {
          const target = rows.find(
            (r) => r._id === f._id && (f.name === undefined || r.name === f.name),
          );
          if (!target) return { matchedCount: 0 };
          target.name = "SHOULD NOT HAPPEN";
          return { matchedCount: 1 };
        },
      }),
    };

    const res = await trimEntityNames(db);
    expect(res.trimmed).toBe(0);
    expect(rows[0].name).toBe("Renamed By User");
  });
});


/**
 * GH #1116 (Codex P2, round 22). The settle rule is what decides whether the
 * migration ever runs again, and it used to be an unreachable inline
 * expression inside `dbConnect` — so nothing pinned it.
 */
describe("trimBlockedCount", () => {
  const base = { trimmed: 0, conflicts: [], skipped: [], deferred: [] };

  it("settles a clean pass", () => {
    expect(trimBlockedCount({ ...base, trimmed: 3 })).toBe(0);
  });

  it("does NOT settle while a legacy-index trim is deferred", () => {
    // The whole point: the conflict is inactive (nothing a human can fix), so
    // only `deferred` keeps this unsettled. Settling here strands an untrimmed
    // tombstone forever — and restoring it makes an untrimmed name active and
    // unreachable by name, which is GH #1116 all over again.
    expect(
      trimBlockedCount({
        ...base,
        conflicts: [asConflict({ collection: "locations", name: "Shelf ", active: false })],
        deferred: [{ collection: "locations", reason: "legacy index" }],
      }),
    ).toBe(1);
  });

  it("blocks on an active conflict and on a skipped collection", () => {
    expect(
      trimBlockedCount({
        ...base,
        conflicts: [asConflict({ collection: "filaments", name: "PLA ", active: true })],
        skipped: [{ collection: "nozzles", reason: "no index" }],
      }),
    ).toBe(2);
  });

  it("ignores inactive conflicts on their own", () => {
    // A whitespace-only or purged name is untrimmable forever and invisible in
    // the UI. Blocking on it would retry (and gate sync) with no way out.
    expect(
      trimBlockedCount({
        ...base,
        conflicts: [asConflict({ collection: "printers", name: "   ", active: false })],
      }),
    ).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  TRIMMABLE_COLLECTIONS,
  EDGE_WHITESPACE_PATTERN,
  hasEdgeWhitespace,
  trimEntityNames,
  describeTrimResult,
  findTrimmedNameCollision,
  type MinimalTrimDb,
} from "@/lib/trimEntityNames";

/**
 * A driver-shaped fake: one in-memory array per collection, with a unique
 * constraint on the ACTIVE names so the collision branch is exercised the way
 * the real partial index would exercise it.
 */
function makeDb(
  seed: Partial<Record<string, { _id: string; name?: unknown; _deletedAt?: unknown }[]>>,
) {
  const store: Record<string, { _id: string; name?: unknown; _deletedAt?: unknown }[]> = {};
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
          return {};
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
      { collection: "locations", name: "Drybox #1 " },
    ]);
    // Untouched — still visible and editable in the app.
    expect(store.locations[1].name).toBe("Drybox #1 ");
  });

  it("reports a whitespace-only name instead of writing an empty required field", async () => {
    const { db, store } = makeDb({ nozzles: [{ _id: "n1", name: "   " }] });
    const res = await trimEntityNames(db);
    expect(res.trimmed).toBe(0);
    expect(res.conflicts).toEqual([{ collection: "nozzles", name: "   " }]);
    expect(store.nozzles[0].name).toBe("   ");
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

describe("describeTrimResult", () => {
  it("says nothing when there was nothing to do", () => {
    expect(describeTrimResult({ trimmed: 0, conflicts: [] })).toBeNull();
  });

  it("names every conflict, since the user has to resolve them by hand", () => {
    const line = describeTrimResult({
      trimmed: 2,
      conflicts: [{ collection: "locations", name: "Drybox #1 " }],
    });
    expect(line).toContain("trimmed 2");
    expect(line).toContain('locations: "Drybox #1 "');
  });

  it("reports trims alone", () => {
    expect(describeTrimResult({ trimmed: 3, conflicts: [] })).toContain("trimmed 3");
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
    expect(findTrimmedNameCollision([null, 7, { name: 3 }, {}])).toBeNull();
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
            const target = rows.find((r) => r._id === f._id);
            if (target) target.name = (update.$set as { name: string }).name;
            return {};
          },
        };
      },
    };
    return trimEntityNames(db).then((res) => {
      expect(res.trimmed).toBe(0);
      expect(res.conflicts).toEqual([
        { collection: "locations", name: "Drybox #1 " },
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

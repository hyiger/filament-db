import { describe, it, expect } from "vitest";
import {
  survivorNameConflict,
  trimmedNameFilter,
  findByTrimmedName,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import { JS_TRIM_CHARS } from "@/lib/trimEntityNames";

/**
 * GH #1116. This helper is the fallback every "resolve by name, create when
 * missing" path needs, because a Mongoose String setter casts QUERY values and
 * therefore cannot select a stored row the migration has not trimmed yet.
 *
 * The rule it encodes was applied to one call site and missed at two others,
 * each found a review round apart — so the shape is pinned here rather than
 * re-derived per caller.
 */
describe("trimmedNameFilter", () => {
  function trimSpec(filter: Record<string, unknown>) {
    const expr = filter.$expr as { $in: [{ $trim: Record<string, unknown> }, string[]] };
    return { trim: expr.$in[0].$trim, wanted: expr.$in[1] };
  }

  it("compares the STORED name's trimmed form against the trimmed inputs", () => {
    const { wanted } = trimSpec(trimmedNameFilter(["  PLA  ", "PETG"]));
    expect(wanted).toEqual(["PLA", "PETG"]);
  });

  it("passes JS_TRIM_CHARS as `chars`, not MongoDB's default set", () => {
    // Load-bearing, and the reason is subtle: `$trim` without `chars` strips
    // MongoDB's ASCII-only set, so a name ending in U+00A0 / U+FEFF / U+3000
    // would NOT match here while `String.prototype.trim` (what the schema
    // setter uses) removes it — the query and the schema would disagree about
    // the same row, which is the bug one level down.
    const { trim } = trimSpec(trimmedNameFilter(["PLA"]));
    expect(trim.chars).toBe(JS_TRIM_CHARS);
    expect(String(trim.chars)).toContain(" ");
    expect(String(trim.chars)).toContain("﻿");
  });

  it("coerces a non-string stored name rather than erroring on it", () => {
    // `$trim` throws on a non-string input and legacy data holds them, which
    // would fail the whole import rather than skipping one unmatched row.
    const { trim } = trimSpec(trimmedNameFilter(["PLA"]));
    expect(trim.input).toEqual({
      $cond: [{ $eq: [{ $type: "$name" }, "string"] }, "$name", ""],
    });
  });

  it("matches nothing for an empty input list", () => {
    const { wanted } = trimSpec(trimmedNameFilter([]));
    expect(wanted).toEqual([]);
  });
});

describe("findByTrimmedName", () => {
  function fakeCollection(result: { _id: unknown; name?: unknown } | null) {
    const calls: Record<string, unknown>[] = [];
    const collection: MinimalNameCollection = {
      async findOne(filter) {
        calls.push(filter);
        return result;
      },
    };
    return { collection, calls };
  }

  it("returns the surviving row", async () => {
    const { collection } = fakeCollection({ _id: "abc", name: "Drybox #1 " });
    expect(await findByTrimmedName(collection, "Drybox #1")).toEqual({
      _id: "abc",
      name: "Drybox #1 ",
    });
  });

  it("merges the caller's own conditions with the name predicate", async () => {
    const { collection, calls } = fakeCollection(null);
    await findByTrimmedName(collection, "Drybox #1", { _deletedAt: null });
    expect(calls[0]._deletedAt).toBeNull();
    expect(calls[0].$expr).toBeDefined();
  });

  it("short-circuits a blank name without querying", async () => {
    // A whitespace-only name trims to "", which is not a legal name — and
    // querying for it would scan the collection to match nothing.
    const { collection, calls } = fakeCollection({ _id: "x" });
    expect(await findByTrimmedName(collection, "   ")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("looks up by the TRIMMED form of an untrimmed input", async () => {
    const { collection, calls } = fakeCollection(null);
    await findByTrimmedName(collection, "  Drybox #1  ");
    const expr = calls[0].$expr as { $in: [unknown, string[]] };
    expect(expr.$in[1]).toEqual(["Drybox #1"]);
  });
});

describe("survivorNameConflict", () => {
  /** A fake whose `find` returns matches in a caller-chosen order, so the
   *  "arbitrary match happens to be self" case is deterministic. */
  function fakeWith(rows: { _id: string }[]) {
    return {
      async findOne() {
        return rows[0] ?? null;
      },
      find() {
        return { async toArray() { return rows; } };
      },
    } as unknown as Parameters<typeof survivorNameConflict>[0];
  }

  it("looks PAST a match that is the row being renamed", async () => {
    // Several active rows can trim to one name — exactly what a skipped
    // migration leaves. A single-match lookup returns an ARBITRARY one; when
    // that was self, the guard reported "no conflict" and the save normalized
    // a survivor "X " to "X" beside an existing "X", producing two identical
    // STORED names with no index left to catch it.
    const col = fakeWith([{ _id: "self" }, { _id: "other" }]);
    expect(await survivorNameConflict(col, "X", "self")).toBe("other");
  });

  it("still reports no conflict when self is the ONLY match", async () => {
    const col = fakeWith([{ _id: "self" }]);
    expect(await survivorNameConflict(col, "X", "self")).toBeNull();
  });

  it("reports the first match when there is no self to exclude", async () => {
    const col = fakeWith([{ _id: "other" }]);
    expect(await survivorNameConflict(col, "X")).toBe("other");
  });

  it("normalizes a schema-castable non-string before deciding", async () => {
    // Mongoose stores 7 as "7"; a `typeof` skip would never look.
    const col = fakeWith([{ _id: "other" }]);
    expect(await survivorNameConflict(col, 7)).toBe("other");
  });

  it("ignores a value the schema would reject, and a blank name", async () => {
    const col = fakeWith([{ _id: "other" }]);
    expect(await survivorNameConflict(col, ["nope"])).toBeNull();
    expect(await survivorNameConflict(col, "   ")).toBeNull();
  });
});

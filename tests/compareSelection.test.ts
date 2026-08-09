import { describe, it, expect } from "vitest";
import { MAX_COMPARE_FILAMENTS, parseCompareIds } from "@/lib/compareSelection";

describe("parseCompareIds", () => {
  it("returns an empty selection for absent or blank input", () => {
    for (const raw of [null, undefined, "", "   ", ",,,"]) {
      expect(parseCompareIds(raw)).toEqual({ ids: [], dropped: 0 });
    }
  });

  it("trims and drops empty segments", () => {
    expect(parseCompareIds(" a , b ,, c ")).toEqual({ ids: ["a", "b", "c"], dropped: 0 });
  });

  it("preserves the caller's order", () => {
    // The API returns rows in the requested order and the table's columns
    // follow it, so the parse must not sort.
    expect(parseCompareIds("c,a,b").ids).toEqual(["c", "a", "b"]);
  });

  it("dedupes, keeping the first occurrence", () => {
    // GH #1109: `?ids=a,a,a` used to render three identical columns under
    // duplicate React keys, and burned three of the eight slots.
    expect(parseCompareIds("a,b,a,c,b")).toEqual({ ids: ["a", "b", "c"], dropped: 0 });
  });

  it("dedupes BEFORE capping, so duplicates don't consume slots", () => {
    // 9 segments but only 8 distinct ids — nothing is actually dropped.
    const raw = ["1", "2", "3", "4", "5", "6", "7", "8", "1"].join(",");
    const parsed = parseCompareIds(raw);
    expect(parsed.ids).toHaveLength(MAX_COMPARE_FILAMENTS);
    expect(parsed.dropped).toBe(0);
  });

  it("caps at MAX_COMPARE_FILAMENTS and reports the overflow", () => {
    // The reported case: a 9-id link. Pre-fix the page forwarded all nine,
    // the API 400'd, and the page rendered a blank area.
    const parsed = parseCompareIds(Array.from({ length: 9 }, (_, i) => `id${i}`).join(","));
    expect(parsed.ids).toHaveLength(8);
    expect(parsed.ids[7]).toBe("id7");
    expect(parsed.dropped).toBe(1);
  });

  it("reports the full overflow count for a far-over-cap link", () => {
    const parsed = parseCompareIds(Array.from({ length: 30 }, (_, i) => `id${i}`).join(","));
    expect(parsed.ids).toHaveLength(MAX_COMPARE_FILAMENTS);
    expect(parsed.dropped).toBe(30 - MAX_COMPARE_FILAMENTS);
  });

  it("never reports a negative dropped count", () => {
    expect(parseCompareIds("a").dropped).toBe(0);
  });

  it("pins the cap the API enforces", () => {
    // src/app/api/filaments/compare/route.ts rejects more than this with a
    // 400; the client caps to match so an over-long link truncates instead.
    expect(MAX_COMPARE_FILAMENTS).toBe(8);
  });
});

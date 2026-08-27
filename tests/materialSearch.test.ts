import { describe, expect, it } from "vitest";
import {
  matchesSearchTokens,
  matchesTokenizedQuery,
  normalizeSearchFields,
  normalizeSearchText,
  tokenizeSearchQuery,
} from "@/lib/materialSearch";

// GH #1173 — the reporter's exact rows: brand in one field, color-bearing
// name in another, type in a third. The old single-substring filter could
// never match a query spanning fields.
const ARIANEPLAST_PLA_BLANC = ["PLA Blanc", "Arianeplast", "PLA"];

describe("normalizeSearchText", () => {
  it("lowercases", () => {
    expect(normalizeSearchText("Arianeplast")).toBe("arianeplast");
  });

  it("strips combining accents via NFD", () => {
    expect(normalizeSearchText("Améthyste")).toBe("amethyste");
    expect(normalizeSearchText("Grün")).toBe("grun");
  });

  it("leaves plain ASCII untouched", () => {
    expect(normalizeSearchText("pla blanc 1.75")).toBe("pla blanc 1.75");
  });
});

describe("the compile-once split form (Codex P2 on PR #1181)", () => {
  it("tokenizeSearchQuery normalizes, splits on whitespace runs, and drops empties", () => {
    expect(tokenizeSearchQuery("  Arianeplast   PLá ")).toEqual(["arianeplast", "pla"]);
    expect(tokenizeSearchQuery("")).toEqual([]);
    expect(tokenizeSearchQuery("   ")).toEqual([]);
  });

  it("normalizeSearchFields normalizes and drops null/undefined/empty entries", () => {
    expect(normalizeSearchFields(["PLA Blanc", null, undefined, "", "Améthyste"])).toEqual([
      "pla blanc",
      "amethyste",
    ]);
  });

  it("matchesSearchTokens is the equivalence-preserving core of matchesTokenizedQuery", () => {
    const fields = normalizeSearchFields(ARIANEPLAST_PLA_BLANC);
    for (const q of ["arianeplast b", "arianeplast petg", "", "pla blanc"]) {
      expect(matchesSearchTokens(fields, tokenizeSearchQuery(q))).toBe(
        matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, q),
      );
    }
  });
});

describe("matchesTokenizedQuery", () => {
  it("matches the reported flow: brand + first letter of the color", () => {
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "arianeplast b")).toBe(true);
  });

  it("matches the reported flow: brand + start of the material type", () => {
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "arianeplast pl")).toBe(true);
  });

  it("single-token queries behave like the old filter (substring of any field)", () => {
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "arian")).toBe(true);
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "blanc")).toBe(true);
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "xyz")).toBe(false);
  });

  it("AND across tokens: every token must land somewhere", () => {
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "arianeplast petg")).toBe(false);
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "prusa blanc")).toBe(false);
  });

  it("OR across fields: different tokens may hit different fields", () => {
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "blanc arianeplast pla")).toBe(true);
  });

  it("a contiguous multi-word phrase inside ONE field still matches (superset of old behavior)", () => {
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "pla blanc")).toBe(true);
  });

  it("is case-insensitive on both sides", () => {
    expect(matchesTokenizedQuery(["PLA Blanc", "ARIANEPLAST", "PLA"], "ArIaNePlAsT bLaNc")).toBe(true);
  });

  it("accent-folds both directions", () => {
    expect(matchesTokenizedQuery(["PLA Améthyste", "Francofil", "PLA"], "ameth")).toBe(true);
    expect(matchesTokenizedQuery(["PLA Amethyste", "Francofil", "PLA"], "améth")).toBe(true);
  });

  it("empty and whitespace-only queries match everything (callers gate the empty case)", () => {
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "")).toBe(true);
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "   ")).toBe(true);
  });

  it("tolerates repeated whitespace between tokens", () => {
    expect(matchesTokenizedQuery(ARIANEPLAST_PLA_BLANC, "  arianeplast   pla  ")).toBe(true);
  });

  it("tolerates null / undefined / empty fields", () => {
    expect(matchesTokenizedQuery(["PLA Blanc", null, undefined, ""], "blanc")).toBe(true);
    expect(matchesTokenizedQuery([null, undefined, ""], "blanc")).toBe(false);
  });

  it("no fields at all never matches a non-empty query", () => {
    expect(matchesTokenizedQuery([], "pla")).toBe(false);
    expect(matchesTokenizedQuery([], "")).toBe(true);
  });
});

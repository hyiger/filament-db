import { describe, it, expect } from "vitest";
import { OPT_TAG } from "@/lib/openprinttag";
import {
  LEGACY_OPT_TAG,
  LEGACY_TO_SPEC,
  LEGACY_IDS,
  SPEC_IDS,
  FIXED_POINT_IDS,
  LEGACY_ONLY_IDS,
  SPEC_ONLY_IDS,
  remapLegacyOptTags,
  deriveLegacyBackfillTags,
  classifyOptTags,
  describeOptTagReadings,
  sameOptTagSet,
  optTagsAwaitReview,
  optTagIdForString,
  parseOptTagsCell,
} from "@/lib/optTagLegacy";

/**
 * GH #1227 — the pre-#1227 app numbering, its remap onto the spec enum, and
 * the classifier that decides which numbering a stored array is in. The
 * classifier's whole value is in what it REFUSES to decide, so the ambiguous
 * cases are pinned as carefully as the decisive ones.
 */
describe("LEGACY_TO_SPEC", () => {
  it("covers every legacy id, and every target is a spec id", () => {
    for (const id of Object.values(LEGACY_OPT_TAG)) {
      expect(LEGACY_TO_SPEC, `legacy ${id}`).toHaveProperty(String(id));
      const target = LEGACY_TO_SPEC[id];
      if (target !== null) expect(SPEC_IDS.has(target), `legacy ${id} → ${target}`).toBe(true);
    }
    expect(Object.keys(LEGACY_TO_SPEC)).toHaveLength(Object.keys(LEGACY_OPT_TAG).length);
  });

  it("pins the semantic mappings the module docblock argues for", () => {
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.TRANSPARENT]).toBe(OPT_TAG.TRANSPARENT); // 2 → 20
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.TRANSLUCENT]).toBe(OPT_TAG.TRANSLUCENT); // 3 → 19
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.CONTAINS_GLASS_FIBER]).toBe(OPT_TAG.CONTAINS_GLASS_FIBER); // 0 → 34
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.SPARKLE]).toBe(OPT_TAG.GLITTER); // 22 → 23
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.PHOSPHORESCENT]).toBe(OPT_TAG.GLOW_IN_THE_DARK); // 23 → 24
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.GRADIENT]).toBe(OPT_TAG.GRADUAL_COLOR_CHANGE); // 27 → 28
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.DUAL_COLOR]).toBe(OPT_TAG.COEXTRUDED); // 28 → 29
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.TRIPLE_COLOR]).toBe(OPT_TAG.COEXTRUDED); // 29 → 29
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.MARBLE]).toBe(OPT_TAG.IMITATES_MARBLE); // 18 → 57
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.WOOD_FILL]).toBe(OPT_TAG.CONTAINS_WOOD); // 19 → 41
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.METAL_FILL]).toBe(OPT_TAG.CONTAINS_METAL); // 20 → 46
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.RECYCLED]).toBe(OPT_TAG.RECYCLED); // 49 → 60
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.BIODEGRADABLE]).toBe(OPT_TAG.INDUSTRIALLY_COMPOSTABLE); // 12 → 62
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.ESD_SAFE]).toBe(OPT_TAG.ESD_SAFE); // 35 → 10
    expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG.CONDUCTIVE]).toBe(OPT_TAG.CONDUCTIVE); // 10 → 11
  });

  it("drops the concepts that have no spec tag", () => {
    for (const name of [
      "FOOD_SAFE", "HEAT_RESISTANT", "FLEXIBLE", "HIGH_IMPACT", "LOW_WARP", "FUZZY",
      "HYGROSCOPIC", "ANTI_STATIC", "CHEMICALLY_RESISTANT", "AUTOMOTIVE_GRADE", "AEROSPACE_GRADE",
    ] as const) {
      expect(LEGACY_TO_SPEC[LEGACY_OPT_TAG[name]], name).toBeNull();
    }
  });

  it("derives the three id sets the classifier reasons with", () => {
    // 29 is a fixed point too: legacy TRIPLE_COLOR and spec coextruded mean the
    // same thing, so the remap leaves it where it is.
    expect([...FIXED_POINT_IDS].sort((a, b) => a - b)).toEqual([4, 13, 16, 17, 24, 29, 31, 71]);
    expect([...LEGACY_ONLY_IDS]).toEqual([18]);
    for (const id of [30, 40, 48, 50, 60, 70, 72, 74]) expect(SPEC_ONLY_IDS.has(id), `${id}`).toBe(true);
    for (const id of LEGACY_IDS) expect(SPEC_ONLY_IDS.has(id), `${id}`).toBe(false);
  });
});

describe("remapLegacyOptTags", () => {
  it("translates, drops, deduplicates and keeps first-seen order", () => {
    expect(remapLegacyOptTags([2, 3, 22, 27, 28, 29, 9, 5])).toEqual({
      tags: [20, 19, 23, 28, 29],
      dropped: [9, 5],
    });
    // PHOSPHORESCENT (23) and GLOW_IN_THE_DARK (24) both become 24, once.
    expect(remapLegacyOptTags([23, 24]).tags).toEqual([24]);
  });

  it("keeps an id outside the legacy table verbatim and ignores garbage", () => {
    expect(remapLegacyOptTags([75, 2, -1, 1.5, "x" as unknown as number])).toEqual({
      tags: [75, 20],
      dropped: [],
    });
    expect(remapLegacyOptTags(null)).toEqual({ tags: [], dropped: [] });
  });
});

describe("deriveLegacyBackfillTags (historical scripts/backfill-all-fields.ts)", () => {
  it("reproduces the script's output, legacy ids, sorted", () => {
    expect(deriveLegacyBackfillTags("Prusament PLA Galaxy Black", "PLA")).toEqual([12, 15]);
    expect(deriveLegacyBackfillTags("Prusament PC Blend Carbon Fiber", "PC-CF")).toEqual([4, 6, 14, 31]);
    expect(deriveLegacyBackfillTags("Overture TPU Flex", "TPU")).toEqual([9]);
    expect(deriveLegacyBackfillTags("Fiberlogy Easy PET-G Transparent", "PETG")).toEqual([2, 15, 36]);
    expect(deriveLegacyBackfillTags("Nylon CF", "NYLON")).toEqual([4, 14, 31, 33]);
    expect(deriveLegacyBackfillTags(null, undefined)).toEqual([]);
  });
});

describe("classifyOptTags", () => {
  it("trivial: empty, or only ids that are the same in both numberings", () => {
    expect(classifyOptTags({ optTags: [] })).toEqual({ kind: "trivial" });
    expect(classifyOptTags({ optTags: null })).toEqual({ kind: "trivial" });
    expect(classifyOptTags({ optTags: [4, 16, 71] })).toEqual({ kind: "trivial" });
    expect(classifyOptTags({ optTags: [-1, 2.5] })).toEqual({ kind: "trivial" }); // nothing usable
  });

  it("spec: an id the pre-#1227 app could never have written", () => {
    // The live library's "PC Blend Carbon Fiber Black": spec-correct, 30 is spec-only.
    expect(classifyOptTags({ optTags: [31, 12, 4, 30] })).toEqual({ kind: "spec", reason: "spec-only-id" });
    expect(classifyOptTags({ optTags: [2, 60] })).toEqual({ kind: "spec", reason: "spec-only-id" });
    // Beyond both tables is still "not written by the app".
    expect(classifyOptTags({ optTags: [2, 99] })).toEqual({ kind: "spec", reason: "spec-only-id" });
  });

  it("legacy: the deprecated id 18 proves the legacy numbering", () => {
    expect(classifyOptTags({ optTags: [18, 2] })).toEqual({ kind: "legacy", reason: "legacy-only-id" });
  });

  it("inconsistent: a legacy-only AND a spec-only id in one array", () => {
    expect(classifyOptTags({ optTags: [18, 30] })).toEqual({ kind: "inconsistent" });
  });

  it("legacy: OPT provenance — a snapshot equal to the stored array, or a link with no snapshot", () => {
    expect(
      classifyOptTags({ optTags: [2, 17], openprinttagSnapshot: { optTags: [17, 2] } }),
    ).toEqual({ kind: "legacy", reason: "opt-provenance" });
    expect(
      classifyOptTags({ optTags: [2], settings: { openprinttag_slug: "x-pla" } }),
    ).toEqual({ kind: "legacy", reason: "opt-provenance" });
    expect(
      classifyOptTags({ optTags: [2], settings: { openprinttag_uuid: "u" }, openprinttagSnapshot: { color: "#000000" } }),
    ).toEqual({ kind: "legacy", reason: "opt-provenance" });
  });

  it("ambiguous: a snapshot that DIFFERS proves nothing (edited in the legacy form, or an NFC row linked later)", () => {
    expect(
      classifyOptTags({ optTags: [2, 17], openprinttagSnapshot: { optTags: [17] }, settings: { openprinttag_slug: "s" } }),
    ).toEqual({ kind: "ambiguous" });
  });

  it("ambiguous WITH A HINT when equal to the historical backfill derivation — likely, never proof", () => {
    expect(
      classifyOptTags({ optTags: [15, 12], name: "Prusament PLA Galaxy Black", type: "PLA" }),
    ).toEqual({ kind: "ambiguous", hint: "backfill-derivation" });
    // A different type breaks the match — plain ambiguous.
    expect(
      classifyOptTags({ optTags: [15, 12], name: "Prusament PLA Galaxy Black", type: "PETG" }),
    ).toEqual({ kind: "ambiguous" });
    // Codex P1 (PR #1228): a vendor NFC TPU tagged spec 9 high_temperature
    // matches the script's TPU [9] FLEXIBLE exactly. Deciding "legacy" here
    // would drop a real spec tag and mark the row verified with no review.
    expect(classifyOptTags({ optTags: [9], type: "TPU" })).toEqual({
      kind: "ambiguous",
      hint: "backfill-derivation",
    });
  });

  it("optTagsAwaitReview: unmarked legacy/ambiguous/inconsistent arrays wait; marked, trivial and spec ones don't", () => {
    expect(optTagsAwaitReview({ optTags: [2] })).toBe(true);
    expect(optTagsAwaitReview({ optTags: [18, 2] })).toBe(true); // legacy, pass not run yet
    expect(optTagsAwaitReview({ optTags: [18, 30] })).toBe(true);
    expect(optTagsAwaitReview({ optTags: [2], optTagsSpec: true })).toBe(false);
    expect(optTagsAwaitReview({ optTags: [] })).toBe(false);
    expect(optTagsAwaitReview({ optTags: [4, 16] })).toBe(false);
    expect(optTagsAwaitReview({ optTags: [31, 30] })).toBe(false);
  });

  it("ambiguous: ids valid under both numberings with nothing outside the array to decide", () => {
    // App "transparent" vs spec "antibacterial"; app "flexible" vs spec "high_temperature";
    // app "dual_color" vs spec "gradual_color_change". Plausibility is not a proof.
    expect(classifyOptTags({ optTags: [2] })).toEqual({ kind: "ambiguous" });
    expect(classifyOptTags({ optTags: [9], type: "PETG", name: "Flexi" })).toEqual({ kind: "ambiguous" });
    expect(classifyOptTags({ optTags: [28], color: null } as never)).toEqual({ kind: "ambiguous" });
    // The spec-numbered Prusament "PLA Blend" tag [12] reads the same way.
    expect(classifyOptTags({ optTags: [12], name: "Prusament PLA Blend", type: "PLA" })).toEqual({ kind: "ambiguous" });
  });

  it("does not misread an already-converted array as legacy again (the double-remap hazard)", () => {
    // [2] converted → [20]; [27] → [28]; [12] → [62]. None of these may come
    // back as `legacy` on content alone — a second pass over a converted row
    // (a peer that synced it down unmarked) must at worst ask, never remap.
    for (const converted of [[20], [28], [62], [19, 23]]) {
      expect(classifyOptTags({ optTags: converted }).kind, JSON.stringify(converted)).not.toBe("legacy");
    }
  });
});

describe("describeOptTagReadings / sameOptTagSet", () => {
  it("gives both readings of an ambiguous array", () => {
    expect(describeOptTagReadings([2, 9, 4])).toEqual({
      stored: [2, 9, 4],
      asLegacy: { tags: [20, 4], dropped: [9] },
      asSpec: [2, 9, 4],
    });
  });

  it("sameOptTagSet is order-insensitive and ignores unusable entries", () => {
    expect(sameOptTagSet([1, 2], [2, 1])).toBe(true);
    expect(sameOptTagSet([1, 2, -1], [2, 1])).toBe(true);
    expect(sameOptTagSet([1], [1, 2])).toBe(false);
    expect(sameOptTagSet(null, [])).toBe(true);
  });
});

describe("optTagIdForString", () => {
  it("resolves spec names directly, case- and whitespace-insensitively", () => {
    expect(optTagIdForString("transparent")).toBe(20);
    expect(optTagIdForString(" Contains_Carbon ")).toBe(30);
    expect(optTagIdForString("abrasive")).toBe(4);
  });

  it("resolves the legacy-app and real-world aliases onto the migration's spec ids", () => {
    expect(optTagIdForString("sparkle")).toBe(23);
    expect(optTagIdForString("wood_fill")).toBe(41);
    expect(optTagIdForString("metal_fill")).toBe(46);
    expect(optTagIdForString("stone_fill")).toBe(36);
    expect(optTagIdForString("gradient")).toBe(28);
    expect(optTagIdForString("dual_color")).toBe(29);
    expect(optTagIdForString("triple_color")).toBe(29);
    expect(optTagIdForString("glow_in_dark")).toBe(24);
    expect(optTagIdForString("phosphorescent")).toBe(24);
    expect(optTagIdForString("contains_aramid_fiber")).toBe(35);
    expect(optTagIdForString("marble")).toBe(57);
    expect(optTagIdForString("biodegradable")).toBe(62);
    expect(optTagIdForString("color_changing")).toBe(27);
  });

  it("returns null for a dropped legacy concept or an unknown string", () => {
    expect(optTagIdForString("flexible")).toBeNull();
    expect(optTagIdForString("food_safe")).toBeNull();
    expect(optTagIdForString("not_a_real_opt_tag")).toBeNull();
  });
});

describe("parseOptTagsCell", () => {
  it("parses names (verified) and empty cells", () => {
    expect(parseOptTagsCell("")).toEqual({ tags: [], verified: true, unknownTokens: [] });
    expect(parseOptTagsCell("transparent, glitter, matte")).toEqual({
      tags: [20, 23, 16],
      verified: true,
      unknownTokens: [],
    });
  });

  it("classifies bare ids: provable sets are remapped/kept, ambiguous ones are kept unverified", () => {
    expect(parseOptTagsCell("18, 2", { name: "X", type: "PLA" })).toEqual({ tags: [57, 20], verified: true, unknownTokens: [] });
    expect(parseOptTagsCell("31,12,4,30")).toEqual({ tags: [31, 12, 4, 30], verified: true, unknownTokens: [] });
    expect(parseOptTagsCell("28,16", { name: "Tagged PLA", type: "PLA" })).toEqual({
      tags: [28, 16],
      verified: false,
      unknownTokens: [],
    });
    // The historical backfill output is LIKELY legacy, not provably so: kept
    // verbatim and unverified, like any other ambiguous numeric set.
    expect(parseOptTagsCell("12,15", { name: "Prusament PLA Galaxy Black", type: "PLA" })).toEqual({
      tags: [12, 15],
      verified: false,
      unknownTokens: [],
    });
  });

  it("drops empty tokens (no phantom tag 0), negatives and unknown words — and reports the words", () => {
    expect(parseOptTagsCell("28,,16,")).toEqual({ tags: [28, 16], verified: false, unknownTokens: [] });
    expect(parseOptTagsCell("matte, bogus, -1, 30")).toEqual({
      tags: [16, 30],
      verified: true,
      unknownTokens: ["bogus", "-1"],
    });
  });
});

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
  effectiveOptTagsAwaitReview,
  OPT_TAG_CLASSIFIER_PATHS,
  OPT_SNAPSHOT_NUMBERING_KEY,
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

  it("a spec-only id is a HINT, never provenance (Codex P1 r3 on PR #1228)", () => {
    // The live library's "PC Blend Carbon Fiber Black" is spec-correct and 30
    // is spec-only — but the pre-#1227 CSV importer and schema stored any
    // integer, so a legacy-era [2, 30] is possible too. Listed for the user
    // with the hint; never remapped, never marked on content alone.
    expect(classifyOptTags({ optTags: [31, 12, 4, 30] })).toEqual({ kind: "ambiguous", hint: "spec-only-id" });
    expect(classifyOptTags({ optTags: [2, 60] })).toEqual({ kind: "ambiguous", hint: "spec-only-id" });
    expect(optTagsAwaitReview({ optTags: [31, 12, 4, 30] })).toBe(true);
    // Alone, or beside fixed points, a spec-only id is inert: the remap keeps it.
    expect(classifyOptTags({ optTags: [30] })).toEqual({ kind: "trivial" });
    expect(classifyOptTags({ optTags: [31, 30, 4] })).toEqual({ kind: "trivial" });
    // The spec-only hint takes precedence over the backfill one, which can
    // never apply at the same time anyway (the backfill wrote legacy ids only).
    expect(classifyOptTags({ optTags: [9, 30], type: "TPU" })).toEqual({ kind: "ambiguous", hint: "spec-only-id" });
  });

  it("an id outside BOTH tables is inert — it decides nothing (Codex P1 r2 on PR #1228)", () => {
    // The pre-#1227 CSV importer and the schema accepted any non-negative
    // integer, so a legacy row can carry 99 as easily as a spec one. Reading
    // "not in the legacy table" as "spec" marked a legacy [2, 99] verified and
    // froze its 2 (app transparent) as spec 2 (antibacterial).
    expect(classifyOptTags({ optTags: [2, 99] })).toEqual({ kind: "ambiguous" });
    expect(optTagsAwaitReview({ optTags: [2, 99] })).toBe(true);
    // Alone, or beside fixed points, it is trivial: `tag 99` under both readings.
    expect(classifyOptTags({ optTags: [99] })).toEqual({ kind: "trivial" });
    expect(classifyOptTags({ optTags: [4, 99] })).toEqual({ kind: "trivial" });
    // It never masks real evidence, and beside another inert id it stays trivial.
    expect(classifyOptTags({ optTags: [18, 99] })).toEqual({ kind: "legacy", reason: "legacy-only-id" });
    expect(classifyOptTags({ optTags: [99, 50] })).toEqual({ kind: "trivial" });
    expect(classifyOptTags({ optTags: [18, 99, 50] })).toEqual({ kind: "legacy", reason: "legacy-only-id" });
    // And the remap keeps it verbatim on a conversion.
    expect(remapLegacyOptTags([2, 99])).toEqual({ tags: [20, 99], dropped: [] });
  });

  it("legacy: the deprecated id 18 proves the legacy numbering", () => {
    expect(classifyOptTags({ optTags: [18, 2] })).toEqual({ kind: "legacy", reason: "legacy-only-id" });
  });

  it("no array is inconsistent: a spec-only id beside 18 is a stray that rides along", () => {
    // 18 proves the legacy numbering; 30 could only have come through the
    // legacy CSV importer. It is kept verbatim by the conversion.
    expect(classifyOptTags({ optTags: [18, 30] })).toEqual({ kind: "legacy", reason: "legacy-only-id" });
    expect(remapLegacyOptTags([18, 30])).toEqual({ tags: [LEGACY_TO_SPEC[18], 30], dropped: [] });
  });

  it("legacy: OPT provenance — a PRE-v1.83 snapshot equal to the stored array, or a link with no snapshot at all", () => {
    // No `tagsNumbering: "spec"` entry → written by the pre-#1227 importer /
    // re-sync in the legacy numbering; equality means it wrote the stored array.
    expect(
      classifyOptTags({ optTags: [2, 17], openprinttagSnapshot: { optTags: [17, 2] } }),
    ).toEqual({ kind: "legacy", reason: "opt-provenance" });
    // A link with NO snapshot object predates snapshots (v1.36): only that
    // importer could have created it (the link route, v1.52, always writes one).
    expect(
      classifyOptTags({ optTags: [2], settings: { openprinttag_slug: "x-pla" } }),
    ).toEqual({ kind: "legacy", reason: "opt-provenance" });
  });

  it("ambiguous: a snapshot written since v1.83 is spec-numbered and proves nothing; a tag-less one proves nothing either (Codex P1 r4)", () => {
    // Linked AFTER upgrading: buildOptSnapshot wrote spec ids and said so. A
    // stored spec [2] (antibacterial — an NFC-created row) equal to it must
    // not be read as the legacy importer's work and remapped to 20.
    expect(
      classifyOptTags({
        optTags: [2],
        settings: { openprinttag_slug: "s" },
        openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" },
      }),
    ).toEqual({ kind: "ambiguous" });
    // A pre-v1.83 snapshot with no optTags entry: the material offered no
    // tags, so the stored array did not come from the importer.
    expect(
      classifyOptTags({ optTags: [2], settings: { openprinttag_uuid: "u" }, openprinttagSnapshot: { color: "#000000" } }),
    ).toEqual({ kind: "ambiguous" });
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

  it("optTagsAwaitReview: unmarked legacy/ambiguous arrays wait; marked and trivial ones don't", () => {
    expect(optTagsAwaitReview({ optTags: [2] })).toBe(true);
    expect(optTagsAwaitReview({ optTags: [18, 2] })).toBe(true); // legacy, pass not run yet
    expect(optTagsAwaitReview({ optTags: [18, 30] })).toBe(true); // legacy with a stray, pass not run yet
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

describe("OPT_TAG_CLASSIFIER_PATHS (what a projecting caller must select)", () => {
  it("names every path the classifier reads, the snapshot numbering marker included", () => {
    // CI on PR #1228 caught the renumber pass projecting the snapshot WITHOUT
    // its marker: a spec-marked snapshot then read as legacy proof and the
    // row was converted. The list is the contract; a projection built from it
    // cannot drop the marker.
    expect(OPT_TAG_CLASSIFIER_PATHS).toContain(`openprinttagSnapshot.${OPT_SNAPSHOT_NUMBERING_KEY}`);
    expect(OPT_TAG_CLASSIFIER_PATHS).toContain("openprinttagSnapshot.optTags");
    for (const path of ["optTags", "optTagsSpec", "name", "type", "settings.openprinttag_slug", "settings.openprinttag_uuid"]) {
      expect(OPT_TAG_CLASSIFIER_PATHS, path).toContain(path);
    }
    // A row reduced to exactly these paths classifies the same as the full row.
    const full = {
      optTags: [2], optTagsSpec: undefined, name: "N", type: "PLA", vendor: "V", color: "#000000",
      settings: { openprinttag_slug: "s", other: "x" },
      openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec", density: 1.24 },
    };
    expect(classifyOptTags(full)).toEqual({ kind: "ambiguous" });
    const projected = {
      optTags: full.optTags, name: full.name, type: full.type,
      settings: { openprinttag_slug: "s" },
      openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" },
    };
    expect(classifyOptTags(projected)).toEqual({ kind: "ambiguous" });
  });
});

describe("effectiveOptTagsAwaitReview (the OpenPrintTag output gate)", () => {
  it("reads the review state from the row that supplies the effective array", () => {
    const parentPending = { optTags: [2], name: "P", type: "PLA" };
    const parentVerified = { optTags: [2], optTagsSpec: true };
    // Empty own array → the parent's tags AND the parent's state.
    expect(effectiveOptTagsAwaitReview({ optTags: [] }, parentPending)).toBe(true);
    expect(effectiveOptTagsAwaitReview({ optTags: [] }, parentVerified)).toBe(false);
    // A non-empty own array wins over the parent either way.
    expect(effectiveOptTagsAwaitReview({ optTags: [16] }, parentPending)).toBe(false);
    expect(effectiveOptTagsAwaitReview({ optTags: [2] }, parentVerified)).toBe(true);
    // No parent: the row itself.
    expect(effectiveOptTagsAwaitReview({ optTags: [2] })).toBe(true);
    expect(effectiveOptTagsAwaitReview({ optTags: [2], optTagsSpec: true }, null)).toBe(false);
    expect(effectiveOptTagsAwaitReview({ optTags: [] })).toBe(false);
  });
});

describe("describeOptTagReadings / sameOptTagSet", () => {
  it("gives both readings of an ambiguous array", () => {
    expect(describeOptTagReadings([2, 9, 4])).toEqual({
      stored: [2, 9, 4],
      asLegacy: { tags: [20, 4], dropped: [9] },
      asSpec: [2, 9, 4],
    });
    // An id the spec doesn't define stays visible in the spec reading (the
    // page labels it "Tag 99"); only the legacy-only 18 is meaningless there.
    expect(describeOptTagReadings([18, 2, 99])).toEqual({
      stored: [18, 2, 99],
      asLegacy: { tags: [LEGACY_TO_SPEC[18], 20, 99], dropped: [] },
      asSpec: [2, 99],
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
    expect(parseOptTagsCell("")).toEqual({ tags: [], verified: true, unknownTokens: [], rejectReason: null });
    expect(parseOptTagsCell("transparent, glitter, matte")).toEqual({
      tags: [20, 23, 16],
      verified: true,
      unknownTokens: [],
      rejectReason: null,
    });
  });

  it("classifies bare ids: provable sets are remapped/kept, ambiguous ones are kept unverified", () => {
    expect(parseOptTagsCell("18, 2", { name: "X", type: "PLA" })).toEqual({ tags: [57, 20], verified: true, unknownTokens: [], rejectReason: null });
    // A spec-only id is a hint, not proof (Codex P1 r3): kept verbatim, unverified.
    expect(parseOptTagsCell("31,12,4,30")).toEqual({ tags: [31, 12, 4, 30], verified: false, unknownTokens: [], rejectReason: null });
    expect(parseOptTagsCell("30, 4")).toEqual({ tags: [30, 4], verified: true, unknownTokens: [], rejectReason: null });
    expect(parseOptTagsCell("28,16", { name: "Tagged PLA", type: "PLA" })).toEqual({
      tags: [28, 16],
      verified: false,
      unknownTokens: [],
      rejectReason: null,
    });
    // The historical backfill output is LIKELY legacy, not provably so: kept
    // verbatim and unverified, like any other ambiguous numeric set.
    expect(parseOptTagsCell("12,15", { name: "Prusament PLA Galaxy Black", type: "PLA" })).toEqual({
      tags: [12, 15],
      verified: false,
      unknownTokens: [],
      rejectReason: null,
    });
  });

  it("refuses a cell that MIXES names with ambiguous bare ids (Codex P2 r2 on PR #1228)", () => {
    // `transparent,2` stored unverified as [20, 2] would see its 20 — a spec id
    // by construction — remapped as legacy METAL_FILL into 46 on a later
    // Convert. One array carries one marker, so the row is refused instead.
    const rejected = parseOptTagsCell("transparent, 2", { name: "X", type: "PLA" });
    expect(rejected.tags).toEqual([]);
    expect(rejected.verified).toBe(false);
    expect(rejected.rejectReason).toMatch(/mixes tag names with numeric ids .*\(2\)/);
    // The words that resolved to nothing are still reported alongside.
    expect(parseOptTagsCell("transparent, bogus, 28")).toMatchObject({
      tags: [],
      unknownTokens: ["bogus"],
      rejectReason: expect.stringContaining("(28)"),
    });
    // Names beside a PROVABLE numeric set are fine — 18 proves legacy, 30
    // proves spec, 4 means the same either way.
    expect(parseOptTagsCell("transparent, 18")).toEqual({ tags: [20, LEGACY_TO_SPEC[18]], verified: true, unknownTokens: [], rejectReason: null });
    expect(parseOptTagsCell("transparent, 30")).toEqual({ tags: [20, 30], verified: true, unknownTokens: [], rejectReason: null });
    expect(parseOptTagsCell("transparent, 4")).toEqual({ tags: [20, 4], verified: true, unknownTokens: [], rejectReason: null });
    // Numbers alone stay the unverified-for-review path, as before.
    expect(parseOptTagsCell("2, 99")).toEqual({ tags: [2, 99], verified: false, unknownTokens: [], rejectReason: null });
  });

  it("drops empty tokens (no phantom tag 0), negatives and unknown words — and reports the words", () => {
    expect(parseOptTagsCell("28,,16,")).toEqual({ tags: [28, 16], verified: false, unknownTokens: [], rejectReason: null });
    expect(parseOptTagsCell("matte, bogus, -1, 30")).toEqual({
      tags: [16, 30],
      verified: true,
      unknownTokens: ["bogus", "-1"],
      rejectReason: null,
    });
  });
});

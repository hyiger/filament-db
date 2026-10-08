/**
 * GH #1227 — the PRE-#1227 OpenPrintTag tag numbering, frozen, and its one-way
 * remap onto the spec enum in `src/lib/openprinttag.ts`.
 *
 * ## What happened
 *
 * From 2026-04-01 until #1227 the app's `OPT_TAG` table was an invented
 * numbering that agreed with the spec's `data/tags_enum.yaml` on only seven ids
 * (4 abrasive, 13 water_soluble, 16 matte, 17 silk, 24 glow_in_the_dark,
 * 31 contains_carbon_fiber, 71 high_speed). Every other id meant one thing to
 * this app and another to every other OpenPrintTag reader: the app's 2
 * TRANSPARENT is the spec's `antibacterial`, its 9 FLEXIBLE is
 * `high_temperature`, its 0 CONTAINS_GLASS_FIBER is `filtration_recommended`.
 * The form, the OPT-database importer, the re-sync and the backfill script all
 * wrote the app numbering into `optTags`; a filament created from a VENDOR's
 * NFC tag carried the spec numbering. So a stored array is one of two
 * languages with no header saying which.
 *
 * ## What this module is for
 *
 *  - {@link LEGACY_OPT_TAG} is the old table, verbatim, so the remap and the
 *    classifier are reproducible. Nothing may add to it.
 *  - {@link LEGACY_TO_SPEC} maps each legacy id to the spec id with the same
 *    meaning, or to `null` when the concept has NO spec tag and is dropped.
 *  - {@link classifyOptTags} decides which numbering a stored array is in — or
 *    refuses to, which is the important case. The ids 0–17, 19–29, 31–39, 49
 *    and 71 exist in BOTH numberings, so an array made only of those is
 *    genuinely ambiguous unless something OUTSIDE the array proves its origin.
 *    The proofs accepted here are structural, never plausibility ("a TPU
 *    tagged high_temperature is unlikely" is a guess, and a guess here
 *    silently rewrites a user's data). Everything unproven is reported on the
 *    Data health page for the user to decide.
 *  - {@link deriveLegacyBackfillTags} is the historical `computeTags` from
 *    `scripts/backfill-all-fields.ts`, ported byte-for-byte. A stored array that
 *    equals what that script would have produced for the row's name + type is
 *    very likely to have come from it — but equality is NOT a proof (Codex P1
 *    on PR #1228): a vendor NFC tag can carry the same small set by
 *    coincidence (a TPU tagged spec 9 `high_temperature` matches the script's
 *    TPU `[9]` FLEXIBLE exactly), so the match is surfaced as a HINT on Data
 *    health and never decides on its own. Do NOT "improve" the derivation — it
 *    must keep reproducing the historical output.
 *
 * Pure and DB-free so the heuristics are unit-testable; the pass that applies
 * them to a database is `src/lib/optTagRenumber.ts`.
 */

import { OPT_TAG, OPT_TAG_BY_SPEC_NAME, isEncodableOptTag } from "./openprinttag";

/** The pre-#1227 table. FROZEN — historical record, not a vocabulary. */
export const LEGACY_OPT_TAG = {
  CONTAINS_GLASS_FIBER: 0,
  CONTAINS_ARAMID_FIBER: 1,
  TRANSPARENT: 2,
  TRANSLUCENT: 3,
  ABRASIVE: 4,
  FOOD_SAFE: 5,
  HEAT_RESISTANT: 6,
  UV_RESISTANT: 7,
  FLAME_RETARDANT: 8,
  FLEXIBLE: 9,
  CONDUCTIVE: 10,
  MAGNETIC: 11,
  BIODEGRADABLE: 12,
  WATER_SOLUBLE: 13,
  HIGH_IMPACT: 14,
  LOW_WARP: 15,
  MATTE: 16,
  SILK: 17,
  MARBLE: 18,
  WOOD_FILL: 19,
  METAL_FILL: 20,
  STONE_FILL: 21,
  SPARKLE: 22,
  PHOSPHORESCENT: 23,
  GLOW_IN_THE_DARK: 24,
  COLOR_CHANGING: 25,
  FUZZY: 26,
  GRADIENT: 27,
  DUAL_COLOR: 28,
  TRIPLE_COLOR: 29,
  CONTAINS_CARBON_FIBER: 31,
  CONTAINS_KEVLAR: 32,
  HYGROSCOPIC: 33,
  ANTI_STATIC: 34,
  ESD_SAFE: 35,
  CHEMICALLY_RESISTANT: 36,
  MEDICAL_GRADE: 37,
  AUTOMOTIVE_GRADE: 38,
  AEROSPACE_GRADE: 39,
  RECYCLED: 49,
  HIGH_SPEED: 71,
} as const;

/** Reverse lookup: legacy id → legacy name (e.g. 2 → "TRANSPARENT"). */
export const LEGACY_TAG_NAME: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(LEGACY_OPT_TAG).map(([name, id]) => [id, name]),
);

/**
 * Legacy id → spec id with the same meaning, or `null` = dropped.
 *
 * Dropped, and why (none of these is a wire concept — they are not in the
 * spec and most are properties of the material TYPE, which the tag already
 * carries):
 *  - FOOD_SAFE — the spec has `biocompatible` (a certification about body
 *    contact), which is not a food-contact claim.
 *  - HEAT_RESISTANT — only ever assigned per material type by the backfill
 *    script (ABS, ASA, PC, PEI, …). The spec's `high_temperature` is explicitly
 *    RELATIVE to the type's baseline ("HTPLA while keeping the PLA type"), so
 *    mapping it would brand every plain ABS a high-temperature variant.
 *  - FLEXIBLE — implied by the material type (TPU/TPE/TPC/PEBA) and Shore
 *    hardness; the spec has no flexibility tag.
 *  - HIGH_IMPACT, LOW_WARP, CHEMICALLY_RESISTANT, HYGROSCOPIC — type-inherent
 *    marketing properties with no spec tag.
 *  - ANTI_STATIC — the spec's `esd_safe` description says in so many words
 *    that it does NOT cover anti-static materials.
 *  - FUZZY, AUTOMOTIVE_GRADE, AEROSPACE_GRADE — no spec tag.
 *
 * Judgement calls, stated so they can be disputed in one place:
 *  - BIODEGRADABLE → `industrially_compostable` (62), the weakest spec
 *    end-of-life claim and the one PLA — which the backfill tagged
 *    biodegradable by type — actually certifies to (EN 13432).
 *  - MEDICAL_GRADE → `biocompatible` (1): medical-grade filament is sold on
 *    its ISO 10993 biocompatibility certification.
 *  - COLOR_CHANGING → `temperature_color_change` (27): thermochromic is what
 *    the market calls "color changing"; the UV-reactive kind is `neon`.
 *  - MAGNETIC → `paramagnetic` (7), the spec's only "attracted to magnets"
 *    tag (the iron/magnetite FILL tags describe the additive, not the effect).
 *  - PHOSPHORESCENT and GLOW_IN_THE_DARK both → 24: the spec defines
 *    glow_in_the_dark AS phosphorescent.
 *  - DUAL_COLOR and TRIPLE_COLOR both → `coextruded` (29): the spec has one
 *    coextruded tag and derives the count from the secondary colors.
 */
export const LEGACY_TO_SPEC: Readonly<Record<number, number | null>> = {
  [LEGACY_OPT_TAG.CONTAINS_GLASS_FIBER]: OPT_TAG.CONTAINS_GLASS_FIBER,
  [LEGACY_OPT_TAG.CONTAINS_ARAMID_FIBER]: OPT_TAG.CONTAINS_KEVLAR,
  [LEGACY_OPT_TAG.TRANSPARENT]: OPT_TAG.TRANSPARENT,
  [LEGACY_OPT_TAG.TRANSLUCENT]: OPT_TAG.TRANSLUCENT,
  [LEGACY_OPT_TAG.ABRASIVE]: OPT_TAG.ABRASIVE,
  [LEGACY_OPT_TAG.FOOD_SAFE]: null,
  [LEGACY_OPT_TAG.HEAT_RESISTANT]: null,
  [LEGACY_OPT_TAG.UV_RESISTANT]: OPT_TAG.UV_RESISTANT,
  [LEGACY_OPT_TAG.FLAME_RETARDANT]: OPT_TAG.SELF_EXTINGUISHING,
  [LEGACY_OPT_TAG.FLEXIBLE]: null,
  [LEGACY_OPT_TAG.CONDUCTIVE]: OPT_TAG.CONDUCTIVE,
  [LEGACY_OPT_TAG.MAGNETIC]: OPT_TAG.PARAMAGNETIC,
  [LEGACY_OPT_TAG.BIODEGRADABLE]: OPT_TAG.INDUSTRIALLY_COMPOSTABLE,
  [LEGACY_OPT_TAG.WATER_SOLUBLE]: OPT_TAG.WATER_SOLUBLE,
  [LEGACY_OPT_TAG.HIGH_IMPACT]: null,
  [LEGACY_OPT_TAG.LOW_WARP]: null,
  [LEGACY_OPT_TAG.MATTE]: OPT_TAG.MATTE,
  [LEGACY_OPT_TAG.SILK]: OPT_TAG.SILK,
  [LEGACY_OPT_TAG.MARBLE]: OPT_TAG.IMITATES_MARBLE,
  [LEGACY_OPT_TAG.WOOD_FILL]: OPT_TAG.CONTAINS_WOOD,
  [LEGACY_OPT_TAG.METAL_FILL]: OPT_TAG.CONTAINS_METAL,
  [LEGACY_OPT_TAG.STONE_FILL]: OPT_TAG.CONTAINS_STONE,
  [LEGACY_OPT_TAG.SPARKLE]: OPT_TAG.GLITTER,
  [LEGACY_OPT_TAG.PHOSPHORESCENT]: OPT_TAG.GLOW_IN_THE_DARK,
  [LEGACY_OPT_TAG.GLOW_IN_THE_DARK]: OPT_TAG.GLOW_IN_THE_DARK,
  [LEGACY_OPT_TAG.COLOR_CHANGING]: OPT_TAG.TEMPERATURE_COLOR_CHANGE,
  [LEGACY_OPT_TAG.FUZZY]: null,
  [LEGACY_OPT_TAG.GRADIENT]: OPT_TAG.GRADUAL_COLOR_CHANGE,
  [LEGACY_OPT_TAG.DUAL_COLOR]: OPT_TAG.COEXTRUDED,
  [LEGACY_OPT_TAG.TRIPLE_COLOR]: OPT_TAG.COEXTRUDED,
  [LEGACY_OPT_TAG.CONTAINS_CARBON_FIBER]: OPT_TAG.CONTAINS_CARBON_FIBER,
  [LEGACY_OPT_TAG.CONTAINS_KEVLAR]: OPT_TAG.CONTAINS_KEVLAR,
  [LEGACY_OPT_TAG.HYGROSCOPIC]: null,
  [LEGACY_OPT_TAG.ANTI_STATIC]: null,
  [LEGACY_OPT_TAG.ESD_SAFE]: OPT_TAG.ESD_SAFE,
  [LEGACY_OPT_TAG.CHEMICALLY_RESISTANT]: null,
  [LEGACY_OPT_TAG.MEDICAL_GRADE]: OPT_TAG.BIOCOMPATIBLE,
  [LEGACY_OPT_TAG.AUTOMOTIVE_GRADE]: null,
  [LEGACY_OPT_TAG.AEROSPACE_GRADE]: null,
  [LEGACY_OPT_TAG.RECYCLED]: OPT_TAG.RECYCLED,
  [LEGACY_OPT_TAG.HIGH_SPEED]: OPT_TAG.HIGH_SPEED,
};

/**
 * The `openprinttagSnapshot` entry that says which numbering the snapshot's
 * `optTags` are in. Every snapshot built since the enum was corrected (every
 * link, re-sync and OPT import go through `buildOptSnapshot`) carries
 * `tagsNumbering: "spec"`; a snapshot WITHOUT it was written by the pre-#1227
 * app in the legacy numbering. The classifier needs the distinction (Codex P1
 * r4 on PR #1228): a stored spec `[2]` linked after upgrading to a material
 * whose spec snapshot is also `[2]` would otherwise read as "the legacy
 * importer wrote this" and be remapped to 20. The renumber pass stamps the
 * marker when it translates a legacy snapshot, so no snapshot is translated
 * twice.
 */
export const OPT_SNAPSHOT_NUMBERING_KEY = "tagsNumbering";
export const OPT_SNAPSHOT_SPEC_NUMBERING = "spec";

/** True when a snapshot object says its `optTags` are already spec ids. */
export function snapshotIsSpecNumbered(snapshot: Record<string, unknown> | null | undefined): boolean {
  return !!snapshot && snapshot[OPT_SNAPSHOT_NUMBERING_KEY] === OPT_SNAPSHOT_SPEC_NUMBERING;
}

/**
 * Every document path `classifyOptTags` / `optTagsAwaitReview` read. A caller
 * that PROJECTS the row (the renumber pass, the PUT and GET routes) must
 * include all of them — a snapshot projected without its numbering marker
 * comes back looking like a pre-v1.83 one and is read as legacy proof, which
 * is exactly what CI caught on PR #1228 (the spec-marked "Linked After" row
 * was converted). Build projections from this list, never by hand.
 */
export const OPT_TAG_CLASSIFIER_PATHS: readonly string[] = [
  "optTags",
  "optTagsSpec",
  "name",
  "type",
  "settings.openprinttag_slug",
  "settings.openprinttag_uuid",
  "openprinttagSnapshot.optTags",
  `openprinttagSnapshot.${OPT_SNAPSHOT_NUMBERING_KEY}`,
];

/** Every id the pre-#1227 app could have written. */
export const LEGACY_IDS: ReadonlySet<number> = new Set(
  Object.keys(LEGACY_TO_SPEC).map(Number),
);

/** Every id the spec defines (18 is deprecated upstream and not here). */
export const SPEC_IDS: ReadonlySet<number> = new Set(Object.values(OPT_TAG));

/** Ids that mean the same thing in both numberings — a remap is a no-op on them. */
export const FIXED_POINT_IDS: ReadonlySet<number> = new Set(
  [...LEGACY_IDS].filter((id) => LEGACY_TO_SPEC[id] === id),
);

/**
 * Legacy ids that have no meaning in the spec — their presence PROVES the
 * array is in the legacy numbering. Just 18 (MARBLE): the spec deprecated 18,
 * the one coincidence this migration gets for free.
 */
export const LEGACY_ONLY_IDS: ReadonlySet<number> = new Set(
  [...LEGACY_IDS].filter((id) => !SPEC_IDS.has(id)),
);

/**
 * Spec ids the pre-#1227 app's FORM could never have written (30, 40–48,
 * 50–70, 72–74). NOT provenance: its CSV importer and schema stored any
 * encodable integer, so a legacy-era row can carry a 30 beside a legacy 2
 * (Codex P1 r3 on PR #1228). The classifier treats them as inert (the remap
 * keeps them verbatim) and surfaces them only as a Data health HINT.
 */
export const SPEC_ONLY_IDS: ReadonlySet<number> = new Set(
  [...SPEC_IDS].filter((id) => !LEGACY_IDS.has(id)),
);

/** Ids kept for classification: non-negative integers the encoder accepts. */
function usableIds(tags: readonly unknown[] | null | undefined): number[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter((t): t is number => isEncodableOptTag(t)))];
}

/** Order-insensitive set equality over the usable ids of two arrays. */
export function sameOptTagSet(
  a: readonly unknown[] | null | undefined,
  b: readonly unknown[] | null | undefined,
): boolean {
  const sa = usableIds(a);
  const sb = new Set(usableIds(b));
  return sa.length === sb.size && sa.every((id) => sb.has(id));
}

export interface LegacyRemapResult {
  /** The array in spec numbering: first-seen order, deduplicated. */
  tags: number[];
  /** Legacy ids that had no spec equivalent and were removed (deduplicated). */
  dropped: number[];
}

/**
 * Translate an array known to be in the LEGACY numbering into the spec
 * numbering. An id outside the legacy table is kept verbatim — it cannot be a
 * legacy id, so there is nothing to translate; the caller's classification is
 * what decides whether this function should run at all.
 */
export function remapLegacyOptTags(tags: readonly unknown[] | null | undefined): LegacyRemapResult {
  const out: number[] = [];
  const dropped: number[] = [];
  for (const id of usableIds(tags)) {
    if (!LEGACY_IDS.has(id)) {
      if (!out.includes(id)) out.push(id);
      continue;
    }
    const spec = LEGACY_TO_SPEC[id];
    if (spec === null) {
      dropped.push(id);
      continue;
    }
    if (!out.includes(spec)) out.push(spec);
  }
  return { tags: out, dropped };
}

// ── Historical backfill derivation (scripts/backfill-all-fields.ts) ──────────
//
// Ported VERBATIM, legacy ids and all. The only purpose is to recognise an
// array that script produced. Do not modernise, do not reuse for anything
// else. (The live script has since been rewritten against the spec enum.)

const BACKFILL_INHERENT_TAGS: Record<string, number[]> = {
  PLA: [LEGACY_OPT_TAG.LOW_WARP, LEGACY_OPT_TAG.BIODEGRADABLE],
  PETG: [LEGACY_OPT_TAG.LOW_WARP, LEGACY_OPT_TAG.CHEMICALLY_RESISTANT],
  ABS: [LEGACY_OPT_TAG.HIGH_IMPACT, LEGACY_OPT_TAG.HEAT_RESISTANT],
  ASA: [LEGACY_OPT_TAG.UV_RESISTANT, LEGACY_OPT_TAG.HEAT_RESISTANT, LEGACY_OPT_TAG.HIGH_IMPACT],
  PC: [LEGACY_OPT_TAG.HEAT_RESISTANT, LEGACY_OPT_TAG.HIGH_IMPACT],
  TPU: [LEGACY_OPT_TAG.FLEXIBLE],
  TPE: [LEGACY_OPT_TAG.FLEXIBLE],
  TPC: [LEGACY_OPT_TAG.FLEXIBLE],
  PEBA: [LEGACY_OPT_TAG.FLEXIBLE],
  HIPS: [LEGACY_OPT_TAG.HIGH_IMPACT],
  PVA: [LEGACY_OPT_TAG.WATER_SOLUBLE],
  BVOH: [LEGACY_OPT_TAG.WATER_SOLUBLE],
  PP: [LEGACY_OPT_TAG.CHEMICALLY_RESISTANT, LEGACY_OPT_TAG.LOW_WARP, LEGACY_OPT_TAG.FOOD_SAFE],
  POM: [LEGACY_OPT_TAG.CHEMICALLY_RESISTANT, LEGACY_OPT_TAG.LOW_WARP, LEGACY_OPT_TAG.ABRASIVE],
  PA: [LEGACY_OPT_TAG.HYGROSCOPIC, LEGACY_OPT_TAG.HIGH_IMPACT],
  PA6: [LEGACY_OPT_TAG.HYGROSCOPIC, LEGACY_OPT_TAG.HIGH_IMPACT],
  PA12: [LEGACY_OPT_TAG.HYGROSCOPIC],
  PA66: [LEGACY_OPT_TAG.HYGROSCOPIC, LEGACY_OPT_TAG.HIGH_IMPACT],
  PPA: [LEGACY_OPT_TAG.HEAT_RESISTANT, LEGACY_OPT_TAG.HYGROSCOPIC, LEGACY_OPT_TAG.CHEMICALLY_RESISTANT],
  PEI: [LEGACY_OPT_TAG.HEAT_RESISTANT, LEGACY_OPT_TAG.FLAME_RETARDANT, LEGACY_OPT_TAG.CHEMICALLY_RESISTANT],
  PEEK: [LEGACY_OPT_TAG.HEAT_RESISTANT, LEGACY_OPT_TAG.CHEMICALLY_RESISTANT],
  PEKK: [LEGACY_OPT_TAG.HEAT_RESISTANT, LEGACY_OPT_TAG.CHEMICALLY_RESISTANT],
  PVB: [LEGACY_OPT_TAG.TRANSLUCENT],
  PCTG: [LEGACY_OPT_TAG.LOW_WARP, LEGACY_OPT_TAG.CHEMICALLY_RESISTANT, LEGACY_OPT_TAG.HIGH_IMPACT],
  PHA: [LEGACY_OPT_TAG.BIODEGRADABLE],
  IGLIDUR: [LEGACY_OPT_TAG.ABRASIVE, LEGACY_OPT_TAG.CHEMICALLY_RESISTANT, LEGACY_OPT_TAG.LOW_WARP],
};

const BACKFILL_KEYWORD_TAGS: [RegExp, number][] = [
  [/\bCF\d*\b|carbon\s*fiber/i, LEGACY_OPT_TAG.CONTAINS_CARBON_FIBER],
  [/\bGF\d*\b|glass\s*fiber/i, LEGACY_OPT_TAG.CONTAINS_GLASS_FIBER],
  [/\bCF\d*\b|carbon\s*fiber/i, LEGACY_OPT_TAG.ABRASIVE],
  [/\bGF\d*\b|glass\s*fiber/i, LEGACY_OPT_TAG.ABRASIVE],
  [/matte/i, LEGACY_OPT_TAG.MATTE],
  [/silk/i, LEGACY_OPT_TAG.SILK],
  [/marble/i, LEGACY_OPT_TAG.MARBLE],
  [/wood/i, LEGACY_OPT_TAG.WOOD_FILL],
  [/metal/i, LEGACY_OPT_TAG.METAL_FILL],
  [/stone|mineral/i, LEGACY_OPT_TAG.STONE_FILL],
  [/sparkle|glitter/i, LEGACY_OPT_TAG.SPARKLE],
  [/glow/i, LEGACY_OPT_TAG.GLOW_IN_THE_DARK],
  [/phosphor/i, LEGACY_OPT_TAG.PHOSPHORESCENT],
  [/color.?chang/i, LEGACY_OPT_TAG.COLOR_CHANGING],
  [/fuzzy|fur/i, LEGACY_OPT_TAG.FUZZY],
  [/gradient|rainbow/i, LEGACY_OPT_TAG.GRADIENT],
  [/dual.?color/i, LEGACY_OPT_TAG.DUAL_COLOR],
  [/triple.?color|tri.?color/i, LEGACY_OPT_TAG.TRIPLE_COLOR],
  [/recycl/i, LEGACY_OPT_TAG.RECYCLED],
  [/high.?speed|HS\b/i, LEGACY_OPT_TAG.HIGH_SPEED],
  [/kevlar|aramid/i, LEGACY_OPT_TAG.CONTAINS_KEVLAR],
  [/transparent|clear/i, LEGACY_OPT_TAG.TRANSPARENT],
  [/translucent/i, LEGACY_OPT_TAG.TRANSLUCENT],
  [/flex/i, LEGACY_OPT_TAG.FLEXIBLE],
  [/ESD/i, LEGACY_OPT_TAG.CONDUCTIVE],
];

const BACKFILL_TYPE_ALIASES: Record<string, string> = {
  "PLA+": "PLA",
  "PLA-CF": "PLA",
  "PETG-CF": "PETG",
  "PET-GF": "PETG",
  "ABS-CF": "ABS",
  "ASA-CF": "ASA",
  "PC-CF": "PC",
  PA: "PA6",
  NYLON: "PA6",
  "PA-CF": "PA6",
  "NYLON-CF": "PA6",
  FLEX: "TPU",
  IGLIDUR: "IGLIDUR",
};

function backfillBaseType(type: string): string {
  const key = type.toUpperCase().replace(/\s+/g, "");
  if (BACKFILL_INHERENT_TAGS[key]) return key;
  if (BACKFILL_TYPE_ALIASES[key] && BACKFILL_INHERENT_TAGS[BACKFILL_TYPE_ALIASES[key]]) {
    return BACKFILL_TYPE_ALIASES[key];
  }
  return key;
}

/**
 * What `scripts/backfill-all-fields.ts` (pre-#1227) wrote into `optTags` for a
 * filament with this name and type — LEGACY ids, sorted ascending, exactly as
 * the script emitted them. Used only as a provenance test.
 */
export function deriveLegacyBackfillTags(name: string | null | undefined, type: string | null | undefined): number[] {
  const n = name ?? "";
  const ty = type ?? "";
  const tags = new Set<number>();

  const inherent = BACKFILL_INHERENT_TAGS[backfillBaseType(ty)];
  if (inherent) inherent.forEach((t) => tags.add(t));

  const typeKey = ty.toUpperCase().replace(/\s+/g, "");
  if (typeKey.includes("CF") || typeKey.includes("CARBON")) {
    tags.add(LEGACY_OPT_TAG.CONTAINS_CARBON_FIBER);
    tags.add(LEGACY_OPT_TAG.ABRASIVE);
  }
  if (typeKey.includes("GF") || typeKey.includes("GLASS")) {
    tags.add(LEGACY_OPT_TAG.CONTAINS_GLASS_FIBER);
    tags.add(LEGACY_OPT_TAG.ABRASIVE);
  }

  for (const [regex, tag] of BACKFILL_KEYWORD_TAGS) {
    if (regex.test(n)) tags.add(tag);
  }

  return [...tags].sort((a, b) => a - b);
}

// ── Classification ───────────────────────────────────────────────────────────

/** The fields of a filament the classifier reads. All optional — raw docs vary. */
export interface OptTagClassifiable {
  optTags?: readonly unknown[] | null;
  name?: string | null;
  type?: string | null;
  settings?: Record<string, unknown> | null;
  openprinttagSnapshot?: Record<string, unknown> | null;
}

export type OptTagVerdict =
  /** Empty, or only inert ids: the remap is a no-op either way. */
  | { kind: "trivial" }
  /** Provably the legacy numbering — remap it. */
  | { kind: "legacy"; reason: "legacy-only-id" | "opt-provenance" }
  /**
   * Both readings are consistent and nothing outside the array decides —
   * which is every other case, since no content can prove the SPEC numbering.
   * The optional hint is shown to the user and decides nothing:
   * `spec-only-id` — the array carries an id the pre-#1227 FORM could not
   * write (likely a vendor tag, or spec ids typed into a CSV);
   * `backfill-derivation` — the array equals what the historical backfill
   * script wrote for this name + type (likely entered in this app).
   */
  | { kind: "ambiguous"; hint?: "backfill-derivation" | "spec-only-id" };

/**
 * An id the remap leaves untouched: a fixed point (same meaning in both
 * tables), or any id outside the legacy table — a spec-only id or one in
 * neither table. Such an id is identical under both readings, so it proves
 * nothing about the array it sits in: the pre-#1227 CSV importer and schema
 * accepted any non-negative integer, so a legacy-era `[2, 30]` or `[2, 99]` is
 * as possible as a spec one (Codex P1 r2 + r3 on PR #1228). "Not in the legacy
 * table" is never evidence of the spec numbering.
 */
export function isInertOptTagId(id: number): boolean {
  return FIXED_POINT_IDS.has(id) || !LEGACY_IDS.has(id);
}

/**
 * Decide which numbering a stored `optTags` array is in.
 *
 * In order:
 *  1. Nothing usable, or only INERT ids — ids the remap leaves untouched:
 *     fixed points that mean the same in both numberings (4, 13, 16, 17, 24,
 *     31, 71 — plus 29, whose legacy TRIPLE_COLOR IS the spec's coextruded)
 *     and ids outside the legacy table (spec-only ids, ids in neither table)
 *     — → `trivial`. Converting such an array is a no-op; nothing to decide.
 *  2. NO content proves the SPEC numbering (Codex P1 r2 + r3 on PR #1228). The
 *     pre-#1227 FORM could not write a spec-only id (30, 40–48, 50–70, 72–74)
 *     or an id in neither table, but the pre-#1227 CSV importer and schema
 *     stored any encodable integer, so a legacy-era `[2, 30]` or `[2, 99]` is
 *     as possible as a spec one — taking the 30 or 99 as proof would freeze
 *     the 2 as antibacterial. Such an id decides nothing about its
 *     neighbours and rides through the remap verbatim.
 *  3. The legacy-only id 18 (deprecated upstream) → `legacy`. A spec-only id
 *     beside it is a stray the legacy importer let through and rides along —
 *     there is no "inconsistent" array; every array has both readings.
 *  4. OpenPrintTag provenance: a snapshot written BEFORE the enum was
 *     corrected (no `tagsNumbering: "spec"` entry) holds what the old
 *     `mapToFilamentPayload` offered, in the legacy numbering by construction.
 *     If the stored array equals its `optTags`, the importer or the re-sync
 *     wrote the stored array → `legacy`. A snapshot written SINCE (marked
 *     spec) is in the spec numbering and proves nothing about a legacy origin
 *     — a stored spec `[2]` linked after upgrading to a material whose spec
 *     snapshot is also `[2]` must stay the user's call (Codex P1 r4 on PR
 *     #1228). A pre-upgrade snapshot WITHOUT an `optTags` entry means the
 *     material offered no tags, so the stored array is not the importer's —
 *     nothing to conclude. A slug/uuid link with NO snapshot object at all
 *     predates snapshots (v1.36); only that importer could have created it
 *     (the link route, v1.52, always writes one) → `legacy`.
 *     A snapshot that DIFFERS proves nothing: the user may have edited the tags
 *     in the (legacy) form, or linked an NFC-created (spec) row afterwards.
 *     (Why the EQUAL case is safe where a vendor row was linked later: the OPT
 *     database and the vendor tag describe the same product with the same
 *     concepts, and the old importer mapped each concept to its LEGACY id while
 *     the tag carries the SPEC id — those coincide only on the fixed points,
 *     which are trivial anyway. A collision needs two DIFFERENT concepts whose
 *     legacy and spec ids happen to match on one product.)
 *  5. Otherwise → `ambiguous`, with a hint: `spec-only-id` when the array
 *     carries an id the old form could not write (likely a vendor tag, or spec
 *     ids typed into a CSV), else `backfill-derivation` when it equals what the
 *     historical backfill script wrote for this name + type (likely entered in
 *     this app). Likely is not proof — a vendor tag can carry the backfill's
 *     small set, a legacy CSV can carry a 30 — so a hint informs the user and
 *     decides nothing. (The two never both apply: the backfill wrote legacy
 *     ids only.)
 */
export function classifyOptTags(row: OptTagClassifiable): OptTagVerdict {
  const ids = usableIds(row.optTags);
  if (ids.length === 0 || ids.every(isInertOptTagId)) {
    return { kind: "trivial" };
  }

  if (ids.some((id) => LEGACY_ONLY_IDS.has(id))) {
    return { kind: "legacy", reason: "legacy-only-id" };
  }

  const snapshot = row.openprinttagSnapshot;
  if (snapshot && typeof snapshot === "object") {
    // Only a PRE-upgrade snapshot (legacy by construction) is provenance; a
    // snapshot that says it is spec-numbered decides nothing, and so does a
    // pre-upgrade one without an `optTags` entry (the material offered none).
    const snapshotTags = snapshot.optTags;
    if (
      !snapshotIsSpecNumbered(snapshot) &&
      Array.isArray(snapshotTags) &&
      sameOptTagSet(ids, snapshotTags)
    ) {
      return { kind: "legacy", reason: "opt-provenance" };
    }
  } else {
    const settings = row.settings ?? {};
    const linked =
      typeof settings.openprinttag_slug === "string" && settings.openprinttag_slug !== "" ||
      typeof settings.openprinttag_uuid === "string" && settings.openprinttag_uuid !== "";
    if (linked) return { kind: "legacy", reason: "opt-provenance" };
  }

  if (ids.some((id) => SPEC_ONLY_IDS.has(id))) {
    return { kind: "ambiguous", hint: "spec-only-id" };
  }
  if (sameOptTagSet(ids, deriveLegacyBackfillTags(row.name, row.type))) {
    return { kind: "ambiguous", hint: "backfill-derivation" };
  }
  return { kind: "ambiguous" };
}

/**
 * True when a row's `optTags` must not be changed piecemeal: it carries no
 * `optTagsSpec: true` marker and its array is not trivial (an unmarked legacy
 * or ambiguous array). Shared by the PUT route — which
 * refuses a changed array on such a row with 409 `opt_tags_pending_review`,
 * because ticking one spec-numbered box into a legacy array would have to be
 * stored as either all-legacy or all-spec and both lose a tag's meaning — and
 * by the form, which locks the tag controls for the same row (Codex P1 on PR
 * #1228). A decisive-legacy array is included deliberately: the startup pass
 * settles it on the next connect (and `GET /api/opt-tag-review` runs that pass
 * on demand), so a user who meets the lock is one Data health visit away from
 * an editable row.
 */
export function optTagsAwaitReview(
  row: OptTagClassifiable & { optTagsSpec?: boolean | null },
): boolean {
  if (row.optTagsSpec === true) return false;
  return classifyOptTags(row).kind !== "trivial";
}

/** The row-shape both gates below read. */
export type OptTagReviewRow = OptTagClassifiable & { optTagsSpec?: boolean | null };

/**
 * The row whose `optTags` a reader actually sees: the variant's own when it is
 * non-empty, else the parent's — resolveFilament's whole-array fallback (GH
 * #477). A variant with an empty own array inherits its parent's review state
 * along with its tags.
 */
export function optTagSourceRow<T extends { optTags?: readonly unknown[] | null }>(
  own: T,
  parent: T | null | undefined,
): T {
  if (Array.isArray(own.optTags) && own.optTags.length > 0) return own;
  return parent ?? own;
}

/**
 * Do the EFFECTIVE tags of `own` (its own, or the inherited ones) still await
 * numbering review? The gate every OpenPrintTag OUTPUT takes — the `.bin`
 * download route and the desktop NFC write — because an unreviewed array put
 * on a tag is read by every other OpenPrintTag reader as spec ids: the app's
 * old 2 "transparent" becomes "antibacterial" on the wire, the corruption this
 * migration exists to stop (Codex P1 r3 on PR #1228). Refused, not omitted: a
 * tag silently missing its tags looks fine until it is read.
 */
export function effectiveOptTagsAwaitReview(
  own: OptTagReviewRow,
  parent?: OptTagReviewRow | null,
): boolean {
  return optTagsAwaitReview(optTagSourceRow(own, parent));
}

/**
 * The two readings of an ambiguous array, for the Data health page: what the
 * tags become if they were entered in this app (legacy → spec, with what is
 * dropped) and what they already mean if they came from a tag. The spec
 * reading keeps every id but the legacy-only 18 (meaningless as a spec id) — an
 * id the spec doesn't define stays visible as `tag N` rather than vanishing
 * from one reading. The page labels them through `optTag.<name>`; the dropped
 * legacy concepts are labelled through `optTagLegacy.<name>`.
 */
export function describeOptTagReadings(tags: readonly unknown[] | null | undefined): {
  stored: number[];
  asLegacy: { tags: number[]; dropped: number[] };
  asSpec: number[];
} {
  const stored = usableIds(tags);
  const asLegacy = remapLegacyOptTags(stored);
  return { stored, asLegacy, asSpec: stored.filter((id) => !LEGACY_ONLY_IDS.has(id)) };
}

// ── Tag STRINGS → spec ids (the OPT database, CSV cells) ─────────────────────

/**
 * Spellings that are NOT spec names but still resolve: the pre-#1227 app
 * vocabulary (so a YAML or CSV authored against it lands on the SAME spec id
 * the stored-data remap gives it — one table, `LEGACY_TO_SPEC`, decides both;
 * a legacy concept with no equivalent resolves to nothing, exactly as the remap
 * drops it) plus the real-world variants GH #604 found in community files.
 */
const TAG_STRING_ALIASES: Readonly<Record<string, number | null>> = {
  // Real-world spellings seen in community YAMLs (GH #604).
  glow_in_dark: OPT_TAG.GLOW_IN_THE_DARK,
  gradient: OPT_TAG.GRADUAL_COLOR_CHANGE,
  dual_color: OPT_TAG.COEXTRUDED,
  triple_color: OPT_TAG.COEXTRUDED,
  // Pre-#1227 app vocabulary.
  ...Object.fromEntries(
    Object.entries(LEGACY_OPT_TAG).map(([name, legacyId]) => [
      name.toLowerCase(),
      LEGACY_TO_SPEC[legacyId],
    ]),
  ),
  contains_aramid_fiber: OPT_TAG.CONTAINS_KEVLAR,
  marble: OPT_TAG.IMITATES_MARBLE,
  sparkle: OPT_TAG.GLITTER,
};

/**
 * Resolve one tag string to a spec id, or `null` when it names nothing the
 * spec knows. Spec names win over aliases, so a legacy alias can never shadow
 * a real spec tag that shares its spelling (`matte`, `abrasive`, … are both).
 */
export function optTagIdForString(tag: string): number | null {
  const key = tag.trim().toLowerCase();
  if (key in OPT_TAG_BY_SPEC_NAME) return OPT_TAG_BY_SPEC_NAME[key];
  if (key in TAG_STRING_ALIASES) return TAG_STRING_ALIASES[key];
  return null;
}

export interface ParsedOptTagsCell {
  /** Spec ids, first-seen order, deduplicated. */
  tags: number[];
  /**
   * False when the cell carried bare NUMBERS the classifier could not place
   * in a numbering — the row must then land `optTagsSpec: false` and be
   * reviewed on Data health rather than stamped by the schema default.
   */
  verified: boolean;
  /** Tokens that were neither a known name nor a usable id (dropped). */
  unknownTokens: string[];
  /**
   * Set when the cell cannot be stored faithfully: it mixes tag NAMES (spec
   * ids by definition) with bare numbers the classifier leaves ambiguous. One array carries one marker, so `transparent,2` would have to
   * land unverified as `[20, 2]` — and a later Convert on Data health would
   * remap the 20 as legacy METAL_FILL into 46, a metal tag nobody entered
   * (Codex P2 on PR #1228). The importer skips the row with this reason;
   * `tags` is empty. Null otherwise.
   */
  rejectReason: string | null;
}

/**
 * Parse a CSV/XLSX `Tags` cell (GH #954 round-trip, GH #1227 numbering).
 *
 * Accepts spec NAMES (what the exporter writes for a verified row — self-
 * describing, survives any renumbering), legacy app names (via the alias
 * table) and bare NUMBERS. Numbers are the hazard: a pre-#1227 export wrote
 * legacy ids, a post-#1227 export of an unreviewed row writes bare ids too, and
 * neither says which numbering it is. They go through the same classifier the
 * startup pass uses — a provable legacy set is remapped, a set the remap would
 * not change is kept as verified, and anything else is kept VERBATIM and
 * flagged unverified — unless the
 * cell ALSO carries names, in which case it is rejected (`rejectReason`): the
 * names are known to be spec ids and the numbers are not known to be anything,
 * and a single array cannot record that split. Empty tokens are dropped BEFORE
 * parsing so a trailing/double comma can't become `Number("") === 0` and add a
 * phantom tag 0.
 */
export function parseOptTagsCell(
  cell: string,
  ctx: { name?: string | null; type?: string | null } = {},
): ParsedOptTagsCell {
  const tokens = cell
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const named: number[] = [];
  const numeric: number[] = [];
  const unknownTokens: string[] = [];
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      if (isEncodableOptTag(n)) numeric.push(n);
      else unknownTokens.push(tok);
      continue;
    }
    const id = optTagIdForString(tok);
    if (id === null) unknownTokens.push(tok);
    else named.push(id);
  }

  let verified = true;
  let numericTags = numeric;
  if (numeric.length > 0) {
    const verdict = classifyOptTags({ optTags: numeric, name: ctx.name, type: ctx.type });
    if (verdict.kind === "legacy") {
      numericTags = remapLegacyOptTags(numeric).tags;
    } else if (verdict.kind === "ambiguous") {
      if (named.length > 0) {
        return {
          tags: [],
          verified: false,
          unknownTokens,
          rejectReason:
            `Tags cell "${cell.trim()}" mixes tag names with numeric ids whose numbering cannot be determined (${numeric.join(", ")}) — use tag names only, or ids only`,
        };
      }
      verified = false;
    }
  }
  return { tags: [...new Set([...named, ...numericTags])], verified, unknownTokens, rejectReason: null };
}

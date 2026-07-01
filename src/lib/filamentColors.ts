/**
 * GH #477 — multi-color filament helpers.
 *
 * Mirrors the OpenPrintTag spec 1:1: primary color (`color`, spec key 19)
 * may be null for filaments without a single primary (rainbow,
 * coextruded). Secondary slots (`secondaryColors[]`, spec keys 20–24)
 * carry up to 5 additional colors. Color arrangement is NOT a separate
 * field — it's derived from `optTags` using the canonical OPT_TAG enum
 * values: 27 = `gradient`, 28 = `dual_color`, 29 = `triple_color`. Both
 * 28 and 29 map to the `"coextruded"` arrangement at render time —
 * the count is already implicit in `secondaryColors.length`.
 *
 * Kept DB-free so this can be unit-tested without mongoose / vitest
 * env config. Every function is pure and takes a minimal subset of the
 * filament shape.
 */

/**
 * OpenPrintTag tag IDs that describe color arrangement.
 *
 * GH #507: pre-fix this file declared TAG_COEXTRUDED = 29 and
 * TAG_GRADUAL_COLOR_CHANGE = 28 — contradicting the project's
 * canonical OPT_TAG enum at `src/lib/openprinttag.ts:163-165` AND the
 * OPT browser importer at `src/lib/openprinttagBrowser.ts:132-134`,
 * which both encode 27 = gradient, 28 = dual_color, 29 = triple_color
 * matching the upstream OpenPrintTag YAML. The mismatch made imported
 * dual-color OPT materials render as a smooth gradient and imported
 * gradient materials render as solid. Aligned here.
 */
const TAG_GRADIENT = 27;
const TAG_DUAL_COLOR = 28;
const TAG_TRIPLE_COLOR = 29;

/** What arrangement the filament's colors are physically in. `"solid"`
 *  is the default for single-color filaments and for multi-color
 *  filaments where neither arrangement tag is set (a misconfigured
 *  state we render the same as solid — primary color only). */
export type ColorArrangement = "solid" | "coextruded" | "gradient";

/**
 * Derive the arrangement from an `optTags` array.
 *
 * Priority order if both tags are present:
 *   coextruded > gradient
 *
 * Rationale: coextruded is the more structural property (about the
 * physical cross-section of the strand), while gradient describes
 * change-over-time. A "coextruded gradient" — where the strand has
 * multiple parallel colors AND those colors change along the length —
 * is theoretically possible per spec, but the rendering UI can only
 * pick one mode, so coextruded wins.
 */
export function deriveArrangement(
  optTags: number[] | null | undefined,
): ColorArrangement {
  if (!optTags || optTags.length === 0) return "solid";
  if (optTags.includes(TAG_DUAL_COLOR) || optTags.includes(TAG_TRIPLE_COLOR)) {
    return "coextruded";
  }
  if (optTags.includes(TAG_GRADIENT)) return "gradient";
  return "solid";
}

/**
 * Inverse of deriveArrangement. The form's arrangement radio needs to
 * write the right OPT tag for the requested arrangement, with the
 * caveat that `"coextruded"` actually maps to dual vs triple based on
 * how many colors are in play. Both forms render identically (striped
 * coextruded) — only the spec tag id differs.
 *
 * Returns the tag id to add, or null when no arrangement tag applies
 * ("solid").
 */
export function arrangementToOptTag(
  arrangement: ColorArrangement,
  secondaryColorCount: number,
): number | null {
  if (arrangement === "gradient") return TAG_GRADIENT;
  if (arrangement === "coextruded") {
    // A coextruded filament persists a null primary — all colors live in
    // secondaryColors — so the total color count equals secondaryColorCount:
    // 3+ secondaries = triple, 2-or-fewer = dual. (#817: the old `>= 2`
    // tagged a 2-color coextruded as triple_color (29) instead of dual (28).)
    return secondaryColorCount >= 3 ? TAG_TRIPLE_COLOR : TAG_DUAL_COLOR;
  }
  return null;
}

/**
 * Strip every arrangement-related tag from an optTags array. Used by
 * the form when the user switches arrangement, so leftover tags from
 * the prior arrangement don't survive on the doc and silently override
 * the next deriveArrangement() call.
 */
export function stripArrangementTags(optTags: number[] | null | undefined): number[] {
  if (!optTags) return [];
  return optTags.filter(
    (t) => t !== TAG_GRADIENT && t !== TAG_DUAL_COLOR && t !== TAG_TRIPLE_COLOR,
  );
}

/**
 * Pick the single hex string a UI should render when forced to show
 * just one color (the filament-list color dot, parent-picker chip,
 * etc.).
 *
 * Fallback order:
 *   1. `color` if non-null (the primary color)
 *   2. `secondaryColors[0]` if any (the spec convention for coextruded
 *      filaments is to leave `color` null and put colors in secondaries)
 *   3. `"#808080"` (gray) as a last-resort sentinel — should never be
 *      reached for any DB-stored row, but cheap to be defensive
 */
export function displayColor(
  filament: {
    color?: string | null;
    secondaryColors?: string[] | null;
  } | null | undefined,
): string {
  if (!filament) return "#808080";
  if (filament.color != null && filament.color !== "") return filament.color;
  if (filament.secondaryColors && filament.secondaryColors.length > 0) {
    return filament.secondaryColors[0];
  }
  return "#808080";
}

/**
 * Return every color the filament carries, primary first, in the order
 * a coextruded swatch should render them. Filters out the empty / null
 * primary so consumers don't have to.
 *
 * Used by `<FilamentSwatch>` (Phase 2) to lay out the stripes /
 * gradient stops without each call-site re-implementing the same
 * concat-and-filter dance.
 */
export function allColors(
  filament: {
    color?: string | null;
    secondaryColors?: string[] | null;
  } | null | undefined,
): string[] {
  if (!filament) return [];
  const out: string[] = [];
  if (filament.color != null && filament.color !== "") out.push(filament.color);
  if (filament.secondaryColors) {
    for (const c of filament.secondaryColors) {
      if (c != null && c !== "") out.push(c);
    }
  }
  return out;
}

/**
 * GH #597: the ordered, deduped list of hex colors a parent-of-variants
 * swatch should display. Replaces the old neutral cross-hatch with a
 * composite of the group's actual colors so a parent reads as "these are
 * the colors in this group" instead of an opaque pattern.
 *
 * Takes a single ordered list of candidate colors — the caller is
 * responsible for ordering (typically the parent's own color +
 * secondaryColors first, then each variant's color + secondaryColors).
 * Passing every color source (not just the primary `color`) matters for
 * coextruded / gradient members whose primary is `null` and whose colors
 * live entirely in `secondaryColors` — Codex P2 on PR #600.
 *
 * - Only valid `#rgb` / `#rrggbb` strings survive (null/empty/garbage dropped).
 * - Dedupe is case-insensitive, keeping the first occurrence's casing.
 * - Returns `[]` when nothing valid is known; the swatch then falls back
 *   to the legacy cross-hatch.
 */
export function parentSwatchColors(
  colors: ReadonlyArray<string | null | undefined>,
): string[] {
  const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of colors) {
    if (typeof raw !== "string") continue;
    const c = raw.trim();
    if (!HEX.test(c)) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}


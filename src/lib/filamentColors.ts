/**
 * GH #477 — multi-color filament helpers.
 *
 * Mirrors the OpenPrintTag spec 1:1: primary color (`color`, spec key 19)
 * may be null for filaments without a single primary (rainbow,
 * coextruded). Secondary slots (`secondaryColors[]`, spec keys 20–24)
 * carry up to 5 additional colors. Color arrangement is NOT a separate
 * field — it's derived from `optTags` (tag 29 = `coextruded`, tag 28 =
 * `gradual_color_change`), keeping the storage spec-pure.
 *
 * Kept DB-free so this can be unit-tested without mongoose / vitest
 * env config. Every function is pure and takes a minimal subset of the
 * filament shape.
 */

/**
 * OpenPrintTag tag IDs that describe color arrangement. Sourced from
 * `data/tags_enum.yaml` in the prusa3d/OpenPrintTag spec repo.
 */
const TAG_COEXTRUDED = 29;
const TAG_GRADUAL_COLOR_CHANGE = 28;

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
  if (optTags.includes(TAG_COEXTRUDED)) return "coextruded";
  if (optTags.includes(TAG_GRADUAL_COLOR_CHANGE)) return "gradient";
  return "solid";
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
 * True if the filament should render as multi-color (i.e. it has at
 * least one secondary color OR an arrangement tag is set). Useful for
 * gating "the slicer export will drop secondaries" notices and the
 * arrangement radio on the form.
 */
export function isMultiColor(
  filament: {
    color?: string | null;
    secondaryColors?: string[] | null;
    optTags?: number[] | null;
  } | null | undefined,
): boolean {
  if (!filament) return false;
  if (filament.secondaryColors && filament.secondaryColors.length > 0) return true;
  return deriveArrangement(filament.optTags) !== "solid";
}

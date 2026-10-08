/**
 * GH #477 — multi-color filament helpers.
 *
 * Mirrors the OpenPrintTag spec 1:1: primary color (`color`, spec key 19)
 * may be null for filaments without a single primary (rainbow,
 * coextruded). Secondary slots (`secondaryColors[]`, spec keys 20–24)
 * carry up to 5 additional colors. Color arrangement is NOT a separate
 * field — it's derived from `optTags` using the OpenPrintTag SPEC enum
 * (GH #1227): 28 = `gradual_color_change` (rendered as "gradient") and
 * 29 = `coextruded`. The spec has ONE coextruded tag — the color count is
 * implicit in `secondaryColors.length` — so the pre-#1227 dual/triple split
 * (app ids 28/29, which the spec reads as gradual_color_change/coextruded)
 * is gone, and 27 is `temperature_color_change`, not an arrangement.
 *
 * Kept DB-free so this can be unit-tested without mongoose / vitest
 * env config. Every function is pure and takes a minimal subset of the
 * filament shape.
 */

import { BLANK_COLOR_HEX, isIncompleteColorHex } from "./cssNamedColors";
import { OPT_TAG } from "./openprinttag";
import { displayOptTags } from "./optTagLegacy";

/**
 * OpenPrintTag tag IDs that describe color arrangement, straight from the
 * spec enum (GH #1227). GH #507 aligned this file to the app's OLD table
 * (27 gradient / 28 dual / 29 triple), which itself contradicted the spec —
 * the spec's 28 is `gradual_color_change` and its 29 is `coextruded`.
 */
const TAG_GRADIENT = OPT_TAG.GRADUAL_COLOR_CHANGE;
const TAG_COEXTRUDED = OPT_TAG.COEXTRUDED;

/** What arrangement the filament's colors are physically in. `"solid"`
 *  is the default for single-color filaments and for multi-color
 *  filaments where neither arrangement tag is set (a misconfigured
 *  state we render the same as solid — primary color only). */
export type ColorArrangement = "solid" | "coextruded" | "gradient";

/**
 * Derive the arrangement from an `optTags` array. Priority when both tags
 * are present: coextruded > gradient — a "coextruded gradient" is possible
 * per spec, but the rendering UI can only pick one mode, and coextruded is
 * the more structural property.
 */
export function deriveArrangement(
  optTags: number[] | null | undefined,
  /** GH #1227 (Codex P2 r11): the row's `optTags` still await numbering
   *  review — derive only from ids both numberings agree on (`displayOptTags`;
   *  the two-reading multi-color 28 renders as coextruded there). */
  awaitReview?: boolean | null,
): ColorArrangement {
  if (!optTags || optTags.length === 0) return "solid";
  const tags = displayOptTags(optTags, awaitReview);
  if (tags.includes(TAG_COEXTRUDED)) return "coextruded";
  if (tags.includes(TAG_GRADIENT)) return "gradient";
  return "solid";
}

/**
 * Inverse of deriveArrangement. The form's arrangement radio needs to
 * write the right OPT tag for the requested arrangement.
 *
 * The spec has a single `coextruded` tag — "number of colors can be derived
 * from the defined secondary colors" — so there is no count parameter any
 * more (GH #1227 retired the pre-spec dual/triple split, and with it #817's
 * count boundary).
 *
 * Returns the tag id to add, or null when no arrangement tag applies
 * ("solid").
 */
export function arrangementToOptTag(arrangement: ColorArrangement): number | null {
  if (arrangement === "gradient") return TAG_GRADIENT;
  if (arrangement === "coextruded") return TAG_COEXTRUDED;
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
  return optTags.filter((t) => t !== TAG_GRADIENT && t !== TAG_COEXTRUDED);
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
 * Used by `<FilamentSwatch>` to lay out the stripes / gradient stops.
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
 * Callers MUST pass every color source (not just the primary `color`):
 * coextruded / gradient members have a `null` primary and their colors live
 * entirely in `secondaryColors`.
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

/**
 * GH #605: seed `FilamentForm`'s color state from a stored value.
 *
 * A stored `null` means the user explicitly cleared the color (the API and
 * schema accept null per OpenPrintTag key 19) — seed `""` so the form shows
 * the cleared state instead of silently resurrecting the gray sentinel on
 * every edit. An absent value (fresh form, prefill without a color) keeps
 * the historical `#808080` default.
 */
export function seedFormColorHex(stored: string | null | undefined): string {
  if (stored === null) return "";
  return stored ?? BLANK_COLOR_HEX;
}

/**
 * GH #605: normalize the raw value of the form's hex TEXT input while the
 * user types. Keeps only hex chars (max 6) behind a single `#` — but when no
 * hex chars remain (box emptied, or every char filtered out) returns `""`,
 * the form's "no color" state. Pre-fix an emptied box normalized to the
 * dangling string `"#"`, which the submit path forwarded verbatim and the
 * model validator rejected — the UI had no way to produce a null color.
 */
export function normalizeColorHexInput(raw: string): string {
  const hexChars = raw
    .trim()
    .replace(/^#/, "")
    .replace(/[^0-9a-fA-F]/g, "");
  return hexChars === "" ? "" : `#${hexChars.slice(0, 6)}`;
}

/**
 * GH #605: map the form's color state to the value submitted to the API.
 *
 *   - coextruded arrangement → null (spec: no primary color — GH #477/#533)
 *   - cleared (`""`) or incomplete (`"#"`, `"#12"`) hex → null (the user
 *     never finished picking a color; persisting the fragment would trip
 *     the `#RRGGBB` model validator, and resurrecting a default would undo
 *     an explicit clear)
 *   - anything else (a full `#RRGGBB`, including the gray sentinel the user
 *     may genuinely have picked) → submitted verbatim
 */
export function submittedColorValue(
  color: string,
  optTags: number[] | null | undefined,
): string | null {
  if (deriveArrangement(optTags) === "coextruded") return null;
  return isIncompleteColorHex(color) ? null : color;
}


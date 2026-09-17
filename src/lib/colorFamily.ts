/**
 * Color facet — derive a filament's color FAMILY (and shade) so the home list
 * can answer "Do I have dark grey filament?" / "What types of orange filament
 * do I have?" color-first, and /inventory can group spools by color.
 *
 * Nothing is stored. The family is derived client-side from exactly what the
 * swatch paints (the `color` hex, else the first secondary) plus color words
 * in the NAME — so there is no schema, API, snapshot, sync, CSV or share
 * change, and no stale-value problem at the many places that write the hex.
 *
 * `colorName` is deliberately NOT read. It isn't in the list projection, and
 * feeding it in made accuracy on a real 82-row library WORSE (80 → 78 exact):
 * typeahead-picked values like "magenta" (#FF00FF reads purple) add noise, and
 * several writers leave it stale when the hex changes. The fix for a misfiled
 * filament is to edit its hex or its name.
 *
 * The thresholds, keyword lists and adjacency set below are a faithful port of
 * the prototype that scored 80/82 exact family (82/82 acceptable) on that
 * library. Two shade bands were retuned on the same data (brown light .58 →
 * .64, pink light .82 → .76) — there is some overfitting risk, which is why
 * `tests/colorFamily.test.ts` pins real-library rows as fixtures. Change a
 * constant here only with those fixtures re-derived, never to fix one row.
 *
 * Membership is ADDITIVE: a filament sold as "Black" whose swatch reads dark
 * gray is listed under BOTH Black and Gray · Dark (`matchReason` reports
 * "swatch" for the second). Letting the name word REPLACE the swatch family
 * answers "no dark grey" for three charcoal blacks; ignoring names drops named
 * blacks from Black. Group-by uses the single `primary` only.
 *
 * Pure + client-safe: the only imports are other pure lib modules (no
 * mongoose, no node built-ins), so client components can import it.
 */

import { deriveArrangement } from "./filamentColors";
import { getSpoolCount, type InventorySpool } from "./inventoryStats";
import { BLANK_COLOR_HEX } from "./cssNamedColors";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Every family, in DISPLAY order (chip row, /inventory group order):
 *  achromatics, then the hue wheel, then the three non-hue buckets. */
export const COLOR_FAMILIES = [
  "black",
  "gray",
  "white",
  "beige",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "clear",
  "multi",
  "unknown",
] as const;
export type ColorFamily = (typeof COLOR_FAMILIES)[number];

export const COLOR_SHADES = ["light", "mid", "dark"] as const;
export type ColorShade = (typeof COLOR_SHADES)[number];

/** Families that carry a shade. black/white/beige have none (a "dark white"
 *  is meaningless, and beige's lightness range is too narrow to split), and
 *  clear/multi/unknown aren't a single lightness at all. */
export const SHADED_FAMILIES = [
  "gray",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const satisfies readonly ColorFamily[];
export type ShadedFamily = (typeof SHADED_FAMILIES)[number];

/** `[darkBelow, lightAtOrAbove]` on OKLab L per shaded family:
 *  `L < dark` → dark, `L >= light` → light, else mid. The bands differ per
 *  family because perceived "light yellow" and "light blue" sit at very
 *  different L. brown's .64 and pink's .76 were retuned (see module doc). */
export const SHADE_BANDS: Readonly<Record<ShadedFamily, readonly [number, number]>> = {
  gray: [0.53, 0.78],
  brown: [0.45, 0.64],
  red: [0.45, 0.7],
  orange: [0.55, 0.8],
  yellow: [0.7, 0.93],
  green: [0.5, 0.8],
  teal: [0.55, 0.82],
  blue: [0.4, 0.7],
  purple: [0.45, 0.75],
  pink: [0.62, 0.76],
};

/** Every valid `?color=` value: each family, plus `family-shade` for the
 *  shaded families only. GENERATED so a new family/shade can't be forgotten
 *  here (16 + 10×3 = 46). */
export type ColorFacet = ColorFamily | `${ShadedFamily}-${ColorShade}`;
export const COLOR_FACET_VALUES: readonly ColorFacet[] = [
  ...COLOR_FAMILIES,
  ...SHADED_FAMILIES.flatMap((fam) =>
    COLOR_SHADES.map((s): ColorFacet => `${fam}-${s}`),
  ),
];

/** A representative dot color per family for the chip UI. Each non-null hex
 *  classifies back into its own family (pinned by a test) so the dot never
 *  contradicts the chip label. clear/multi/unknown have no single color —
 *  null tells the UI to draw a pattern instead. */
export const FAMILY_SWATCH_HEX: Readonly<Record<ColorFamily, string | null>> = {
  black: "#1A1A1A",
  gray: "#8A8A8A",
  white: "#F5F5F5",
  beige: "#E6D5AC",
  brown: "#8B5A2B",
  red: "#D32F2F",
  orange: "#F57C00",
  yellow: "#FBC02D",
  green: "#43A047",
  teal: "#00A5A8",
  blue: "#1E63D6",
  purple: "#8E44AD",
  pink: "#F06292",
  clear: null,
  multi: null,
  unknown: null,
};

/** Color words found in NAMES, per family. Lowercase, accent-free (tokens
 *  are folded the same way before lookup), including German spellings. */
const COLOR_WORDS: Readonly<Record<Exclude<ColorFamily, "clear" | "multi" | "unknown">, string>> = {
  black: "black jet onyx obsidian ebony schwarz noir",
  gray: "grey gray graphite charcoal slate silver ash smoke smoky stone titanium gunmetal anthracite anthrazit grau",
  white: "white snow ivory pearl bone weiss blanc",
  beige: "beige cream sand tan khaki champagne",
  brown: "brown chocolate coffee mocha walnut caramel chestnut espresso wood braun",
  red: "red crimson scarlet burgundy maroon wine ruby rot",
  orange: "orange tangerine",
  yellow: "yellow lemon gold golden mustard daffodil gelb",
  green: "green lime olive mint emerald forest jade sage gruen grun",
  teal: "teal cyan turquoise aqua aquamarine petrol",
  blue: "blue navy cobalt azure sky sapphire indigo blau",
  purple: "purple violet lavender lilac plum grape amethyst lila",
  pink: "pink rose fuchsia magenta salmon rosa",
};

const WORD_FAMILY: ReadonlyMap<string, ColorFamily> = (() => {
  const m = new Map<string, ColorFamily>();
  for (const [fam, words] of Object.entries(COLOR_WORDS)) {
    for (const w of words.split(" ")) m.set(w, fam as ColorFamily);
  }
  return m;
})();

/** Neighboring families on the perceptual wheel. A name word is trusted over
 *  the swatch family only when they're the same or neighbors — so "Rose
 *  Gold" #B76E79 (pink swatch) keeps rose→pink and rejects gold→yellow, and a
 *  name can't drag a blue swatch into Red. Also the relaxation order for an
 *  empty result ("try a neighboring family"). */
const ADJACENT_PAIRS: ReadonlySet<string> = new Set([
  "black|gray",
  "gray|white",
  "white|beige",
  "beige|yellow",
  "beige|brown",
  "brown|red",
  "brown|orange",
  "brown|yellow",
  "brown|gray",
  "red|orange",
  "orange|yellow",
  "yellow|green",
  "green|teal",
  "teal|blue",
  "blue|purple",
  "purple|pink",
  "pink|red",
]);

function isAdjacent(a: ColorFamily, b: ColorFamily): boolean {
  return a === b || ADJACENT_PAIRS.has(`${a}|${b}`) || ADJACENT_PAIRS.has(`${b}|${a}`);
}

/** OptTag ids for see-through finishes (2 = transparent, 3 = translucent;
 *  same ids as `src/lib/filamentFinish.ts`). "Clear" is tag-driven ONLY — an
 *  untagged "Natural" is white or beige, never Clear. */
const TAG_TRANSPARENT = 2;
const TAG_TRANSLUCENT = 3;

// ---------------------------------------------------------------------------
// Color science
// ---------------------------------------------------------------------------

export interface Oklch {
  L: number;
  C: number;
  H: number;
}

const HEX6 = /^#[0-9a-f]{6}$/i;

/** A real color is a trimmed 6-digit hex; anything else (null, "#", "#12",
 *  3-digit shorthand) counts as no color. */
function validHex(hex: unknown): string | null {
  if (typeof hex !== "string") return null;
  const t = hex.trim();
  return HEX6.test(t) ? t : null;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB hex → OKLCH (Ottosson's OKLab matrices). H is degrees in [0, 360).
 *  Expects a valid `#RRGGBB`; callers gate with `validHex`. */
export function hexToOklch(hex: string): Oklch {
  const h = hex.trim();
  const r = srgbToLinear(parseInt(h.slice(1, 3), 16) / 255);
  const g = srgbToLinear(parseInt(h.slice(3, 5), 16) / 255);
  const b = srgbToLinear(parseInt(h.slice(5, 7), 16) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

/** OKLCH → family. Order matters: achromatics first (hue is noise below
 *  C .035), then the low-chroma browns/beiges carved out of the warm hues
 *  before the hue wheel, then red/pink by lightness around 0°. */
export function classifyOklch({ L, C, H }: Oklch): Exclude<ColorFamily, "clear" | "multi" | "unknown"> {
  if (C < 0.035) return L < 0.32 ? "black" : L >= 0.87 ? "white" : "gray";
  if (H >= 15 && H < 95 && L < 0.66 && C < 0.14) return "brown";
  if (H >= 45 && H < 110 && L >= 0.66 && C < 0.1) return "beige";
  if (H >= 340 || H < 10) return L >= 0.6 ? "pink" : "red";
  if (H < 33) return L >= 0.78 || (C < 0.08 && L >= 0.6) ? "pink" : "red";
  if (H < 75) return "orange";
  if (H < 115) return "yellow";
  if (H < 180) return "green";
  if (H < 205) return "teal";
  if (H < 290) return "blue";
  return "purple";
}

/** Shade of lightness `L` within `family`; null for unshaded families. */
export function shadeOf(L: number, family: ColorFamily): ColorShade | null {
  const band = (SHADE_BANDS as Readonly<Record<string, readonly [number, number]>>)[family];
  if (!band) return null;
  return L < band[0] ? "dark" : L >= band[1] ? "light" : "mid";
}

// ---------------------------------------------------------------------------
// Name words
// ---------------------------------------------------------------------------

/** NFD-fold, strip combining marks, ß→ss, lowercase, split on non-letters —
 *  so "Grün", "GRUEN" and "grun" all tokenize comparably. */
function tokens(text: string | null | undefined): string[] {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** Color families named in `name`, left to right. A token that also appears
 *  in the vendor or type is dropped — a vendor like "Blue Ocean" or a line
 *  called "Silk Gold PLA" in the type must not color every product. */
export function nameColorWords(
  name: string | null | undefined,
  vendor: string | null | undefined,
  type: string | null | undefined,
): ColorFamily[] {
  const exclude = new Set([...tokens(vendor), ...tokens(type)]);
  const out: ColorFamily[] = [];
  for (const t of tokens(name)) {
    if (exclude.has(t)) continue;
    const fam = WORD_FAMILY.get(t);
    if (fam) out.push(fam);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filament classification
// ---------------------------------------------------------------------------

/** The minimal filament shape the classifier reads — both home-list rows
 *  (`FilamentSummary`) and adapted /inventory rows fit it. */
export interface ColorClassifiable {
  name?: string | null;
  vendor?: string | null;
  type?: string | null;
  color?: string | null;
  secondaryColors?: string[] | null;
  optTags?: number[] | null;
  hasVariants?: boolean | null;
  spools?: { retired?: boolean | null; totalWeight?: number | null }[] | null;
  totalWeight?: number | null;
}

export interface ColorClassification {
  primary: ColorFamily;
  primaryShade: ColorShade | null;
  /** Every family the filament is listed under, with the shades it's listed
   *  under within that family (empty set = family-level only, e.g. black). */
  members: ReadonlyMap<ColorFamily, ReadonlySet<ColorShade>>;
}

function spoolCount(f: ColorClassifiable): number {
  return getSpoolCount({
    spools: (f.spools ?? undefined) as InventorySpool[] | undefined,
    totalWeight: f.totalWeight ?? null,
    spoolWeight: null,
    netFilamentWeight: null,
  });
}

/** A template (GH #605): has variants and holds no inventory. Colorless by
 *  model, so it never matches on its own color. A LEGACY parent still
 *  holding spools is classified like any other filament. */
function isTemplate(f: ColorClassifiable): boolean {
  return !!f.hasVariants && spoolCount(f) === 0;
}

// Lists are re-scanned once per chip, so classification is memoized per ROW
// OBJECT. Keyed by identity (not _id) so a refetched row with the same _id
// but a new color is re-classified; rows are treated as immutable, as React
// state is. `null` (template) is cached too, hence the `has` check.
const memo = new WeakMap<object, ColorClassification | null>();

export function classifyFilament(f: ColorClassifiable): ColorClassification | null {
  if (memo.has(f)) return memo.get(f)!;
  const result = classifyUncached(f);
  memo.set(f, result);
  return result;
}

function classifyUncached(f: ColorClassifiable): ColorClassification | null {
  if (isTemplate(f)) return null;

  const tags = f.optTags ?? [];
  const seeThrough = tags.includes(TAG_TRANSPARENT) || tags.includes(TAG_TRANSLUCENT);
  const words = nameColorWords(f.name, f.vendor, f.type);

  let color = validHex(f.color);
  // #808080 is the app's blank default (GH #794) — the pre-#605 form stamped
  // it on everything — so it only counts as a real gray when the name says
  // gray. "Overture PETG Grey" #808080 is gray; "— Original" is No color.
  if (color && color.toUpperCase() === BLANK_COLOR_HEX && !words.includes("gray")) {
    color = null;
  }
  const secondaries = (f.secondaryColors ?? [])
    .map(validHex)
    .filter((h): h is string => h !== null);

  const members = new Map<ColorFamily, Set<ColorShade>>();
  const add = (fam: ColorFamily, shade: ColorShade | null) => {
    let set = members.get(fam);
    if (!set) {
      set = new Set();
      members.set(fam, set);
    }
    if (shade) set.add(shade);
  };
  const point = (hex: string) => {
    const o = hexToOklch(hex);
    const family = classifyOklch(o);
    return { family, shade: shadeOf(o.L, family), L: o.L, C: o.C };
  };

  // Coextruded / gradient with ≥2 real colors → Multicolor, and ALSO every
  // color's own family, so a black/charcoal coextrusion shows under Black
  // and Gray · Dark. A solid filament with a stray secondary never gets here.
  if (deriveArrangement(tags) !== "solid") {
    const cols = [color, ...secondaries].filter((c): c is string => c !== null);
    if (cols.length >= 2) {
      add("multi", null);
      for (const c of cols) {
        const p = point(c);
        add(p.family, p.shade);
      }
      if (seeThrough) add("clear", null);
      return { primary: "multi", primaryShade: null, members };
    }
  }

  // Exactly what the swatch paints; further secondaries are ignored.
  const base = color ?? secondaries[0] ?? null;
  let primary: ColorFamily | null = null;
  let primaryShade: ColorShade | null = null;
  if (base) {
    const hx = point(base);
    add(hx.family, hx.shade);
    primary = hx.family;
    primaryShade = hx.shade;
    // Right to left: the color word nearest the end of a name is the most
    // specific ("Prusa Galaxy Black"). A word wins only when the swatch
    // agrees with it — same/neighboring family, or the lenient achromatic
    // checks (a very dark swatch may be named black, etc.).
    for (let i = words.length - 1; i >= 0; i--) {
      const kw = words[i];
      const ok =
        isAdjacent(kw, hx.family) ||
        (kw === "black" && hx.L < 0.4) ||
        (kw === "white" && hx.L >= 0.85) ||
        (kw === "gray" && hx.C < 0.06);
      if (ok) {
        primary = kw;
        primaryShade = kw === hx.family ? hx.shade : shadeOf(hx.L, kw);
        add(kw, primaryShade);
        break;
      }
    }
  } else if (words.length > 0) {
    // No usable swatch: trust the last color word, but claim no shade.
    primary = words[words.length - 1];
    add(primary, null);
  }

  if (seeThrough) {
    add("clear", null);
    // A tinted transparent ("Transparent Red") stays red; a colorless or
    // white/gray-reading one is Clear first.
    if (primary === null || primary === "white" || primary === "gray") {
      primary = "clear";
      primaryShade = null;
    }
  }
  if (primary === null) {
    primary = "unknown";
    add("unknown", null);
  }
  return { primary, primaryShade, members };
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

export interface ParsedColorFacet {
  family: ColorFamily;
  shade: ColorShade | null;
}

/** A facet argument: the raw `?color=` string or an already-parsed facet.
 *  Empty/invalid strings and null mean "no color selected". */
export type ColorFacetInput = string | ParsedColorFacet | null | undefined;

const FACET_SET: ReadonlySet<string> = new Set(COLOR_FACET_VALUES);

/** `"gray"` → gray/any shade, `"gray-dark"` → gray/dark; null for "" or any
 *  value outside `COLOR_FACET_VALUES` (e.g. `"white-dark"`, `"blue-"`). */
export function parseColorFacet(raw: string | null | undefined): ParsedColorFacet | null {
  if (!raw || !FACET_SET.has(raw)) return null;
  const dash = raw.indexOf("-");
  if (dash === -1) return { family: raw as ColorFamily, shade: null };
  return {
    family: raw.slice(0, dash) as ColorFamily,
    shade: raw.slice(dash + 1) as ColorShade,
  };
}

function toFacet(facet: ColorFacetInput): ParsedColorFacet | null {
  if (facet == null || typeof facet === "string") return parseColorFacet(facet);
  return facet;
}

function formatFacet(facet: ParsedColorFacet): ColorFacet {
  return (facet.shade ? `${facet.family}-${facet.shade}` : facet.family) as ColorFacet;
}

/** Is `f` listed under `facet`? False for templates and for an empty/invalid
 *  facet (a membership test, not a filter — use `scopeByColorFacet` for that). */
export function matchesColorFacet(f: ColorClassifiable, facet: ColorFacetInput): boolean {
  const parsed = toFacet(facet);
  if (!parsed) return false;
  const c = classifyFilament(f);
  if (!c) return false;
  const shades = c.members.get(parsed.family);
  if (!shades) return false;
  return parsed.shade === null || shades.has(parsed.shade);
}

/** Why `f` matches `facet`: "primary" when it's the filament's own family
 *  (and shade, if one is asked for); "swatch" when it matched only through
 *  a swatch color's additive membership — e.g. named Black, swatch dark gray,
 *  under Gray · Dark — so the UI can say so; "tag" when it matched Clear only
 *  through its transparent/translucent optTag (Clear membership never comes
 *  from a swatch hex, so "its swatch also reads Clear" would be false); null
 *  when it doesn't match. */
export function matchReason(
  f: ColorClassifiable,
  facet: ColorFacetInput,
): "primary" | "swatch" | "tag" | null {
  const parsed = toFacet(facet);
  if (!parsed || !matchesColorFacet(f, parsed)) return null;
  const c = classifyFilament(f)!;
  const isPrimary =
    c.primary === parsed.family && (parsed.shade === null || c.primaryShade === parsed.shade);
  if (isPrimary) return "primary";
  return parsed.family === "clear" ? "tag" : "swatch";
}

/** Narrow a list to `facet`: matching rows, plus the templates that head at
 *  least one matching variant (a template never matches on its own color),
 *  in input order. Returns the SAME array reference for an empty/invalid
 *  facet so downstream `useMemo`s see no change when no color is picked. */
export function scopeByColorFacet<
  F extends ColorClassifiable & { _id: string; parentId?: string | null },
>(list: F[], facet: ColorFacetInput): F[] {
  const parsed = toFacet(facet);
  if (!parsed) return list;
  const matching = new Set<F>();
  const parentsOfMatching = new Set<string>();
  for (const f of list) {
    if (!matchesColorFacet(f, parsed)) continue;
    matching.add(f);
    if (f.parentId) parentsOfMatching.add(f.parentId);
  }
  return list.filter((f) => matching.has(f) || parentsOfMatching.has(f._id));
}

export interface TypeBreakdownEntry {
  type: string;
  inStock: number;
  outOfStock: number;
}

/** Per exact type (PCTG and PCTG-CF stay separate, so clicking one can set
 *  `?type=` exactly) over the non-template rows matching `facet` (all
 *  non-template rows when no facet): how many are in / out of stock. In stock
 *  defaults to `getSpoolCount > 0` — the home list's own rule, so legacy
 *  single-spool rolls count. Sorted by in-stock desc, total desc, type asc. */
export function typeBreakdown(
  list: readonly ColorClassifiable[],
  facet?: ColorFacetInput,
  isInStock: (f: ColorClassifiable) => boolean = (f) => spoolCount(f) > 0,
): TypeBreakdownEntry[] {
  const parsed = toFacet(facet);
  const byType = new Map<string, TypeBreakdownEntry>();
  for (const f of list) {
    if (!classifyFilament(f)) continue; // template
    if (parsed && !matchesColorFacet(f, parsed)) continue;
    if (!f.type) continue; // can't be selected as ?type=
    let entry = byType.get(f.type);
    if (!entry) {
      entry = { type: f.type, inStock: 0, outOfStock: 0 };
      byType.set(f.type, entry);
    }
    if (isInStock(f)) entry.inStock++;
    else entry.outOfStock++;
  }
  return [...byType.values()].sort(
    (a, b) =>
      b.inStock - a.inStock ||
      b.inStock + b.outOfStock - (a.inStock + a.outOfStock) ||
      // Types are Map keys, so never equal here.
      (a.type < b.type ? -1 : 1),
  );
}

export type ColorRelaxation =
  | { kind: "dropShade"; facet: ColorFacet; count: number }
  | { kind: "allMaterials" }
  | { kind: "adjacent"; facet: ColorFacet; count: number };

export interface RelaxColorQueryOptions {
  /** The active `?type=` filter ("" when none). */
  typeFilter: string;
  /** Which matching rows to count (e.g. the home list's visibility rule).
   *  Defaults to every matching non-template row. */
  countRow?: (f: ColorClassifiable) => boolean;
}

/** Next steps for an empty color result, in order: drop the shade (with its
 *  count), look in all materials (clears type — no count, because the fetched
 *  list is already type-filtered), then the best neighboring family (same
 *  shade when that family is shaded). Never "nearest color distance": on the
 *  real library that ranked the #808080 default first for dark-grey PLA.
 *  Returns [] when nothing helps. */
export function relaxColorQuery(
  fullList: readonly ColorClassifiable[],
  facet: ColorFacetInput,
  opts: RelaxColorQueryOptions,
): ColorRelaxation[] {
  const parsed = toFacet(facet);
  if (!parsed) return [];
  const countRow = opts.countRow ?? (() => true);
  const count = (fc: ParsedColorFacet) =>
    fullList.filter((f) => matchesColorFacet(f, fc) && countRow(f)).length;

  const out: ColorRelaxation[] = [];
  if (parsed.shade) {
    const wide = { family: parsed.family, shade: null };
    const n = count(wide);
    if (n > 0) out.push({ kind: "dropShade", facet: formatFacet(wide), count: n });
  }
  if (opts.typeFilter.trim() !== "") out.push({ kind: "allMaterials" });

  let best: { facet: ParsedColorFacet; count: number } | null = null;
  // COLOR_FAMILIES order breaks ties (strict `>`).
  for (const fam of COLOR_FAMILIES) {
    if (fam === parsed.family || !isAdjacent(fam, parsed.family)) continue;
    const shaded = (SHADED_FAMILIES as readonly string[]).includes(fam);
    const candidate = { family: fam, shade: shaded ? parsed.shade : null };
    const n = count(candidate);
    if (n > 0 && (!best || n > best.count)) best = { facet: candidate, count: n };
  }
  if (best) out.push({ kind: "adjacent", facet: formatFacet(best.facet), count: best.count });
  return out;
}

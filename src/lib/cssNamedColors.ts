/**
 * CSS Color Module Level 4 named colors → 6-digit hex.
 *
 * Used by `FilamentForm`'s colorName typeahead so typing a recognised
 * color name auto-populates the hex picker. Stored as a flat literal
 * rather than a Map so it's static (no init cost, tree-shakes cleanly,
 * trivially type-checked).
 *
 * All names are lowercase here; lookups are case-insensitive via
 * `lookupCssNamedColor`. The list is the 148 named colors from
 * https://www.w3.org/TR/css-color-4/#named-colors plus the 9 system
 * shorthand synonyms (cyan/aqua, magenta/fuchsia, etc.) that the spec
 * lists as aliases.
 */

/**
 * GH #794: the app-wide "no color chosen" sentinel. `FilamentForm`'s
 * `<input type="color">` can never hold an empty string, so a fresh filament's
 * `color` is seeded to this gray. A committed color NAME may fill a blank hex
 * but must NOT overwrite a hex the user actually picked.
 */
export const BLANK_COLOR_HEX = "#808080";

/**
 * Is this hex INCOMPLETE — empty/null, a bare `"#"` (what `FilamentForm`'s text
 * input stores when cleared), a partial `"#12"` while typing, or otherwise not a
 * full `#RRGGBB`? Such a value isn't a real color, so a color-name commit should
 * fill it rather than leave an invalid value that trips the `#RRGGBB` model
 * validator (Codex P2 on #794). NOTE: the gray sentinel `#808080` is a VALID
 * hex and is NOT incomplete — distinguishing "the user picked gray" from "no
 * color chosen" needs intent tracking in the form, not this predicate.
 */
export function isIncompleteColorHex(hex: string | null | undefined): boolean {
  if (!hex) return true;
  return !/^#[0-9A-Fa-f]{6}$/.test(hex.trim());
}

/**
 * Is this hex "blank" — incomplete (see {@link isIncompleteColorHex}) OR the
 * gray "no color chosen" sentinel? Used to decide whether a LOADED filament's
 * color counts as user-owned: a stored real color is owned, a stored sentinel
 * gray is treated as unchosen so a name can still gap-fill it (#794).
 */
export function isBlankColorHex(hex: string | null | undefined): boolean {
  if (isIncompleteColorHex(hex)) return true;
  return hex!.trim().toUpperCase() === BLANK_COLOR_HEX;
}

const CSS_NAMED_COLORS: Record<string, string> = {
  aliceblue: "#F0F8FF",
  antiquewhite: "#FAEBD7",
  aqua: "#00FFFF",
  aquamarine: "#7FFFD4",
  azure: "#F0FFFF",
  beige: "#F5F5DC",
  bisque: "#FFE4C4",
  black: "#000000",
  blanchedalmond: "#FFEBCD",
  blue: "#0000FF",
  blueviolet: "#8A2BE2",
  brown: "#A52A2A",
  burlywood: "#DEB887",
  cadetblue: "#5F9EA0",
  chartreuse: "#7FFF00",
  chocolate: "#D2691E",
  coral: "#FF7F50",
  cornflowerblue: "#6495ED",
  cornsilk: "#FFF8DC",
  crimson: "#DC143C",
  cyan: "#00FFFF",
  darkblue: "#00008B",
  darkcyan: "#008B8B",
  darkgoldenrod: "#B8860B",
  darkgray: "#A9A9A9",
  darkgreen: "#006400",
  darkgrey: "#A9A9A9",
  darkkhaki: "#BDB76B",
  darkmagenta: "#8B008B",
  darkolivegreen: "#556B2F",
  darkorange: "#FF8C00",
  darkorchid: "#9932CC",
  darkred: "#8B0000",
  darksalmon: "#E9967A",
  darkseagreen: "#8FBC8F",
  darkslateblue: "#483D8B",
  darkslategray: "#2F4F4F",
  darkslategrey: "#2F4F4F",
  darkturquoise: "#00CED1",
  darkviolet: "#9400D3",
  deeppink: "#FF1493",
  deepskyblue: "#00BFFF",
  dimgray: "#696969",
  dimgrey: "#696969",
  dodgerblue: "#1E90FF",
  firebrick: "#B22222",
  floralwhite: "#FFFAF0",
  forestgreen: "#228B22",
  fuchsia: "#FF00FF",
  gainsboro: "#DCDCDC",
  ghostwhite: "#F8F8FF",
  gold: "#FFD700",
  goldenrod: "#DAA520",
  gray: "#808080",
  green: "#008000",
  greenyellow: "#ADFF2F",
  grey: "#808080",
  honeydew: "#F0FFF0",
  hotpink: "#FF69B4",
  indianred: "#CD5C5C",
  indigo: "#4B0082",
  ivory: "#FFFFF0",
  khaki: "#F0E68C",
  lavender: "#E6E6FA",
  lavenderblush: "#FFF0F5",
  lawngreen: "#7CFC00",
  lemonchiffon: "#FFFACD",
  lightblue: "#ADD8E6",
  lightcoral: "#F08080",
  lightcyan: "#E0FFFF",
  lightgoldenrodyellow: "#FAFAD2",
  lightgray: "#D3D3D3",
  lightgreen: "#90EE90",
  lightgrey: "#D3D3D3",
  lightpink: "#FFB6C1",
  lightsalmon: "#FFA07A",
  lightseagreen: "#20B2AA",
  lightskyblue: "#87CEFA",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  lightsteelblue: "#B0C4DE",
  lightyellow: "#FFFFE0",
  lime: "#00FF00",
  limegreen: "#32CD32",
  linen: "#FAF0E6",
  magenta: "#FF00FF",
  maroon: "#800000",
  mediumaquamarine: "#66CDAA",
  mediumblue: "#0000CD",
  mediumorchid: "#BA55D3",
  mediumpurple: "#9370DB",
  mediumseagreen: "#3CB371",
  mediumslateblue: "#7B68EE",
  mediumspringgreen: "#00FA9A",
  mediumturquoise: "#48D1CC",
  mediumvioletred: "#C71585",
  midnightblue: "#191970",
  mintcream: "#F5FFFA",
  mistyrose: "#FFE4E1",
  moccasin: "#FFE4B5",
  navajowhite: "#FFDEAD",
  navy: "#000080",
  oldlace: "#FDF5E6",
  olive: "#808000",
  olivedrab: "#6B8E23",
  orange: "#FFA500",
  orangered: "#FF4500",
  orchid: "#DA70D6",
  palegoldenrod: "#EEE8AA",
  palegreen: "#98FB98",
  paleturquoise: "#AFEEEE",
  palevioletred: "#DB7093",
  papayawhip: "#FFEFD5",
  peachpuff: "#FFDAB9",
  peru: "#CD853F",
  pink: "#FFC0CB",
  plum: "#DDA0DD",
  powderblue: "#B0E0E6",
  purple: "#800080",
  rebeccapurple: "#663399",
  red: "#FF0000",
  rosybrown: "#BC8F8F",
  royalblue: "#4169E1",
  saddlebrown: "#8B4513",
  salmon: "#FA8072",
  sandybrown: "#F4A460",
  seagreen: "#2E8B57",
  seashell: "#FFF5EE",
  sienna: "#A0522D",
  silver: "#C0C0C0",
  skyblue: "#87CEEB",
  slateblue: "#6A5ACD",
  slategray: "#708090",
  slategrey: "#708090",
  snow: "#FFFAFA",
  springgreen: "#00FF7F",
  steelblue: "#4682B4",
  tan: "#D2B48C",
  teal: "#008080",
  thistle: "#D8BFD8",
  tomato: "#FF6347",
  turquoise: "#40E0D0",
  violet: "#EE82EE",
  wheat: "#F5DEB3",
  white: "#FFFFFF",
  whitesmoke: "#F5F5F5",
  yellow: "#FFFF00",
  yellowgreen: "#9ACD32",
};

/**
 * Look up a CSS named color by name. Case- and whitespace-insensitive
 * (callers can pass "Dark Slate Gray", " navy ", or "NAVY" — all
 * resolve). Returns the uppercase 6-digit hex, or `null` for unknown
 * names. Callers that need to differentiate "no match" from "fall back
 * to another source" should check for null explicitly.
 */
export function lookupCssNamedColor(name: string): string | null {
  const key = name.replace(/\s+/g, "").toLowerCase();
  return CSS_NAMED_COLORS[key] ?? null;
}

/**
 * All CSS named colors as `{ name, hex }` pairs, sorted alphabetically.
 * Used by the colorName typeahead to render the "Standard colors"
 * suggestion section. The display name preserves the canonical CSS
 * spelling (lowercase, no spaces) so the suggestion text matches what
 * the user can type to get back to the same entry.
 */
export const CSS_NAMED_COLOR_LIST: ReadonlyArray<{ name: string; hex: string }> = Object.entries(
  CSS_NAMED_COLORS,
)
  .map(([name, hex]) => ({ name, hex }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Single entry in the colorName typeahead dropdown. `source` drives the
 * section header — DB suggestions ("From your filaments") render above
 * the CSS named-color group ("Standard colors").
 */
export interface ColorSuggestion {
  name: string;
  hex: string;
  source: "db" | "css";
}

/**
 * Merge the user's previously-saved (colorName, color) pairs with the
 * CSS named-color list and substring-filter by a query string. Returns
 * a deduped, ordered list ready to render in the dropdown.
 *
 * Ordering:
 *   1. DB matches first (the user's own naming wins — same hex they
 *      reached for last time is the most relevant suggestion).
 *   2. CSS named colors second.
 * Within each source, entries preserve the order they came in
 * (suggestions arrive sorted alphabetically from the API; the CSS
 * list is sorted alphabetically at module load).
 *
 * Dedup key is `(lowercase name, uppercase hex)` — a DB row with the
 * exact same name+hex as a CSS entry is rendered once, with DB
 * winning. Different hexes under the same name are kept as separate
 * suggestions (intentional — different brands of "Galaxy Black"
 * legitimately have different shades).
 */
export function filterColorSuggestions(
  dbSuggestions: readonly ColorSuggestion[],
  query: string,
  maxResults = 30,
): ColorSuggestion[] {
  const q = query.replace(/\s+/g, "").toLowerCase();
  const matchesQuery = (s: ColorSuggestion) =>
    !q || s.name.replace(/\s+/g, "").toLowerCase().includes(q);
  const cssMatches: ColorSuggestion[] = CSS_NAMED_COLOR_LIST.filter((c) =>
    !q || c.name.toLowerCase().includes(q),
  ).map((c) => ({ name: c.name, hex: c.hex, source: "css" }));
  const dbMatches = dbSuggestions.filter(matchesQuery);

  const seen = new Set<string>();
  const key = (s: ColorSuggestion) =>
    `${s.name.replace(/\s+/g, "").toLowerCase()}::${s.hex.toUpperCase()}`;
  const merged: ColorSuggestion[] = [];
  for (const s of [...dbMatches, ...cssMatches]) {
    const k = key(s);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(s);
    if (merged.length >= maxResults) break;
  }
  return merged;
}

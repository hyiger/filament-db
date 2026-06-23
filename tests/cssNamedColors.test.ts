import { describe, it, expect } from "vitest";
import {
  CSS_NAMED_COLOR_LIST,
  filterColorSuggestions,
  lookupCssNamedColor,
  isBlankColorHex,
  isIncompleteColorHex,
  BLANK_COLOR_HEX,
  type ColorSuggestion,
} from "@/lib/cssNamedColors";

/**
 * The CSS named-color module powers `FilamentForm`'s colorName
 * typeahead. Two invariants:
 *   1. `lookupCssNamedColor` is case- and whitespace-insensitive so the
 *      input's onBlur "exact match → hex" path doesn't fail on "NAVY",
 *      "Dark Slate Gray", or padded strings.
 *   2. `filterColorSuggestions` merges the user's DB suggestions with
 *      the CSS named-color list, dedupes by (name, hex), and keeps DB
 *      entries ahead of CSS ones when both qualify.
 */
describe("lookupCssNamedColor", () => {
  it("returns the canonical hex for a known lowercase name", () => {
    expect(lookupCssNamedColor("red")).toBe("#FF0000");
    expect(lookupCssNamedColor("navy")).toBe("#000080");
    expect(lookupCssNamedColor("rebeccapurple")).toBe("#663399");
  });

  it("is case-insensitive", () => {
    expect(lookupCssNamedColor("NAVY")).toBe("#000080");
    expect(lookupCssNamedColor("Navy")).toBe("#000080");
  });

  it("ignores whitespace within the name", () => {
    expect(lookupCssNamedColor("Dark Slate Gray")).toBe("#2F4F4F");
    expect(lookupCssNamedColor("  navy  ")).toBe("#000080");
    expect(lookupCssNamedColor("light Sea green")).toBe("#20B2AA");
  });

  it("returns null for unknown names", () => {
    expect(lookupCssNamedColor("galaxy black")).toBeNull();
    expect(lookupCssNamedColor("prusa orange")).toBeNull();
    expect(lookupCssNamedColor("")).toBeNull();
  });

  it("handles the gray/grey synonyms", () => {
    expect(lookupCssNamedColor("gray")).toBe("#808080");
    expect(lookupCssNamedColor("grey")).toBe("#808080");
    expect(lookupCssNamedColor("darkgray")).toBe("#A9A9A9");
    expect(lookupCssNamedColor("darkgrey")).toBe("#A9A9A9");
  });
});

describe("CSS_NAMED_COLOR_LIST", () => {
  it("is sorted alphabetically by name", () => {
    for (let i = 1; i < CSS_NAMED_COLOR_LIST.length; i++) {
      expect(
        CSS_NAMED_COLOR_LIST[i - 1].name.localeCompare(CSS_NAMED_COLOR_LIST[i].name),
      ).toBeLessThanOrEqual(0);
    }
  });

  it("includes the full CSS Color Module Level 4 set", () => {
    // Spot-check a handful of distinctive entries to catch accidental
    // truncation of the static map.
    const names = new Set(CSS_NAMED_COLOR_LIST.map((c) => c.name));
    for (const expected of [
      "aliceblue",
      "blueviolet",
      "cornflowerblue",
      "darkslategrey",
      "rebeccapurple",
      "yellowgreen",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
    // 148 named + 9 synonyms (the spec lists aqua/cyan, fuchsia/magenta,
    // dark/lightgray-grey, dim/slategray-grey as aliases). Don't pin the
    // exact count — bump-resistant.
    expect(CSS_NAMED_COLOR_LIST.length).toBeGreaterThanOrEqual(140);
  });
});

describe("filterColorSuggestions", () => {
  const dbPrusaOrange: ColorSuggestion = { name: "Prusa Orange", hex: "#FA6E1C", source: "db" };
  const dbGalaxyBlack: ColorSuggestion = { name: "Galaxy Black", hex: "#0D0D14", source: "db" };

  it("returns CSS-only suggestions when DB is empty and query is empty", () => {
    const result = filterColorSuggestions([], "", 5);
    expect(result.length).toBe(5);
    for (const r of result) {
      expect(r.source).toBe("css");
    }
  });

  it("places DB matches before CSS matches", () => {
    const result = filterColorSuggestions([dbPrusaOrange, dbGalaxyBlack], "", 30);
    // First two should be DB; rest should be CSS
    expect(result[0].source).toBe("db");
    expect(result[1].source).toBe("db");
    expect(result[2].source).toBe("css");
  });

  it("substring-matches case- and whitespace-insensitively", () => {
    const result = filterColorSuggestions([dbPrusaOrange], "ORANGE");
    const names = result.map((r) => r.name.toLowerCase());
    expect(names).toContain("prusa orange");
    expect(names).toContain("orange"); // CSS
    expect(names).toContain("darkorange"); // CSS
  });

  it("dedupes a DB row with the same (name, hex) as a CSS entry — DB wins", () => {
    // Pretend the user once named a filament "navy" with the canonical CSS hex.
    const dup: ColorSuggestion = { name: "navy", hex: "#000080", source: "db" };
    const result = filterColorSuggestions([dup], "navy", 30);
    const navyEntries = result.filter((r) => r.name.toLowerCase() === "navy");
    expect(navyEntries.length).toBe(1);
    expect(navyEntries[0].source).toBe("db");
  });

  it("keeps different hexes under the same name as separate suggestions", () => {
    const a: ColorSuggestion = { name: "Galaxy Black", hex: "#0D0D14", source: "db" };
    const b: ColorSuggestion = { name: "Galaxy Black", hex: "#1A1A2E", source: "db" };
    const result = filterColorSuggestions([a, b], "galaxy");
    const galaxy = result.filter((r) => r.name === "Galaxy Black");
    expect(galaxy.length).toBe(2);
    expect(galaxy.map((g) => g.hex.toUpperCase()).sort()).toEqual(["#0D0D14", "#1A1A2E"]);
  });

  it("respects the maxResults cap", () => {
    const result = filterColorSuggestions([], "", 3);
    expect(result.length).toBe(3);
  });

  it("returns an empty list when nothing matches a non-empty query", () => {
    const result = filterColorSuggestions([], "thiscolordoesnotexistanywhere");
    expect(result).toEqual([]);
  });
});

describe("isBlankColorHex (GH #794)", () => {
  it("treats the gray sentinel as blank (any case / surrounding space)", () => {
    expect(isBlankColorHex(BLANK_COLOR_HEX)).toBe(true);
    expect(isBlankColorHex("#808080")).toBe(true);
    expect(isBlankColorHex("#808080".toLowerCase())).toBe(true);
    expect(isBlankColorHex("  #808080  ")).toBe(true);
  });

  it("treats null/undefined/empty as blank (defensive — the picker never emits them)", () => {
    expect(isBlankColorHex(null)).toBe(true);
    expect(isBlankColorHex(undefined)).toBe(true);
    expect(isBlankColorHex("")).toBe(true);
  });

  it("treats an incomplete/cleared hex as blank — FilamentForm stores '#' when the text field is emptied (Codex P2)", () => {
    expect(isBlankColorHex("#")).toBe(true); // text field cleared
    expect(isBlankColorHex("#12")).toBe(true); // mid-typing
    expect(isBlankColorHex("#1234")).toBe(true);
    expect(isBlankColorHex("#1234567")).toBe(true); // too long
    expect(isBlankColorHex("not-a-hex")).toBe(true);
  });

  it("treats a real user-picked hex as NOT blank — a name commit must not clobber it", () => {
    expect(isBlankColorHex("#FA6E1C")).toBe(false);
    expect(isBlankColorHex("#000080")).toBe(false);
    expect(isBlankColorHex("#000000")).toBe(false);
    expect(isBlankColorHex("#ffffff")).toBe(false);
  });
});

describe("isIncompleteColorHex (GH #794 Codex P2 — sentinel-exclusive)", () => {
  it("is true for empty / cleared / partial / garbage values", () => {
    expect(isIncompleteColorHex(null)).toBe(true);
    expect(isIncompleteColorHex(undefined)).toBe(true);
    expect(isIncompleteColorHex("")).toBe(true);
    expect(isIncompleteColorHex("#")).toBe(true); // text field cleared
    expect(isIncompleteColorHex("#12")).toBe(true); // mid-typing
    expect(isIncompleteColorHex("#1234567")).toBe(true); // too long
    expect(isIncompleteColorHex("nope")).toBe(true);
  });

  it("is FALSE for any complete #RRGGBB — INCLUDING the gray sentinel, so a user CAN deliberately pick gray", () => {
    expect(isIncompleteColorHex("#FA6E1C")).toBe(false);
    // The crux of the Codex P2 fix: #808080 is a real, complete hex. Unlike
    // isBlankColorHex, this predicate does NOT treat it as fillable — a user who
    // picks gray owns it (the form tracks that intent separately).
    expect(isIncompleteColorHex(BLANK_COLOR_HEX)).toBe(false);
    expect(isIncompleteColorHex("#808080")).toBe(false);
    expect(isIncompleteColorHex("  #000000  ")).toBe(false);
  });
});

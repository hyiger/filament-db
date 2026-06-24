/**
 * GH #477 — Phase 1 unit tests for the multi-color helpers in
 * src/lib/filamentColors.ts. Pure functions, no DB / DOM env required.
 */
import { describe, it, expect } from "vitest";
import {
  deriveArrangement,
  arrangementToOptTag,
  displayColor,
  allColors,
  isMultiColor,
  parentSwatchColors,
  type ColorArrangement,
} from "@/lib/filamentColors";

describe("deriveArrangement", () => {
  it("returns 'solid' for null/undefined/empty optTags", () => {
    expect(deriveArrangement(null)).toBe("solid");
    expect(deriveArrangement(undefined)).toBe("solid");
    expect(deriveArrangement([])).toBe("solid");
  });

  // GH #507: canonical OPT_TAG ids — 27 = gradient, 28 = dual_color,
  // 29 = triple_color. Both dual and triple render as coextruded.
  it("returns 'coextruded' when tag 28 (dual_color) is present", () => {
    expect(deriveArrangement([28])).toBe("coextruded");
    expect(deriveArrangement([16, 28])).toBe("coextruded"); // tag 16 = MATTE
  });

  it("returns 'coextruded' when tag 29 (triple_color) is present", () => {
    expect(deriveArrangement([29])).toBe("coextruded");
  });

  it("returns 'gradient' when tag 27 (gradient) is present", () => {
    expect(deriveArrangement([27])).toBe("gradient");
    expect(deriveArrangement([3, 27])).toBe("gradient");
  });

  it("returns 'coextruded' when both coextruded and gradient tags are present (coextruded wins)", () => {
    // A "coextruded gradient" is theoretically possible per OpenPrintTag
    // spec; the rendering UI can only pick one mode, so the more
    // structural property (cross-section) wins over change-over-time.
    expect(deriveArrangement([27, 28])).toBe("coextruded");
    expect(deriveArrangement([29, 27])).toBe("coextruded");
  });

  it("returns 'solid' when only non-arrangement tags are present", () => {
    // Tags 1–5 are FOOD_SAFE/BIODEGRADABLE/ABRASIVE/WATER_SOLUBLE/UV_RESISTANT etc;
    // none of them describe color arrangement.
    expect(deriveArrangement([1, 2, 3, 4, 5])).toBe("solid");
  });

  it("type-checks to ColorArrangement", () => {
    const result: ColorArrangement = deriveArrangement([28]);
    expect(["solid", "coextruded", "gradient"]).toContain(result);
  });
});

describe("arrangementToOptTag", () => {
  it("maps gradient to tag 27", () => {
    expect(arrangementToOptTag("gradient", 0)).toBe(27);
    expect(arrangementToOptTag("gradient", 4)).toBe(27);
  });

  it("returns null for a solid arrangement", () => {
    expect(arrangementToOptTag("solid", 0)).toBeNull();
    expect(arrangementToOptTag("solid", 2)).toBeNull();
  });

  // GH #817: a coextruded filament persists a null primary, so the color
  // count equals secondaryColors.length. A 2-color coextruded (2 secondaries)
  // must be dual_color (28), not triple_color (29).
  it("maps a 2-secondary coextruded to dual_color (28), not triple", () => {
    expect(arrangementToOptTag("coextruded", 2)).toBe(28);
  });

  it("maps a 1-secondary coextruded to dual_color (28)", () => {
    expect(arrangementToOptTag("coextruded", 1)).toBe(28);
  });

  it("maps a 3+-secondary coextruded to triple_color (29)", () => {
    expect(arrangementToOptTag("coextruded", 3)).toBe(29);
    expect(arrangementToOptTag("coextruded", 5)).toBe(29);
  });
});

describe("displayColor", () => {
  it("returns gray sentinel for null/undefined input", () => {
    expect(displayColor(null)).toBe("#808080");
    expect(displayColor(undefined)).toBe("#808080");
  });

  it("returns the primary color when it's set", () => {
    expect(displayColor({ color: "#FF0000" })).toBe("#FF0000");
    expect(
      displayColor({ color: "#FF0000", secondaryColors: ["#00FF00"] }),
    ).toBe("#FF0000");
  });

  it("falls back to secondaryColors[0] when primary is null (coextruded case)", () => {
    expect(
      displayColor({ color: null, secondaryColors: ["#00FF00", "#0000FF"] }),
    ).toBe("#00FF00");
  });

  it("falls back to secondaryColors[0] when primary is empty string", () => {
    expect(
      displayColor({ color: "", secondaryColors: ["#00FF00"] }),
    ).toBe("#00FF00");
  });

  it("returns gray sentinel when both primary and secondaryColors are absent", () => {
    expect(displayColor({})).toBe("#808080");
    expect(displayColor({ color: null })).toBe("#808080");
    expect(displayColor({ color: null, secondaryColors: [] })).toBe("#808080");
  });
});

describe("allColors", () => {
  it("returns empty array for null/undefined input", () => {
    expect(allColors(null)).toEqual([]);
    expect(allColors(undefined)).toEqual([]);
  });

  it("returns primary first, then each secondary in order", () => {
    expect(
      allColors({
        color: "#FF0000",
        secondaryColors: ["#00FF00", "#0000FF"],
      }),
    ).toEqual(["#FF0000", "#00FF00", "#0000FF"]);
  });

  it("skips null/empty primary so the array starts with secondaryColors[0]", () => {
    expect(
      allColors({
        color: null,
        secondaryColors: ["#00FF00", "#0000FF"],
      }),
    ).toEqual(["#00FF00", "#0000FF"]);
    expect(
      allColors({ color: "", secondaryColors: ["#00FF00"] }),
    ).toEqual(["#00FF00"]);
  });

  it("skips null/empty secondary entries (defensive — schema validates but lean reads might surface them)", () => {
    expect(
      allColors({
        color: "#FF0000",
        secondaryColors: ["#00FF00", null as unknown as string, "#0000FF", ""],
      }),
    ).toEqual(["#FF0000", "#00FF00", "#0000FF"]);
  });

  it("returns empty when no usable colors at all", () => {
    expect(allColors({})).toEqual([]);
    expect(allColors({ color: null, secondaryColors: [] })).toEqual([]);
    expect(allColors({ color: "", secondaryColors: ["", null as unknown as string] })).toEqual([]);
  });
});

describe("isMultiColor", () => {
  it("returns false for null/undefined input", () => {
    expect(isMultiColor(null)).toBe(false);
    expect(isMultiColor(undefined)).toBe(false);
  });

  it("returns false for plain single-color filament", () => {
    expect(isMultiColor({ color: "#FF0000" })).toBe(false);
    expect(isMultiColor({ color: "#FF0000", secondaryColors: [] })).toBe(false);
    expect(isMultiColor({ color: "#FF0000", optTags: [5] })).toBe(false); // matte, not arrangement
  });

  it("returns true when secondaryColors has at least one entry", () => {
    expect(
      isMultiColor({ color: "#FF0000", secondaryColors: ["#00FF00"] }),
    ).toBe(true);
  });

  it("returns true when an arrangement tag is set (even with no secondary colors)", () => {
    // Edge case: a misconfigured filament with the coextruded tag but no
    // secondary colors yet. Still "multi-color" in intent — the form
    // should show the arrangement radio so the user can add slots.
    expect(isMultiColor({ color: "#FF0000", optTags: [29] })).toBe(true);
    expect(isMultiColor({ color: "#FF0000", optTags: [28] })).toBe(true);
  });

  it("returns true when both arrangement tag AND secondaryColors are set", () => {
    expect(
      isMultiColor({
        color: "#FF0000",
        secondaryColors: ["#00FF00"],
        optTags: [29],
      }),
    ).toBe(true);
  });
});

describe("parentSwatchColors (GH #597)", () => {
  it("keeps the given order (caller puts parent colors first, then variants)", () => {
    expect(parentSwatchColors(["#0000FF", "#000000", "#FF0000"])).toEqual([
      "#0000FF",
      "#000000",
      "#FF0000",
    ]);
  });

  it("works with a null leading primary (pure grouping / coextruded parent)", () => {
    expect(parentSwatchColors([null, "#000000", "#FFFFFF"])).toEqual(["#000000", "#FFFFFF"]);
    expect(parentSwatchColors([undefined, "#abc"])).toEqual(["#abc"]);
  });

  it("flattens secondary colors of a coextruded member (Codex P2 #600)", () => {
    // A coextruded parent: color=null, secondaries red/green; plus a solid
    // black variant. Caller passes [color, ...parentSecondaries, ...variant].
    expect(parentSwatchColors([null, "#FF0000", "#00FF00", "#000000"])).toEqual([
      "#FF0000",
      "#00FF00",
      "#000000",
    ]);
  });

  it("dedupes case-insensitively, keeping the first occurrence's casing", () => {
    expect(parentSwatchColors(["#FF0000", "#ff0000", "#00FF00"])).toEqual([
      "#FF0000",
      "#00FF00",
    ]);
  });

  it("drops null / empty / non-hex / wrong-length entries", () => {
    expect(
      parentSwatchColors(["#00FF00", null, "", "   ", "blue", "#12", "#1234567", "#GGG"]),
    ).toEqual(["#00FF00"]);
  });

  it("accepts both #rgb and #rrggbb and trims whitespace", () => {
    expect(parentSwatchColors(["  #abc  ", "  #aabbcc  "])).toEqual(["#abc", "#aabbcc"]);
  });

  it("returns [] when nothing valid is known (caller falls back to cross-hatch)", () => {
    expect(parentSwatchColors([])).toEqual([]);
    expect(parentSwatchColors([null, "nope", ""])).toEqual([]);
  });
});

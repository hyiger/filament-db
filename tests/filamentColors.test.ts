/**
 * GH #477 — Phase 1 unit tests for the multi-color helpers in
 * src/lib/filamentColors.ts. Pure functions, no DB / DOM env required.
 */
import { describe, it, expect } from "vitest";
import {
  deriveArrangement,
  arrangementToOptTag,
  stripArrangementTags,
  displayColor,
  allColors,
  parentSwatchColors,
  seedFormColorHex,
  normalizeColorHexInput,
  submittedColorValue,
  type ColorArrangement,
} from "@/lib/filamentColors";
import { BLANK_COLOR_HEX } from "@/lib/cssNamedColors";

describe("deriveArrangement", () => {
  it("returns 'solid' for null/undefined/empty optTags", () => {
    expect(deriveArrangement(null)).toBe("solid");
    expect(deriveArrangement(undefined)).toBe("solid");
    expect(deriveArrangement([])).toBe("solid");
  });

  // GH #1227: OpenPrintTag SPEC ids — 29 = coextruded, 28 = gradual_color_change
  // (rendered as "gradient"). The pre-#1227 app table (27 gradient / 28 dual /
  // 29 triple, which GH #507 aligned this helper to) contradicted the spec.
  it("returns 'coextruded' when tag 29 (coextruded) is present", () => {
    expect(deriveArrangement([29])).toBe("coextruded");
    expect(deriveArrangement([16, 29])).toBe("coextruded"); // tag 16 = MATTE
  });

  it("returns 'gradient' when tag 28 (gradual_color_change) is present", () => {
    expect(deriveArrangement([28])).toBe("gradient");
    expect(deriveArrangement([19, 28])).toBe("gradient");
  });

  // GH #1227 (Codex P2 r11): while the row's tags await numbering review, 28
  // is DUAL_COLOR under the legacy reading and gradual_color_change under the
  // spec one — both multi-color — and renders as the pre-v1.83 stripes; 27
  // (legacy GRADIENT vs temperature_color_change) is not an arrangement under
  // both readings, so it renders solid; 29 is a fixed point.
  it("reads an unreviewed array only through ids both numberings agree on", () => {
    expect(deriveArrangement([28], true)).toBe("coextruded");
    expect(deriveArrangement([29], true)).toBe("coextruded");
    expect(deriveArrangement([27], true)).toBe("solid");
    expect(deriveArrangement([27], false)).toBe("solid"); // spec 27 is no arrangement either
    expect(deriveArrangement([28], false)).toBe("gradient");
  });

  it("returns 'coextruded' when both coextruded and gradient tags are present (coextruded wins)", () => {
    // A "coextruded gradient" is theoretically possible per OpenPrintTag
    // spec; the rendering UI can only pick one mode, so the more
    // structural property (cross-section) wins over change-over-time.
    expect(deriveArrangement([28, 29])).toBe("coextruded");
    expect(deriveArrangement([29, 28])).toBe("coextruded");
  });

  it("returns 'solid' when only non-arrangement tags are present", () => {
    // 1 biocompatible, 2 antibacterial, 4 abrasive, 13 water_soluble, 27
    // temperature_color_change — none describe a colour arrangement. 27 in
    // particular was the pre-#1227 GRADIENT id and must NOT read as one now.
    expect(deriveArrangement([1, 2, 4, 13, 27])).toBe("solid");
  });

  it("type-checks to ColorArrangement", () => {
    const result: ColorArrangement = deriveArrangement([29]);
    expect(["solid", "coextruded", "gradient"]).toContain(result);
  });
});

describe("arrangementToOptTag", () => {
  it("maps gradient to tag 28 (gradual_color_change)", () => {
    expect(arrangementToOptTag("gradient")).toBe(28);
  });

  it("returns null for a solid arrangement", () => {
    expect(arrangementToOptTag("solid")).toBeNull();
  });

  // GH #1227: the spec has ONE coextruded tag; the colour count is implicit in
  // secondaryColors, so the count no longer picks a dual/triple id (the #817
  // boundary is gone with the pre-spec split).
  it("maps coextruded to tag 29 — there is no dual/triple split any more", () => {
    expect(arrangementToOptTag("coextruded")).toBe(29);
  });
});

describe("stripArrangementTags", () => {
  it("returns an empty array for null/undefined optTags", () => {
    expect(stripArrangementTags(null)).toEqual([]);
    expect(stripArrangementTags(undefined)).toEqual([]);
  });

  it("returns an empty array (new copy) for an already-empty array", () => {
    expect(stripArrangementTags([])).toEqual([]);
  });

  it("removes both arrangement tags (28 gradual_color_change, 29 coextruded)", () => {
    expect(stripArrangementTags([28, 29])).toEqual([]);
  });

  it("keeps non-arrangement tags and drops arrangement ones", () => {
    // 16 = matte, 4 = abrasive, 27 = temperature_color_change (NOT an
    // arrangement any more) survive; 28/29 are stripped.
    expect(stripArrangementTags([16, 28, 4, 29, 27])).toEqual([16, 4, 27]);
  });

  it("leaves an array with no arrangement tags untouched (by value)", () => {
    expect(stripArrangementTags([1, 2, 16])).toEqual([1, 2, 16]);
  });

  it("does not mutate the input array", () => {
    const input = [16, 29, 4];
    const copy = [...input];
    stripArrangementTags(input);
    expect(input).toEqual(copy);
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

// ── GH #605: color clearable end-to-end — form seed / input / submit ──────

describe("seedFormColorHex (GH #605)", () => {
  it("seeds a stored null as '' — editing must NOT resurrect the gray sentinel", () => {
    expect(seedFormColorHex(null)).toBe("");
  });

  it("keeps the gray default for an absent value (fresh form / no prefill)", () => {
    expect(seedFormColorHex(undefined)).toBe(BLANK_COLOR_HEX);
  });

  it("passes a stored real color through verbatim", () => {
    expect(seedFormColorHex("#FA6E1C")).toBe("#FA6E1C");
    // The sentinel itself is a storable, user-pickable gray — not special.
    expect(seedFormColorHex(BLANK_COLOR_HEX)).toBe(BLANK_COLOR_HEX);
  });
});

describe("normalizeColorHexInput (GH #605)", () => {
  it("returns '' for an emptied box (pre-fix this normalized to a dangling '#')", () => {
    expect(normalizeColorHexInput("")).toBe("");
    expect(normalizeColorHexInput("   ")).toBe("");
  });

  it("returns '' when only the '#' remains or no hex chars survive filtering", () => {
    expect(normalizeColorHexInput("#")).toBe("");
    expect(normalizeColorHexInput("xyz")).toBe("");
    expect(normalizeColorHexInput("#zz")).toBe("");
  });

  it("prepends # when missing and keeps only hex chars", () => {
    expect(normalizeColorHexInput("FA6E1C")).toBe("#FA6E1C");
    expect(normalizeColorHexInput("#FA6E1C")).toBe("#FA6E1C");
    expect(normalizeColorHexInput("fa6e1c")).toBe("#fa6e1c");
    expect(normalizeColorHexInput("#FA-6E-1C")).toBe("#FA6E1C");
  });

  it("keeps partial hexes while typing and caps at 6 hex chars", () => {
    expect(normalizeColorHexInput("#F")).toBe("#F");
    expect(normalizeColorHexInput("#FA6E")).toBe("#FA6E");
    expect(normalizeColorHexInput("#FA6E1C99")).toBe("#FA6E1C");
  });
});

describe("submittedColorValue (GH #605)", () => {
  it("maps a cleared color ('') to null on submit", () => {
    expect(submittedColorValue("", [])).toBeNull();
  });

  it("maps an incomplete hex ('#', '#12') to null on submit", () => {
    expect(submittedColorValue("#", [])).toBeNull();
    expect(submittedColorValue("#12", [])).toBeNull();
  });

  it("submits a full #RRGGBB verbatim — including the gray sentinel", () => {
    expect(submittedColorValue("#FA6E1C", [])).toBe("#FA6E1C");
    expect(submittedColorValue(BLANK_COLOR_HEX, null)).toBe(BLANK_COLOR_HEX);
  });

  it("coextruded arrangement (spec tag 29) always submits null (GH #477/#533)", () => {
    expect(submittedColorValue("#FA6E1C", [29])).toBeNull();
    expect(submittedColorValue("#FA6E1C", [16, 29])).toBeNull();
    // Gradient (28 gradual_color_change) keeps its primary; so does 27, which
    // is temperature_color_change on the wire, not an arrangement (GH #1227).
    expect(submittedColorValue("#FA6E1C", [28])).toBe("#FA6E1C");
    expect(submittedColorValue("#FA6E1C", [27])).toBe("#FA6E1C");
  });
});

import { describe, it, expect } from "vitest";
import {
  composeLabelLines,
  normalizeLabelFormat,
  DEFAULT_LABEL_FORMAT,
  LABEL_PRESETS,
  SAMPLE_FILAMENT,
  type LabelFormat,
} from "../src/lib/labelFormat";

const FIL = { name: "Galaxy Black", vendor: "Prusament", type: "PLA", colorName: "Black" };
const fmt = (lines: LabelFormat["lines"]): LabelFormat => ({ ...DEFAULT_LABEL_FORMAT, lines });

describe("composeLabelLines", () => {
  it("returns the name for the default format", () => {
    expect(composeLabelLines(FIL, DEFAULT_LABEL_FORMAT)).toEqual(["Galaxy Black"]);
  });

  it("joins vendor + type on one line for the vendorType field", () => {
    expect(composeLabelLines(FIL, fmt(["vendorType"]))).toEqual(["Prusament PLA"]);
  });

  it("stacks vendor over type as two lines", () => {
    expect(composeLabelLines(FIL, fmt(["vendor", "type"]))).toEqual(["Prusament", "PLA"]);
  });

  it("preserves line order", () => {
    expect(composeLabelLines(FIL, fmt(["type", "vendor", "name"]))).toEqual(["PLA", "Prusament", "Galaxy Black"]);
  });

  it("drops empty/whitespace fields so no blank line prints", () => {
    const noVendor = { name: "X", vendor: "  ", type: "PLA", colorName: null };
    expect(composeLabelLines(noVendor, fmt(["vendor", "type"]))).toEqual(["PLA"]);
    // vendorType with only type present → just the type, no leading space
    expect(composeLabelLines(noVendor, fmt(["vendorType"]))).toEqual(["PLA"]);
  });

  it("handles a fully-empty filament without throwing", () => {
    expect(composeLabelLines({}, fmt(["name", "vendor", "type"]))).toEqual([]);
  });

  it("every preset resolves to at least one line for the sample filament", () => {
    for (const [key, { patch }] of Object.entries(LABEL_PRESETS)) {
      const f = normalizeLabelFormat({ ...DEFAULT_LABEL_FORMAT, ...patch });
      expect(composeLabelLines(SAMPLE_FILAMENT, f).length, key).toBeGreaterThan(0);
    }
  });
});

describe("normalizeLabelFormat", () => {
  it("returns the default for null/garbage input", () => {
    expect(normalizeLabelFormat(null)).toEqual(DEFAULT_LABEL_FORMAT);
    expect(normalizeLabelFormat("nope")).toEqual(DEFAULT_LABEL_FORMAT);
    expect(normalizeLabelFormat(42)).toEqual(DEFAULT_LABEL_FORMAT);
  });

  it("fills missing fields from the default and keeps valid ones", () => {
    const out = normalizeLabelFormat({ invert: true, font: { family: "mono" } });
    expect(out.invert).toBe(true);
    expect(out.font.family).toBe("mono");
    expect(out.font.size).toBe(DEFAULT_LABEL_FORMAT.font.size); // missing → default
    expect(out.qr).toEqual(DEFAULT_LABEL_FORMAT.qr);
  });

  it("rejects unknown enum values, falling back to defaults", () => {
    const out = normalizeLabelFormat({
      qr: { enabled: "yes", placement: "middle" },
      font: { family: "comic-sans", size: "xxl" },
      orientation: "diagonal",
      invert: "true",
    });
    expect(out.qr.enabled).toBe(DEFAULT_LABEL_FORMAT.qr.enabled);
    expect(out.qr.placement).toBe("left");
    expect(out.font.family).toBe("sans");
    expect(out.font.size).toBe("m");
    expect(out.orientation).toBe("horizontal");
    expect(out.invert).toBe(false);
  });

  it("filters invalid line ids and never yields an empty line list", () => {
    expect(normalizeLabelFormat({ lines: ["vendor", "bogus", "type"] }).lines).toEqual(["vendor", "type"]);
    expect(normalizeLabelFormat({ lines: ["bogus"] }).lines).toEqual(DEFAULT_LABEL_FORMAT.lines);
    expect(normalizeLabelFormat({ lines: [] }).lines).toEqual(DEFAULT_LABEL_FORMAT.lines);
  });

  it("round-trips a valid format through JSON", () => {
    const f: LabelFormat = {
      qr: { enabled: false, placement: "right" },
      lines: ["vendor", "type"],
      font: { family: "condensed", size: "l" },
      orientation: "vertical",
      invert: true,
    };
    expect(normalizeLabelFormat(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });
});

import { describe, it, expect } from "vitest";
import {
  composeLabelLines,
  composeWrappedLabelLines,
  wrapLabelLine,
  normalizeLabelFormat,
  DEFAULT_LABEL_FORMAT,
  LABEL_PRESETS,
  MAX_LINES_PER_FIELD,
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
      maxLinesPerField: 2,
    };
    expect(normalizeLabelFormat(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it("#745: defaults maxLinesPerField to 1 and clamps to [1, MAX]", () => {
    expect(normalizeLabelFormat({}).maxLinesPerField).toBe(1);
    expect(normalizeLabelFormat({ maxLinesPerField: 3 }).maxLinesPerField).toBe(3);
    // Out of range / wrong type → clamp or fall back.
    expect(normalizeLabelFormat({ maxLinesPerField: 0 }).maxLinesPerField).toBe(1);
    expect(normalizeLabelFormat({ maxLinesPerField: 99 }).maxLinesPerField).toBe(MAX_LINES_PER_FIELD);
    expect(normalizeLabelFormat({ maxLinesPerField: 2.6 }).maxLinesPerField).toBe(3); // rounded
    expect(normalizeLabelFormat({ maxLinesPerField: "x" }).maxLinesPerField).toBe(1);
  });
});

describe("wrapLabelLine (#745)", () => {
  it("returns the text unchanged when maxLines <= 1 or one/zero words", () => {
    expect(wrapLabelLine("Polymaker Panchroma PLA", 1)).toEqual(["Polymaker Panchroma PLA"]);
    expect(wrapLabelLine("Polymaker", 3)).toEqual(["Polymaker"]);
    expect(wrapLabelLine("  ", 3)).toEqual([""]);
    // A single unbreakable token can't wrap, even past maxLines.
    expect(wrapLabelLine("Supercalifragilistic", 3)).toEqual(["Supercalifragilistic"]);
  });

  it("balances words across lines, remainder on the FIRST lines (reporter's examples)", () => {
    // 6 words / 3 lines → 2 each.
    expect(wrapLabelLine("Polymaker Panchroma™ Gradient Matte PLA Wood", 3)).toEqual([
      "Polymaker Panchroma™",
      "Gradient Matte",
      "PLA Wood",
    ]);
    // 7 words / 3 lines → 3,2,2 (extra on the first line).
    expect(wrapLabelLine("Polymaker Panchroma™ Dual Matte PLA Sunrise (Red-Yellow)", 3)).toEqual([
      "Polymaker Panchroma™ Dual",
      "Matte PLA",
      "Sunrise (Red-Yellow)",
    ]);
    // 6 words / 3 lines → 2 each.
    expect(wrapLabelLine("Prusament PLA Blend Viva La Bronze", 3)).toEqual([
      "Prusament PLA",
      "Blend Viva",
      "La Bronze",
    ]);
  });

  it("never produces more lines than there are words", () => {
    expect(wrapLabelLine("Alpha Beta", 3)).toEqual(["Alpha", "Beta"]); // 2 words, maxLines 3 → 2 lines
    expect(wrapLabelLine("a b c d e", 2)).toEqual(["a b c", "d e"]); // 5 words / 2 → 3,2
  });
});

describe("composeWrappedLabelLines (#745)", () => {
  const fmt = (over: Partial<LabelFormat>): LabelFormat => ({
    ...DEFAULT_LABEL_FORMAT,
    ...over,
  });

  it("equals composeLabelLines when maxLinesPerField === 1 (default)", () => {
    const f = fmt({ lines: ["name"], maxLinesPerField: 1 });
    const fil = { name: "Polymaker Panchroma Gradient Matte PLA Wood" };
    expect(composeWrappedLabelLines(fil, f)).toEqual(composeLabelLines(fil, f));
    expect(composeWrappedLabelLines(fil, f)).toEqual(["Polymaker Panchroma Gradient Matte PLA Wood"]);
  });

  it("wraps each field and flattens top→bottom in field order", () => {
    const f = fmt({ lines: ["vendor", "name"], maxLinesPerField: 2 });
    const fil = { vendor: "Prusa Polymers", name: "Galaxy Black Edition" };
    expect(composeWrappedLabelLines(fil, f)).toEqual([
      "Prusa", // vendor: 2 words / 2 lines
      "Polymers",
      "Galaxy Black", // name: 3 words / 2 lines → 2,1
      "Edition",
    ]);
  });

  it("still drops empty fields before wrapping", () => {
    const f = fmt({ lines: ["vendor", "name"], maxLinesPerField: 3 });
    expect(composeWrappedLabelLines({ name: "Solo Name Here" }, f)).toEqual(["Solo", "Name", "Here"]);
  });
});

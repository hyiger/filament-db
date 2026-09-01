import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  composeLabelLines,
  composeWrappedLabelLines,
  wrapLabelLine,
  normalizeLabelFormat,
  validateLabelFormatOverride,
  DEFAULT_LABEL_FORMAT,
  LABEL_PRESETS,
  MAX_LINES_PER_FIELD,
  SAMPLE_FILAMENT,
  type LabelFormat,
} from "../src/lib/labelFormat";
import en from "../src/i18n/locales/en.json";
import de from "../src/i18n/locales/de.json";

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

  it("every preset carries a labelKey present in en + de (GH #1007 F3)", () => {
    // The editor renders t(labelKey), so a hardcoded English label would show
    // untranslated in German Settings. The i18n parity test only scans literal
    // string-argument translation calls and can't catch a dynamic t(labelKey),
    // so pin it here.
    const enDict = en as Record<string, string>;
    const deDict = de as Record<string, string>;
    for (const [key, { labelKey }] of Object.entries(LABEL_PRESETS)) {
      expect(labelKey, key).toMatch(/^settings\.labelFormat\.preset\./);
      expect(enDict[labelKey], `${key} missing in en.json`).toBeTruthy();
      expect(deDict[labelKey], `${key} missing in de.json`).toBeTruthy();
    }
  });

  it("coerces null/undefined vendor+type to empty before joining (vendorType)", () => {
    // Both null → the `s ?? ""` fallback fires for each, filter drops the empties → no line.
    expect(composeLabelLines({ vendor: null, type: null }, fmt(["vendorType"]))).toEqual([]);
    // Only type null → vendor survives, no trailing space from the null.
    expect(composeLabelLines({ vendor: "Prusament", type: null }, fmt(["vendorType"]))).toEqual(["Prusament"]);
    // Only vendor null → type survives, no leading space.
    expect(composeLabelLines({ vendor: null, type: "PLA" }, fmt(["vendorType"]))).toEqual(["PLA"]);
  });

  it("coerces a null colorName to empty and drops it (colorName field)", () => {
    expect(composeLabelLines({ colorName: null }, fmt(["colorName"]))).toEqual([]);
    // undefined (missing key) likewise coerces to empty and is dropped.
    expect(composeLabelLines({}, fmt(["colorName"]))).toEqual([]);
    // A real value still passes through, trimmed.
    expect(composeLabelLines({ colorName: "  Galaxy Black  " }, fmt(["colorName"]))).toEqual(["Galaxy Black"]);
  });

  it("skips an unknown line id via the optional-chaining fallback (no throw)", () => {
    // A hand-crafted / legacy format carrying an id not in FIELD_VALUE:
    // FIELD_VALUE[id]?.(...) is undefined → `?? ""` → dropped by the length filter.
    const rogue = { ...DEFAULT_LABEL_FORMAT, lines: ["bogus", "name"] as unknown as LabelFormat["lines"] };
    expect(composeLabelLines(FIL, rogue)).toEqual(["Galaxy Black"]);
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

  it("dedupes repeated line ids so a field can't stack and overflow the head (#954)", () => {
    expect(
      normalizeLabelFormat({ lines: ["name", "name", "vendor", "name", "vendor"] }).lines,
    ).toEqual(["name", "vendor"]);
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

  it("defaults to no-wrap when maxLinesPerField is missing (?? 1 fallback)", () => {
    // A legacy/hand-built format object without maxLinesPerField (not run through
    // normalizeLabelFormat) → the `?? 1` fallback → each field stays on one line.
    const legacy = { ...DEFAULT_LABEL_FORMAT, lines: ["name"] } as Omit<LabelFormat, "maxLinesPerField"> & {
      maxLinesPerField?: number;
    };
    delete legacy.maxLinesPerField;
    const fil = { name: "Polymaker Panchroma Gradient Matte PLA Wood" };
    expect(composeWrappedLabelLines(fil, legacy as LabelFormat)).toEqual([
      "Polymaker Panchroma Gradient Matte PLA Wood",
    ]);
  });
});

describe("validateLabelFormatOverride (GH #1195)", () => {
  // normalizeLabelFormat is a PERSISTENCE normalizer — it coerces anything
  // unrecognised to a default so an old stored format still loads. Using it to
  // validate a REQUEST silently turned malformed input into a printed label
  // the caller never asked for. These pin the strict request-shape check.
  it("accepts an omitted override", () => {
    expect(validateLabelFormatOverride(undefined)).toBeNull();
  });

  it("accepts a valid partial override", () => {
    expect(
      validateLabelFormatOverride({ qr: { enabled: false }, font: { size: "l" } }),
    ).toBeNull();
  });

  it("rejects a non-object", () => {
    for (const v of ["nope", 42, [], null]) {
      expect(validateLabelFormatOverride(v)).toMatch(/must be an object/);
    }
  });

  it("rejects a boolean sent as a string, which the normalizer would default to true", () => {
    expect(validateLabelFormatOverride({ qr: { enabled: "false" } })).toMatch(
      /qr\.enabled must be a boolean/,
    );
  });

  it("rejects a nested qr/font that is not an object", () => {
    for (const v of ["nope", 42, [], null]) {
      expect(validateLabelFormatOverride({ qr: v })).toMatch(/qr must be an object/);
      expect(validateLabelFormatOverride({ font: v })).toMatch(/font must be an object/);
    }
  });

  it("rejects unknown keys at both levels rather than ignoring them", () => {
    expect(validateLabelFormatOverride({ nope: 1 })).toMatch(/unknown field/);
    expect(validateLabelFormatOverride({ qr: { nope: 1 } })).toMatch(/qr has unknown field/);
    expect(validateLabelFormatOverride({ font: { nope: 1 } })).toMatch(/font has unknown field/);
  });

  it("rejects invalid enum values", () => {
    expect(validateLabelFormatOverride({ qr: { placement: "middle" } })).toMatch(/placement/);
    expect(validateLabelFormatOverride({ font: { family: "comic" } })).toMatch(/family/);
    expect(validateLabelFormatOverride({ font: { size: "xxl" } })).toMatch(/size/);
    expect(validateLabelFormatOverride({ orientation: "sideways" })).toMatch(/orientation/);
  });

  it("rejects an explicitly empty lines list, which the normalizer would refill", () => {
    // normalizeLabelFormat turns [] into ["name"], so accepting it would print
    // the filament name on a label the caller asked to be QR-only.
    expect(validateLabelFormatOverride({ lines: [] })).toMatch(/must not be empty/);
  });

  it("rejects bad lines arrays", () => {
    expect(validateLabelFormatOverride({ lines: "name" })).toMatch(/must be an array/);
    expect(validateLabelFormatOverride({ lines: ["nope"] })).toMatch(/lines entries/);
    expect(validateLabelFormatOverride({ lines: [1] })).toMatch(/lines entries/);
  });

  it("bounds maxLinesPerField to a sane integer range", () => {
    for (const n of [0, -1, 99, 1.5, "2"]) {
      expect(validateLabelFormatOverride({ maxLinesPerField: n })).toMatch(/maxLinesPerField/);
    }
    expect(validateLabelFormatOverride({ maxLinesPerField: MAX_LINES_PER_FIELD })).toBeNull();
  });

  it("rejects a non-boolean invert", () => {
    expect(validateLabelFormatOverride({ invert: "yes" })).toMatch(/invert must be a boolean/);
  });
});

describe("OpenAPI format schema matches the handler (GH #1195)", () => {
  // The round-6 review found the published contract had drifted from the
  // route: `format` was declared additionalProperties:true with no properties
  // while the handler validated every member strictly, so a schema-valid
  // request got an undocumented 400 and clients could not discover the fields.
  // This pins the two together rather than relying on remembering.
  const spec = JSON.parse(readFileSync("public/openapi.json", "utf8")) as Record<string, never>;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const fmt = (spec as any).paths["/api/labels/print"].post.requestBody.content[
    "application/json"
  ].schema.properties.format;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it("documents the nested shape and forbids unknown keys", () => {
    expect(fmt.additionalProperties).toBe(false);
    expect(Object.keys(fmt.properties).sort()).toEqual([
      "font", "invert", "lines", "maxLinesPerField", "orientation", "qr",
    ]);
    expect(fmt.properties.qr.additionalProperties).toBe(false);
    expect(fmt.properties.font.additionalProperties).toBe(false);
  });

  it("accepts every value the spec declares legal", () => {
    const legal: unknown[] = [
      ...fmt.properties.qr.properties.placement.enum.map((p: string) => ({ qr: { placement: p } })),
      ...fmt.properties.lines.items.enum.map((l: string) => ({ lines: [l] })),
      ...fmt.properties.font.properties.family.enum.map((f: string) => ({ font: { family: f } })),
      ...fmt.properties.font.properties.size.enum.map((s: string) => ({ font: { size: s } })),
      ...fmt.properties.orientation.enum.map((o: string) => ({ orientation: o })),
      { invert: true },
      { qr: { enabled: false } },
    ];
    for (let n = fmt.properties.maxLinesPerField.minimum; n <= fmt.properties.maxLinesPerField.maximum; n++) {
      legal.push({ maxLinesPerField: n });
    }
    for (const value of legal) {
      expect(validateLabelFormatOverride(value)).toBeNull();
    }
  });

  it("keeps the documented bounds in step with the validator", () => {
    // Off-by-one on either side would let the spec promise something the
    // handler refuses, which is the drift this suite exists to catch.
    const { minimum, maximum } = fmt.properties.maxLinesPerField;
    expect(validateLabelFormatOverride({ maxLinesPerField: minimum - 1 })).not.toBeNull();
    expect(validateLabelFormatOverride({ maxLinesPerField: maximum + 1 })).not.toBeNull();
    expect(fmt.properties.lines.minItems).toBe(1);
    expect(validateLabelFormatOverride({ lines: [] })).not.toBeNull();
  });
});

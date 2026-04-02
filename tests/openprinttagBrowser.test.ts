import { describe, it, expect } from "vitest";
import {
  computeCompletenessScore,
  completenessTier,
  rgbaToHex,
  parseBrandYaml,
  parseMaterialYaml,
  mapToFilamentPayload,
} from "@/lib/openprinttagBrowser";

describe("computeCompletenessScore", () => {
  it("returns 0 for empty material", () => {
    expect(computeCompletenessScore({})).toBe(0);
  });

  it("returns 0 for material with empty properties", () => {
    expect(computeCompletenessScore({ properties: {} })).toBe(0);
  });

  it("scores 1 for color only", () => {
    const raw = { primary_color: { color_rgba: "#000000ff" } };
    expect(computeCompletenessScore(raw)).toBe(1);
  });

  it("scores 1 for density only", () => {
    const raw = { properties: { density: 1.24 } };
    expect(computeCompletenessScore(raw)).toBe(1);
  });

  it("scores 1 for print temperature (min or max)", () => {
    expect(
      computeCompletenessScore({ properties: { min_print_temperature: 200 } }),
    ).toBe(1);
    expect(
      computeCompletenessScore({ properties: { max_print_temperature: 220 } }),
    ).toBe(1);
  });

  it("scores 1 for bed temperature (min or max)", () => {
    expect(
      computeCompletenessScore({ properties: { min_bed_temperature: 50 } }),
    ).toBe(1);
  });

  it("scores 1 for drying temperature", () => {
    expect(
      computeCompletenessScore({ properties: { drying_temperature: 55 } }),
    ).toBe(1);
  });

  it("scores 1 for hardness (shore D or A)", () => {
    expect(
      computeCompletenessScore({ properties: { hardness_shore_d: 80 } }),
    ).toBe(1);
    expect(
      computeCompletenessScore({ properties: { hardness_shore_a: 95 } }),
    ).toBe(1);
  });

  it("scores 1 for transmission_distance", () => {
    expect(
      computeCompletenessScore({ transmission_distance: 6.4 }),
    ).toBe(1);
  });

  it("scores 1 for chamber temperature", () => {
    expect(
      computeCompletenessScore({ properties: { chamber_temperature: 90 } }),
    ).toBe(1);
  });

  it("scores 1 for photos", () => {
    expect(
      computeCompletenessScore({ photos: [{ url: "https://example.com/photo.jpg" }] }),
    ).toBe(1);
  });

  it("scores 0 for empty photos array", () => {
    expect(computeCompletenessScore({ photos: [] })).toBe(0);
  });

  it("scores 1 for url", () => {
    expect(
      computeCompletenessScore({ url: "https://example.com" }),
    ).toBe(1);
  });

  it("scores 10 for fully complete material", () => {
    const raw = {
      primary_color: { color_rgba: "#ea5e1aff" },
      transmission_distance: 6.4,
      url: "https://example.com",
      photos: [{ url: "https://example.com/photo.jpg" }],
      properties: {
        density: 1.22,
        min_print_temperature: 265,
        max_print_temperature: 285,
        min_bed_temperature: 100,
        max_bed_temperature: 120,
        drying_temperature: 65,
        hardness_shore_d: 79,
        chamber_temperature: 90,
      },
    };
    expect(computeCompletenessScore(raw)).toBe(10);
  });

  it("scores correctly for a partial material (Prusament PETG)", () => {
    const raw = {
      primary_color: { color_rgba: "#eb5405ff" },
      transmission_distance: 6.2,
      photos: [{ url: "https://files.openprinttag.org/photo.png" }],
      properties: {
        density: 1.27,
        hardness_shore_d: 74,
        min_print_temperature: 240,
        max_print_temperature: 260,
        preheat_temperature: 170,
        min_bed_temperature: 70,
        max_bed_temperature: 90,
      },
    };
    // color(1) + density(1) + print temps(1) + bed temps(1) + hardness(1) + TD(1) + photos(1) = 7
    expect(computeCompletenessScore(raw)).toBe(7);
  });
});

describe("completenessTier", () => {
  it("returns 'rich' for 7-10", () => {
    expect(completenessTier(7)).toBe("rich");
    expect(completenessTier(10)).toBe("rich");
  });

  it("returns 'partial' for 4-6", () => {
    expect(completenessTier(4)).toBe("partial");
    expect(completenessTier(6)).toBe("partial");
  });

  it("returns 'stub' for 0-3", () => {
    expect(completenessTier(0)).toBe("stub");
    expect(completenessTier(3)).toBe("stub");
  });
});

describe("rgbaToHex", () => {
  it("converts 8-char RGBA to 6-char hex", () => {
    expect(rgbaToHex("#ea5e1aff")).toBe("#ea5e1a");
  });

  it("passes through 6-char hex", () => {
    expect(rgbaToHex("#000000")).toBe("#000000");
  });

  it("handles missing hash prefix in 8-char", () => {
    expect(rgbaToHex("ea5e1aff")).toBe("#ea5e1a");
  });

  it("returns null for null/undefined input", () => {
    expect(rgbaToHex(null)).toBeNull();
    expect(rgbaToHex(undefined)).toBeNull();
    expect(rgbaToHex("")).toBeNull();
  });

  it("returns null for invalid length", () => {
    expect(rgbaToHex("#abc")).toBeNull();
  });
});

describe("parseBrandYaml", () => {
  it("parses a valid brand YAML", () => {
    const yaml = `uuid: 3eb597ab-9f9b-5ecf-87e6-8ac1e31f51a8
slug: 3d-fuel
name: 3D Fuel
countries_of_origin:
- US`;
    const brand = parseBrandYaml(yaml);
    expect(brand).toEqual({
      slug: "3d-fuel",
      name: "3D Fuel",
      country: "US",
    });
  });

  it("returns null for invalid YAML", () => {
    expect(parseBrandYaml("not: valid: yaml: [")).toBeNull();
  });

  it("returns null for YAML missing required fields", () => {
    expect(parseBrandYaml("foo: bar")).toBeNull();
  });
});

describe("parseMaterialYaml", () => {
  const brandMap = new Map([
    ["prusament", { name: "Prusament", country: "CZ" }],
    ["polymaker", { name: "Polymaker" }],
  ]);

  it("parses a complete FFF material", () => {
    const yaml = `uuid: 53d353de-05c1-5de7-b078-162c730a0367
slug: prusament-pc-blend-prusa-orange
brand:
  slug: prusament
name: PC Blend Prusa Orange
class: FFF
type: PC
abbreviation: PC
primary_color:
  color_rgba: '#ea5e1aff'
transmission_distance: 6.4
tags:
- blend
photos:
- url: https://files.openprinttag.org/photo.png
  type: unspecified
properties:
  density: 1.22
  hardness_shore_d: 79
  min_print_temperature: 265
  max_print_temperature: 285
  preheat_temperature: 170
  min_bed_temperature: 100
  max_bed_temperature: 120
  chamber_temperature: 90`;

    const m = parseMaterialYaml(yaml, brandMap);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe("prusament-pc-blend-prusa-orange");
    expect(m!.brandName).toBe("Prusament");
    expect(m!.name).toBe("PC Blend Prusa Orange");
    expect(m!.type).toBe("PC");
    expect(m!.color).toBe("#ea5e1a");
    expect(m!.density).toBe(1.22);
    expect(m!.nozzleTempMin).toBe(265);
    expect(m!.nozzleTempMax).toBe(285);
    expect(m!.bedTempMin).toBe(100);
    expect(m!.bedTempMax).toBe(120);
    expect(m!.chamberTemp).toBe(90);
    expect(m!.preheatTemp).toBe(170);
    expect(m!.hardnessShoreD).toBe(79);
    expect(m!.transmissionDistance).toBe(6.4);
    expect(m!.tags).toEqual(["blend"]);
    expect(m!.completenessScore).toBeGreaterThanOrEqual(8);
    expect(m!.completenessTier).toBe("rich");
  });

  it("filters out SLA materials", () => {
    const yaml = `uuid: abc
slug: some-resin
brand:
  slug: epax
name: Some Resin
class: SLA
type: Resin`;
    expect(parseMaterialYaml(yaml, brandMap)).toBeNull();
  });

  it("handles empty properties", () => {
    const yaml = `uuid: def
slug: overture-pla-black
brand:
  slug: overture
name: PLA Black
class: FFF
type: PLA
abbreviation: PLA
primary_color:
  color_rgba: '#000000ff'
properties: {}`;
    const m = parseMaterialYaml(yaml, new Map([["overture", { name: "Overture" }]]));
    expect(m).not.toBeNull();
    expect(m!.brandName).toBe("Overture");
    expect(m!.density).toBeNull();
    expect(m!.nozzleTempMin).toBeNull();
    expect(m!.completenessScore).toBe(1); // only color
    expect(m!.completenessTier).toBe("stub");
  });

  it("falls back to slug when brand not in map", () => {
    const yaml = `uuid: ghi
slug: unknown-pla
brand:
  slug: unknown-brand
name: PLA
class: FFF
type: PLA`;
    const m = parseMaterialYaml(yaml, brandMap);
    expect(m).not.toBeNull();
    expect(m!.brandName).toBe("unknown-brand");
  });
});

describe("mapToFilamentPayload", () => {
  it("maps OPTMaterial to Filament DB schema", () => {
    const material = {
      slug: "prusament-pla-galaxy-black",
      uuid: "1aaca54a-431f-5601-adf5-85dd018f487f",
      brandSlug: "prusament",
      brandName: "Prusament",
      name: "PLA Galaxy Black",
      type: "PLA",
      abbreviation: "PLA",
      color: "#3d3e3d",
      density: 1.24,
      nozzleTempMin: 205,
      nozzleTempMax: 225,
      bedTempMin: 40,
      bedTempMax: 60,
      chamberTemp: 20,
      preheatTemp: 170,
      dryingTemp: null,
      dryingTime: null,
      hardnessShoreD: 81,
      transmissionDistance: 0.2,
      tags: ["glitter", "industrially_compostable"],
      photoUrl: "https://files.openprinttag.org/photo.png",
      productUrl: null,
      completenessScore: 8,
      completenessTier: "rich" as const,
    };

    const payload = mapToFilamentPayload(material);

    expect(payload.name).toBe("Prusament PLA Galaxy Black");
    expect(payload.vendor).toBe("Prusament");
    expect(payload.type).toBe("PLA");
    expect(payload.color).toBe("#3d3e3d");
    expect(payload.density).toBe(1.24);
    expect(payload.diameter).toBe(1.75);

    const temps = payload.temperatures as Record<string, number | null>;
    expect(temps.nozzle).toBe(225);
    expect(temps.nozzleRangeMin).toBe(205);
    expect(temps.nozzleRangeMax).toBe(225);
    expect(temps.bed).toBe(60);
    expect(temps.standby).toBe(170);

    expect(payload.shoreHardnessD).toBe(81);
    expect(payload.transmissionDistance).toBe(0.2);
    expect(payload.dryingTemperature).toBeNull();

    const settings = payload.settings as Record<string, string>;
    expect(settings.openprinttag_uuid).toBe("1aaca54a-431f-5601-adf5-85dd018f487f");
    expect(settings.openprinttag_slug).toBe("prusament-pla-galaxy-black");
  });

  it("uses default color when null", () => {
    const material = {
      slug: "test",
      uuid: "test-uuid",
      brandSlug: "test",
      brandName: "Test",
      name: "Test Filament",
      type: "PLA",
      abbreviation: "PLA",
      color: null,
      density: null,
      nozzleTempMin: null,
      nozzleTempMax: null,
      bedTempMin: null,
      bedTempMax: null,
      chamberTemp: null,
      preheatTemp: null,
      dryingTemp: null,
      dryingTime: null,
      hardnessShoreD: null,
      transmissionDistance: null,
      tags: [],
      photoUrl: null,
      productUrl: null,
      completenessScore: 0,
      completenessTier: "stub" as const,
    };

    const payload = mapToFilamentPayload(material);
    expect(payload.color).toBe("#808080");
  });

  it("maps abrasive tag to optTags", () => {
    const material = {
      slug: "test",
      uuid: "test-uuid",
      brandSlug: "test",
      brandName: "Test",
      name: "Test CF",
      type: "PA6",
      abbreviation: "PA6",
      color: "#000000",
      density: null,
      nozzleTempMin: null,
      nozzleTempMax: null,
      bedTempMin: null,
      bedTempMax: null,
      chamberTemp: null,
      preheatTemp: null,
      dryingTemp: null,
      dryingTime: null,
      hardnessShoreD: null,
      transmissionDistance: null,
      tags: ["abrasive", "contains_carbon_fiber"],
      photoUrl: null,
      productUrl: null,
      completenessScore: 1,
      completenessTier: "stub" as const,
    };

    const payload = mapToFilamentPayload(material);
    const optTags = payload.optTags as number[];
    // ABRASIVE = 4, CONTAINS_CARBON_FIBER = 31
    expect(optTags).toContain(4);
    expect(optTags).toContain(31);
  });
});

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  createReadStream,
  readdirSync,
  utimesSync,
  existsSync,
} from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import * as tar from "tar";

import {
  computeCompletenessScore,
  completenessTier,
  rgbaToHex,
  toOptNumber,
  parseBrandYaml,
  parseMaterialYaml,
  mapToFilamentPayload,
  fetchOpenPrintTagDatabase,
  fetchUpstreamCommitSha,
  getProxyDispatcher,
  clearCache,
  downloadTarballToBuffer,
  isTimeoutAbort,
  relabelTimeoutError,
  extractAndParse,
  shasMatch,
} from "@/lib/openprinttagBrowser";
import { EnvHttpProxyAgent } from "undici";

/**
 * Build a gzipped tarball on disk from the given file map and return the
 * file path. The map's keys are paths relative to the tar root; values are
 * file contents. Used by the fetchOpenPrintTagDatabase tests to simulate
 * GitHub's tarball API response without actually hitting the network.
 */
function buildTarball(files: Record<string, string>): string {
  const stagingDir = mkdtempSync(join(tmpdir(), "opt-tar-staging-"));
  for (const [relPath, content] of Object.entries(files)) {
    // Map keys use forward slashes (tarball semantics); split on `/` so the
    // directory math works the same on Windows where path.join would
    // normalize to backslashes and our previous lastIndexOf("/") returned
    // -1 → mkdirSync(""), CI failure mode (#137 follow-up).
    const segments = relPath.split("/");
    const fullPath = join(stagingDir, ...segments);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  const tarballPath = join(tmpdir(), `opt-tarball-${Date.now()}-${Math.random()}.tgz`);
  tar.c(
    {
      gzip: true,
      file: tarballPath,
      cwd: stagingDir,
      sync: true,
    },
    ["."],
  );
  rmSync(stagingDir, { recursive: true, force: true });
  return tarballPath;
}

/**
 * Mock global fetch to stream a gzipped tarball constructed from `files`.
 * Returns the path to the tarball so the test can clean it up.
 */
function mockFetchTarball(files: Record<string, string>): string {
  const tarballPath = buildTarball(files);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    // Bridge the on-disk tarball to a Web ReadableStream the route handler
    // can pipe through. Node's createReadStream gives us a Node Readable;
    // wrap it in the minimal Response shape the production code consumes.
    const nodeStream = createReadStream(tarballPath);
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        nodeStream.on("data", (chunk: Buffer | string) => {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
        });
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (err) => controller.error(err));
      },
      cancel() {
        nodeStream.destroy();
      },
    });
    return new Response(webStream, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/x-gzip" },
    });
  });
  return tarballPath;
}

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

  // GH #632: length alone used to be the only check — "zzzzzzzz"
  // slipped through as "#zzzzzz" and persisted an invalid color via
  // the OPT import's validator-skipping update path.
  it("returns null for non-hex characters at a valid length", () => {
    expect(rgbaToHex("zzzzzzzz")).toBeNull();
    expect(rgbaToHex("#zzzzzz")).toBeNull();
    expect(rgbaToHex("#ea5e1agg")).toBeNull();
    expect(rgbaToHex("#ea5e1g")).toBeNull();
  });

  it("returns null for 7-char hex (neither RGB nor RGBA)", () => {
    expect(rgbaToHex("#ea5e1af")).toBeNull();
    expect(rgbaToHex("ea5e1af")).toBeNull();
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

  // GH #954: a QUOTED numeric scalar in the upstream YAML parses to a JS string;
  // the old `as number` cast was a no-op that let it through, causing a
  // permanent OPT re-sync conflict (number-in-DB vs string-in-snapshot). The
  // parse boundary must coerce to a real number.
  it("coerces quoted-numeric YAML scalars to real numbers", () => {
    const yaml = `uuid: q1
slug: quoted-numerics
brand:
  slug: prusament
name: Quoted Numerics
class: FFF
type: PLA
transmission_distance: "6.4"
properties:
  density: "1.24"
  min_print_temperature: "210"
  max_print_temperature: 230
  drying_temperature: "55"`;
    const m = parseMaterialYaml(yaml, brandMap);
    expect(m).not.toBeNull();
    // Numbers, not the strings "1.24"/"210"/"6.4".
    expect(m!.density).toBe(1.24);
    expect(typeof m!.density).toBe("number");
    expect(m!.nozzleTempMin).toBe(210);
    expect(m!.nozzleTempMax).toBe(230); // unquoted still works
    expect(m!.dryingTemp).toBe(55);
    expect(m!.transmissionDistance).toBe(6.4);
  });

  it("toOptNumber: coerces strings, guards blanks/garbage to null (never 0)", () => {
    expect(toOptNumber("1.24")).toBe(1.24);
    expect(toOptNumber(65)).toBe(65);
    expect(toOptNumber(null)).toBeNull();
    expect(toOptNumber(undefined)).toBeNull();
    expect(toOptNumber("")).toBeNull(); // NOT 0 (Number("") === 0)
    expect(toOptNumber("   ")).toBeNull();
    expect(toOptNumber("abc")).toBeNull();
    expect(toOptNumber(Infinity)).toBeNull();
    expect(toOptNumber(NaN)).toBeNull();
    expect(toOptNumber(0)).toBe(0); // a real zero survives
    // GH #959 (Codex P2): a malformed boolean/sequence must NOT fabricate a
    // number — Number(false)/Number([]) are 0, Number(true) is 1, Number([65])
    // is 65. Treat them as absent (null) so the resync guard skips bad data.
    expect(toOptNumber(true)).toBeNull();
    expect(toOptNumber(false)).toBeNull();
    expect(toOptNumber([])).toBeNull();
    expect(toOptNumber([65])).toBeNull();
    expect(toOptNumber({})).toBeNull();
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

  // GH #604: real OPT YAMLs put secondary colors in a list under the
  // `secondary_colors:` (plural) key and tag the gradient arrangement
  // as `gradual_color_change`, not the spec-doc `gradient`. Pre-fix the
  // parser only read the keyed `secondary_color_0..4` slots and only
  // knew about the `gradient` tag string, so every multicolor OPT
  // import landed as a single grey filament with no arrangement.
  it("parses the secondary_colors list shape and gradual_color_change tag (GH #604)", () => {
    // Verbatim shape from
    // openprinttag-database/main-pr/data/materials/amolen/amolen-pla-silk-shiny-gradient-black-shiny-red-gold.yaml
    // — primary_color absent, three secondaries under a YAML list, gradient
    // declared via `gradual_color_change`.
    const yaml = `uuid: ccf32809-fbef-527a-8487-ccb75ceafab6
slug: amolen-pla-silk-shiny-gradient-black-shiny-red-gold
brand:
  slug: amolen
name: PLA Silk Shiny Gradient Black & Shiny Red Gold
class: FFF
type: PLA
abbreviation: PLA
secondary_colors:
- color_rgba: '#000000ff'
- color_rgba: '#98282fff'
- color_rgba: '#ddb95dff'
tags:
- silk
- gradual_color_change
- industrially_compostable
properties:
  density: 1.28`;

    const m = parseMaterialYaml(yaml, new Map([["amolen", { name: "Amolen" }]]));
    expect(m).not.toBeNull();
    // No primary color → null. allColors() will fall through to secondaries.
    expect(m!.color).toBeNull();
    // Three secondaries in the right order, alpha byte stripped.
    expect(m!.secondaryColors).toEqual(["#000000", "#98282f", "#ddb95d"]);
    // Raw tags pass through unchanged; mapToFilamentPayload does the
    // alias resolution to optTag numbers.
    expect(m!.tags).toEqual(["silk", "gradual_color_change", "industrially_compostable"]);
  });

  it("caps secondary_colors at 5 entries (spec keys 20-24)", () => {
    const yaml = `uuid: abc
slug: too-many-colors
brand:
  slug: amolen
name: Rainbow Plus
class: FFF
type: PLA
secondary_colors:
- color_rgba: '#ff0000ff'
- color_rgba: '#00ff00ff'
- color_rgba: '#0000ffff'
- color_rgba: '#ffff00ff'
- color_rgba: '#ff00ffff'
- color_rgba: '#00ffffff'
- color_rgba: '#ffffffff'`;
    const m = parseMaterialYaml(yaml, new Map([["amolen", { name: "Amolen" }]]));
    expect(m).not.toBeNull();
    expect(m!.secondaryColors).toHaveLength(5);
    expect(m!.secondaryColors).toEqual([
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ffff00",
      "#ff00ff",
    ]);
  });

  // Object-input path (extractAndParse hands parseMaterialYaml an
  // already-parsed object, not a string) — branch 266.
  it("returns null for a pre-parsed object missing slug", () => {
    expect(parseMaterialYaml({ name: "No Slug", class: "FFF" }, brandMap)).toBeNull();
  });

  it("returns null for a pre-parsed object missing name", () => {
    expect(parseMaterialYaml({ slug: "no-name", class: "FFF" }, brandMap)).toBeNull();
  });

  // branch 271: object input whose class is not FFF (missing class also
  // fails this check).
  it("returns null for a pre-parsed non-FFF object (missing class)", () => {
    expect(
      parseMaterialYaml({ slug: "s", name: "N" }, brandMap),
    ).toBeNull();
  });

  // branch 271: a FFF material with NO `brand` key exercises the
  // `(raw.brand)?.slug || ""` empty-string fallback, so brandSlug is ""
  // and brandName degrades to that empty string.
  it("defaults brandSlug to empty string when the material has no brand", () => {
    const raw = { slug: "no-brand", name: "No Brand", class: "FFF", type: "PLA" };
    const m = parseMaterialYaml(raw, brandMap);
    expect(m).not.toBeNull();
    expect(m!.brandSlug).toBe("");
    expect(m!.brandName).toBe(""); // brand?.name || brandSlug, both empty
  });

  // Invalid YAML string reaches the catch → null (line 355/356). parseYaml
  // throws on the malformed document.
  it("returns null when the YAML string is unparseable (catch path)", () => {
    expect(parseMaterialYaml("foo: [unterminated", brandMap)).toBeNull();
  });

  // branch 303: a secondary_colors entry with an invalid color_rgba is
  // dropped (rgbaToHex returns null), so it never lands in the array.
  it("skips secondary_colors entries with an invalid color_rgba", () => {
    const raw = {
      slug: "mixed-secondaries",
      name: "Mixed",
      class: "FFF",
      type: "PLA",
      brand: { slug: "amolen" },
      secondary_colors: [
        { color_rgba: "#00ff00ff" }, // valid
        { color_rgba: "zzzzzzzz" }, // invalid charset → dropped
        {}, // no color_rgba → dropped
        { color_rgba: "#0000ffff" }, // valid
      ],
    };
    const m = parseMaterialYaml(raw, new Map([["amolen", { name: "Amolen" }]]));
    expect(m).not.toBeNull();
    expect(m!.secondaryColors).toEqual(["#00ff00", "#0000ff"]);
  });

  // Fallback branches 326 (uuid || ""), 330 (type || "Unknown"),
  // 331 (abbreviation || type || ""), and 348 (photos[0].url || null).
  it("applies fallbacks for missing uuid/type/abbreviation and a photo with no url", () => {
    const raw = {
      slug: "fallbacks",
      name: "Fallbacks",
      class: "FFF",
      brand: { slug: "amolen" },
      // no uuid, no type, no abbreviation
      photos: [{ type: "unspecified" }], // present but no url
    };
    const m = parseMaterialYaml(raw, new Map([["amolen", { name: "Amolen" }]]));
    expect(m).not.toBeNull();
    expect(m!.uuid).toBe("");
    expect(m!.type).toBe("Unknown");
    expect(m!.abbreviation).toBe(""); // no type to fall back to either
    expect(m!.photoUrl).toBeNull(); // photos present but first has no url
  });

  it("still parses the legacy keyed secondary_color_0..4 shape", () => {
    // Belt-and-braces — if an older spec snapshot or a future schema
    // tidy-up keys the slots individually, we still get the colors.
    const yaml = `uuid: def
slug: legacy-keyed
brand:
  slug: amolen
name: Legacy Keyed
class: FFF
type: PLA
secondary_color_0:
  color_rgba: '#aa0000ff'
secondary_color_1:
  color_rgba: '#00aa00ff'`;
    const m = parseMaterialYaml(yaml, new Map([["amolen", { name: "Amolen" }]]));
    expect(m).not.toBeNull();
    expect(m!.secondaryColors).toEqual(["#aa0000", "#00aa00"]);
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
      secondaryColors: [],
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
      secondaryColors: [],
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

  // GH #604: the OPT YAML uses `gradual_color_change` for the gradient
  // arrangement. The pre-fix TAG_STRING_TO_OPT only knew `gradient`,
  // so the resolved optTags array didn't include 27 (GRADIENT) and the
  // imported filament rendered as a solid swatch even when secondary
  // colors were populated.
  it("aliases gradual_color_change to OPT_TAG.GRADIENT (#604)", () => {
    const material = {
      slug: "test-gradient",
      uuid: "test-uuid",
      brandSlug: "amolen",
      brandName: "Amolen",
      name: "Gradient",
      type: "PLA",
      abbreviation: "PLA",
      color: null,
      secondaryColors: ["#000000", "#98282f", "#ddb95d"],
      density: 1.28,
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
      tags: ["silk", "gradual_color_change", "industrially_compostable"],
      photoUrl: null,
      productUrl: null,
      completenessScore: 4,
      completenessTier: "partial" as const,
    };

    const payload = mapToFilamentPayload(material);
    const optTags = payload.optTags as number[];
    // SILK = 17, GRADIENT = 27, BIODEGRADABLE = 12 (industrially_compostable
    // alias). The order in the array isn't asserted — `deriveArrangement`
    // looks them up by `includes`.
    expect(optTags).toContain(17);
    expect(optTags).toContain(27);
    expect(optTags).toContain(12);
    // And the multi-color slots survive into the payload — null primary
    // (no `#808080` phantom) so allColors() falls through to the
    // secondary list at render time.
    expect(payload.color).toBeNull();
    expect(payload.secondaryColors).toEqual(["#000000", "#98282f", "#ddb95d"]);
  });

  it("aliases coextruded to OPT_TAG.DUAL_COLOR so the arrangement renders (#604)", () => {
    const material = {
      slug: "test-coextruded",
      uuid: "test-uuid",
      brandSlug: "amolen",
      brandName: "Amolen",
      name: "Dual",
      type: "PLA",
      abbreviation: "PLA",
      color: null,
      secondaryColors: ["#000000", "#ffffff"],
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
      tags: ["coextruded"],
      photoUrl: null,
      productUrl: null,
      completenessScore: 1,
      completenessTier: "stub" as const,
    };

    const payload = mapToFilamentPayload(material);
    const optTags = payload.optTags as number[];
    // DUAL_COLOR = 28 — deriveArrangement collapses DUAL/TRIPLE into
    // "coextruded", so the slot count being 2 vs 3 doesn't change the
    // rendered arrangement.
    expect(optTags).toContain(28);
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
      secondaryColors: [],
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

  // branch 372: a tag string with no TAG_STRING_TO_OPT entry (enumKey
  // undefined) is silently skipped rather than emitting a bad enum value.
  it("skips tag strings with no OPT_TAG mapping", () => {
    const material = {
      slug: "test",
      uuid: "test-uuid",
      brandSlug: "test",
      brandName: "Test",
      name: "Test",
      type: "PLA",
      abbreviation: "PLA",
      color: "#000000",
      secondaryColors: [],
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
      tags: ["not_a_real_opt_tag", "abrasive"],
      photoUrl: null,
      productUrl: null,
      completenessScore: 1,
      completenessTier: "stub" as const,
    };

    const payload = mapToFilamentPayload(material);
    const optTags = payload.optTags as number[];
    // Only the mapped tag (ABRASIVE = 4) survives; the unknown one is dropped.
    expect(optTags).toEqual([4]);
  });
});

describe("clearCache", () => {
  it("clears cached database so next fetch re-downloads", () => {
    // clearCache should not throw
    expect(() => clearCache()).not.toThrow();
  });
});

describe("getProxyDispatcher", () => {
  // Pure-function test that doesn't touch fetch — covers the env-var
  // matrix the Codex feedback flagged. Each call passes its own env so
  // we don't have to mutate process.env.

  it("returns undefined when no proxy env vars are set", () => {
    expect(getProxyDispatcher({})).toBeUndefined();
  });

  for (const key of [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
  ] as const) {
    it(`returns an EnvHttpProxyAgent when ${key} is set`, () => {
      const dispatcher = getProxyDispatcher({ [key]: "http://proxy.example.invalid:8080" });
      expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    });
  }

  it("treats an empty proxy string as unset", () => {
    expect(getProxyDispatcher({ HTTPS_PROXY: "" })).toBeUndefined();
  });
});

describe("fetchOpenPrintTagDatabase", () => {
  let tarballsToCleanup: string[] = [];

  // Isolate the temp root from the shared real os.tmpdir(): the suite's
  // countTempDirs()/sweep assertions key off the literal `openprinttag-`
  // prefix, but production sweepStaleTempDirs() runs against that same dir on
  // every fetch — a >1h-old leftover from a crashed earlier CI run would make
  // a count assertion fail for unrelated reasons. os.tmpdir() reads
  // TMPDIR/TMP/TEMP at call time, so pointing them at a private dir redirects
  // both the module's mkdtemp/sweep AND this file's helpers there.
  const savedTmpEnv: Record<string, string | undefined> = {};
  let isolatedTmpRoot = "";
  beforeAll(() => {
    for (const k of ["TMPDIR", "TMP", "TEMP"]) savedTmpEnv[k] = process.env[k];
    // Create the private root under the ORIGINAL temp dir before we repoint.
    isolatedTmpRoot = mkdtempSync(join(tmpdir(), "opt-test-root-"));
    process.env.TMPDIR = isolatedTmpRoot;
    process.env.TMP = isolatedTmpRoot;
    process.env.TEMP = isolatedTmpRoot;
  });
  afterAll(() => {
    for (const k of ["TMPDIR", "TMP", "TEMP"]) {
      if (savedTmpEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedTmpEnv[k];
    }
    try {
      rmSync(isolatedTmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  beforeEach(() => {
    clearCache();
    tarballsToCleanup = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const p of tarballsToCleanup) {
      try { rmSync(p, { force: true }); } catch { /* swallow */ }
    }
  });

  it("fetches and parses the database from a streamed tarball", async () => {
    // GitHub's tarball API extracts to a top-level dir like
    // OpenPrintTag-openprinttag-database-<sha>/. We mirror that here so
    // the production code's "first entry under tmpDir" assumption holds.
    const tarballPath = mockFetchTarball({
      "OpenPrintTag-abc123/data/brands/prusament.yaml":
        "slug: prusament\nname: Prusament\ncountry: CZ\n",
      "OpenPrintTag-abc123/data/materials/prusament/prusament-pla-galaxy-black.yaml":
        `uuid: test-uuid-1234
slug: prusament-pla-galaxy-black
brand:
  slug: prusament
name: PLA Galaxy Black
class: FFF
type: PLA
abbreviation: PLA
primary_color:
  color_rgba: '#3d3e3dff'
properties:
  density: 1.24
  min_print_temperature: 205
  max_print_temperature: 225
  min_bed_temperature: 40
  max_bed_temperature: 60
`,
      "OpenPrintTag-abc123/data/materials/prusament/some-resin.yaml":
        `uuid: resin-uuid
slug: some-resin
brand:
  slug: prusament
name: Some Resin
class: SLA
type: Resin
`,
    });
    tarballsToCleanup.push(tarballPath);

    const db = await fetchOpenPrintTagDatabase();

    expect(db.totalFFF).toBe(1);
    expect(db.totalSLA).toBe(1);
    expect(db.materials).toHaveLength(1);
    expect(db.materials[0].slug).toBe("prusament-pla-galaxy-black");
    expect(db.materials[0].brandName).toBe("Prusament");
    expect(db.brands).toHaveLength(1);
    expect(db.brands[0].name).toBe("Prusament");
    expect(db.cachedAt).toBeTruthy();
  });

  it("returns cached result on second call without re-fetching", async () => {
    const tarballPath = mockFetchTarball({
      "OpenPrintTag-abc/data/brands/.gitkeep": "",
      "OpenPrintTag-abc/data/materials/test.yaml":
        "uuid: u1\nslug: test\nbrand:\n  slug: test\nname: Test\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);

    await fetchOpenPrintTagDatabase();
    await fetchOpenPrintTagDatabase();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("attaches an EnvHttpProxyAgent dispatcher when HTTPS_PROXY is set", async () => {
    // Regression for the Codex P2 on PR #137: bare fetch() ignores
    // HTTP_PROXY/HTTPS_PROXY by default, so any proxy-restricted
    // deployment that worked through the old curl pipeline would silently
    // fail after the migration. We ship a dispatcher when those env vars
    // are present.
    const tarballPath = mockFetchTarball({
      "OpenPrintTag-x/data/brands/.gitkeep": "",
      "OpenPrintTag-x/data/materials/p.yaml":
        "uuid: p\nslug: p\nbrand:\n  slug: x\nname: P\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);

    process.env.HTTPS_PROXY = "http://proxy.example.invalid:8080";
    try {
      await fetchOpenPrintTagDatabase();
      const initArg = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
        dispatcher?: unknown;
      };
      expect(initArg.dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    } finally {
      delete process.env.HTTPS_PROXY;
    }
  });

  it("does not attach a dispatcher when no proxy env var is set", async () => {
    const tarballPath = mockFetchTarball({
      "OpenPrintTag-y/data/brands/.gitkeep": "",
      "OpenPrintTag-y/data/materials/p.yaml":
        "uuid: p\nslug: p\nbrand:\n  slug: y\nname: P\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);

    // Make sure no proxy var leaks in from the parent shell.
    const saved = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      ALL_PROXY: process.env.ALL_PROXY,
      all_proxy: process.env.all_proxy,
    };
    for (const k of Object.keys(saved)) delete process.env[k];
    try {
      await fetchOpenPrintTagDatabase();
      const initArg = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
        dispatcher?: unknown;
      };
      expect(initArg.dispatcher).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  });

  it("propagates a 4xx/5xx response as a thrown error", async () => {
    // Regression: pre-fix the curl command failed silently in the docker
    // image (curl missing), leaving the user with a generic "Failed to
    // fetch" toast and a tar parse error in logs. With pure Node fetch we
    // get an actual response status to surface to the user.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404, statusText: "Not Found" }),
    );
    await expect(fetchOpenPrintTagDatabase()).rejects.toThrow(
      /404|Not Found|GitHub tarball/,
    );
  });

  it("#743: single-flight — concurrent callers share ONE fetch", async () => {
    // On a fresh install the cache is empty and the page auto-fetches; a
    // reload / second tab must not each kick off an independent
    // download+extract+parse. Concurrent calls share one in-flight load.
    const tarballPath = mockFetchTarball({
      "OpenPrintTag-sf/data/brands/.gitkeep": "",
      "OpenPrintTag-sf/data/materials/m.yaml":
        "uuid: m\nslug: m\nbrand:\n  slug: x\nname: M\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);

    const [a, b] = await Promise.all([
      fetchOpenPrintTagDatabase(),
      fetchOpenPrintTagDatabase(),
    ]);

    // Without single-flight this would be 2 (each call fetches independently).
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // both callers get the same resolved object
  });

  it("#743: a failed cold load doesn't wedge later calls (in-flight cleared on reject)", async () => {
    // Every attempt fails and there's no cache to fall back on (clean install),
    // so the first call rejects. The in-flight promise must be cleared so a
    // later call RE-ATTEMPTS rather than awaiting the dead rejected promise.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 503, statusText: "Service Unavailable" }),
    );
    await expect(fetchOpenPrintTagDatabase()).rejects.toThrow();

    // Now the server recovers — a subsequent call must succeed, not hang on a
    // stale rejected promise.
    vi.restoreAllMocks();
    const tarballPath = mockFetchTarball({
      "OpenPrintTag-recover/data/brands/.gitkeep": "",
      "OpenPrintTag-recover/data/materials/m.yaml":
        "uuid: m\nslug: m\nbrand:\n  slug: x\nname: M\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);
    const db = await fetchOpenPrintTagDatabase();
    expect(db.totalFFF).toBe(1);
  });

  it("#743: clearCache during an in-flight load doesn't start a duplicate fetch", async () => {
    // Codex P1: a refresh (clearCache + refetch) while a cold load is still
    // running must JOIN that load, not start a second download+parse. clearCache
    // therefore must NOT forget the in-flight promise.
    const tarballPath = mockFetchTarball({
      "OpenPrintTag-cc/data/brands/.gitkeep": "",
      "OpenPrintTag-cc/data/materials/m.yaml":
        "uuid: m\nslug: m\nbrand:\n  slug: x\nname: M\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);

    const p1 = fetchOpenPrintTagDatabase(); // starts the load (sets inFlightFetch)
    clearCache(); // refresh clears the cached RESULT mid-flight
    const p2 = fetchOpenPrintTagDatabase(); // must join the running load
    const [a, b] = await Promise.all([p1, p2]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // joined, not duplicated
    expect(a).toBe(b);
  });

  // Helper: count `openprinttag-*` temp dirs currently in tmpdir().
  function countTempDirs(): number {
    return readdirSync(tmpdir()).filter((n) => n.startsWith("openprinttag-")).length;
  }

  it("cleans up its own temp dir after a successful fetch", async () => {
    const before = countTempDirs();
    const tarballPath = mockFetchTarball({
      "OpenPrintTag-clean/data/brands/.gitkeep": "",
      "OpenPrintTag-clean/data/materials/m.yaml":
        "uuid: m\nslug: m\nbrand:\n  slug: x\nname: M\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);

    await fetchOpenPrintTagDatabase();

    // The per-attempt mkdtemp dir must be removed in the finally — no net
    // growth in `openprinttag-*` dirs (the cause of the %TEMP% buildup).
    expect(countTempDirs()).toBe(before);
  });

  it("sweeps stale openprinttag-* temp dirs (>1h old) on fetch", async () => {
    // Simulate a partial copy left by an earlier interrupted run: an
    // openprinttag-* dir with an mtime well over an hour ago.
    const stale = mkdtempSync(join(tmpdir(), "openprinttag-"));
    writeFileSync(join(stale, "leftover.txt"), "partial");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    expect(existsSync(stale)).toBe(true);

    const tarballPath = mockFetchTarball({
      "OpenPrintTag-sweep/data/brands/.gitkeep": "",
      "OpenPrintTag-sweep/data/materials/m.yaml":
        "uuid: m\nslug: m\nbrand:\n  slug: x\nname: M\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);

    await fetchOpenPrintTagDatabase();

    // The stale dir is reclaimed by the start-of-run sweep.
    expect(existsSync(stale)).toBe(false);
  });

  it("does NOT sweep a fresh openprinttag-* dir (mtime within the window)", async () => {
    // A concurrent instance's in-progress dir (recent mtime) must survive the
    // sweep — only >1h-old dirs are reclaimed.
    const fresh = mkdtempSync(join(tmpdir(), "openprinttag-"));
    writeFileSync(join(fresh, "inprogress.txt"), "x");

    const tarballPath = mockFetchTarball({
      "OpenPrintTag-fresh/data/brands/.gitkeep": "",
      "OpenPrintTag-fresh/data/materials/m.yaml":
        "uuid: m\nslug: m\nbrand:\n  slug: x\nname: M\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);

    try {
      await fetchOpenPrintTagDatabase();
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("re-labels a download-phase timeout honestly (not a generic failure)", async () => {
    // The download AbortSignal fires as a TimeoutError. A timeout in the
    // download phase should surface a download-specific message.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    });

    await expect(fetchOpenPrintTagDatabase()).rejects.toThrow(
      /OpenPrintTag download timed out/,
    );
  });

  it("buffers the full body before extracting (download/extract deadlines decoupled)", async () => {
    // Regression for the Windows extract-timeout report: the response body is
    // drained into memory FIRST and extraction runs from that buffer, so the
    // network AbortSignal can't abort a slow disk-bound unpack. We assert the
    // body is fully consumed before any file is read back out by completing a
    // multi-file extract end-to-end from a chunked stream.
    const tarballPath = mockFetchTarball({
      "OpenPrintTag-buf/data/brands/amolen.yaml":
        "slug: amolen\nname: Amolen\n",
      "OpenPrintTag-buf/data/materials/amolen/a.yaml":
        "uuid: a\nslug: a\nbrand:\n  slug: amolen\nname: A\nclass: FFF\ntype: PLA\n",
      "OpenPrintTag-buf/data/materials/amolen/b.yaml":
        "uuid: b\nslug: b\nbrand:\n  slug: amolen\nname: B\nclass: FFF\ntype: PETG\n",
    });
    tarballsToCleanup.push(tarballPath);

    const db = await fetchOpenPrintTagDatabase();
    expect(db.totalFFF).toBe(2);
    expect(db.brands[0].name).toBe("Amolen");
  });

  it("rejects a download that exceeds the size cap (OOM/DoS guard)", async () => {
    // Stream more bytes than the (injected, tiny) cap and assert the guard
    // trips. The check runs BEFORE the chunk is retained, so this never holds
    // more than one over-limit chunk in memory.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 3 × 100-byte chunks = 300 bytes, over the 150-byte cap below.
          for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(100));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, statusText: "OK" });
    });

    await expect(
      downloadTarballToBuffer({ maxBytes: 150 }),
    ).rejects.toThrow(/exceeds size limit/);
  });

  it("returns the buffered body when under the size cap", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5]));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, statusText: "OK" });
    });

    const buf = await downloadTarballToBuffer({ maxBytes: 1024 });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(Array.from(buf)).toEqual([1, 2, 3, 4, 5]);
  });

  it("relabels a download-phase fetch timeout as a download timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    });

    await expect(
      downloadTarballToBuffer({ timeoutMs: 45_000 }),
    ).rejects.toThrow(/OpenPrintTag download timed out \(45s limit\)/);
  });

  it("throws when the response is ok but has no body (line 889)", async () => {
    // A 200 with a null body is a broken/degenerate response; the code
    // refuses it explicitly rather than dereferencing a null stream.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200, statusText: "OK" }),
    );
    await expect(downloadTarballToBuffer()).rejects.toThrow(
      /response had no body/,
    );
  });

  it("serves the stale cache when a forced refresh's download fails (lines 757-763)", async () => {
    // Seed the cache with a tarball whose extracted dir name carries NO
    // parseable SHA, so `sha` stays undefined and the SHA-aware probe is
    // skipped on the next forced refresh — the refresh goes straight to the
    // tarball download. That download then fails, and because a cached
    // payload exists (even past TTL) the stale-cache fallback serves it
    // instead of throwing.
    const seedPath = mockFetchTarball({
      "OpenPrintTag-nosha/data/brands/x.yaml": "slug: x\nname: X\n",
      "OpenPrintTag-nosha/data/materials/x/m.yaml":
        "uuid: m\nslug: m\nbrand:\n  slug: x\nname: M\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(seedPath);
    const seeded = await fetchOpenPrintTagDatabase();
    expect(seeded.totalFFF).toBe(1);
    expect(seeded.sha).toBeUndefined(); // no SHA parsed → probe won't run

    // Now every download attempt fails. With a populated cache the fetch
    // resolves to the STALE payload rather than rejecting.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("boom", { status: 500, statusText: "Server Error" }),
    );
    const stale = await fetchOpenPrintTagDatabase({ force: true });
    expect(stale.totalFFF).toBe(1);
    expect(stale.materials).toBe(seeded.materials); // same cached object
  });
});

describe("isTimeoutAbort", () => {
  it("is true for TimeoutError and AbortError", () => {
    const t = new Error("timeout");
    t.name = "TimeoutError";
    const a = new Error("aborted");
    a.name = "AbortError";
    expect(isTimeoutAbort(t)).toBe(true);
    expect(isTimeoutAbort(a)).toBe(true);
  });

  it("is false for other errors and non-errors", () => {
    expect(isTimeoutAbort(new Error("nope"))).toBe(false);
    expect(isTimeoutAbort("AbortError")).toBe(false);
    expect(isTimeoutAbort(null)).toBe(false);
  });
});

describe("relabelTimeoutError", () => {
  it("labels an extract-phase AbortError honestly (download completed)", () => {
    // The core of PR #933: an extract stall must NOT read as a download
    // failure. An AbortError from the extract AbortController feeds this.
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const out = relabelTimeoutError(abort, "extract");
    expect(out).toBeInstanceOf(Error);
    expect(out!.message).toMatch(/extract timed out \(120s limit\)/);
    expect(out!.message).toMatch(/the download completed but the extract phase/);
  });

  it("labels a download-phase TimeoutError as a download timeout", () => {
    const to = new Error("timeout");
    to.name = "TimeoutError";
    const out = relabelTimeoutError(to, "download");
    expect(out!.message).toMatch(/OpenPrintTag download timed out \(45s limit\)/);
  });

  it("honours injected deadlines in the surfaced message", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(
      relabelTimeoutError(abort, "extract", { extractTimeoutMs: 90_000 })!.message,
    ).toMatch(/90s limit/);
    expect(
      relabelTimeoutError(abort, "download", { downloadTimeoutMs: 30_000 })!.message,
    ).toMatch(/30s limit/);
  });

  it("returns null for a non-timeout error (caller rethrows the original)", () => {
    expect(relabelTimeoutError(new Error("tar bomb"), "extract")).toBeNull();
  });
});

describe("extractAndParse maxExtractBytes cap", () => {
  // Parity test for PR #933 review follow-up: downloadTarballToBuffer({maxBytes})
  // is exported + tested for the compressed download cap. The symmetric guard
  // on the DECOMPRESSED stream (the counting Transform between gunzip and
  // tar.x) needs the same coverage so a future refactor can't silently drop
  // the bound. The cap is injectable so we can trip it without allocating
  // 256 MB of zeros.
  let tarballsToCleanup: string[] = [];
  let extractTmpDir = "";

  beforeEach(() => {
    clearCache();
    tarballsToCleanup = [];
    extractTmpDir = mkdtempSync(join(tmpdir(), "opt-test-extract-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const p of tarballsToCleanup) {
      try { rmSync(p, { force: true }); } catch { /* swallow */ }
    }
    try { rmSync(extractTmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it("rejects a tarball whose decompressed bytes exceed the injected cap (tar-bomb guard)", async () => {
    // A normal-looking tarball with a few hundred bytes of decompressed
    // content. Setting maxExtractBytes well below that total trips the
    // counting Transform mid-stream; the pipeline tears down and the error
    // surfaces with the tar-bomb wording.
    const tarballPath = buildTarball({
      "OpenPrintTag-bomb/data/brands/.gitkeep": "",
      // ~500 bytes of payload — comfortably over the 100-byte cap below.
      "OpenPrintTag-bomb/data/materials/big.yaml":
        "x".repeat(500),
    });
    tarballsToCleanup.push(tarballPath);
    const buf = readFileSync(tarballPath);

    await expect(
      extractAndParse(buf, extractTmpDir, { maxExtractBytes: 100 }),
    ).rejects.toThrow(/exceeds extraction limits/);
  });

  it("accepts a tarball whose decompressed bytes stay under the injected cap", async () => {
    const tarballPath = buildTarball({
      "OpenPrintTag-ok/data/brands/.gitkeep": "",
      "OpenPrintTag-ok/data/materials/m.yaml":
        "uuid: m\nslug: m\nbrand:\n  slug: x\nname: M\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);
    const buf = readFileSync(tarballPath);

    // Generous cap — the tiny test tarball decompresses to well under 10 KB.
    const db = await extractAndParse(buf, extractTmpDir, { maxExtractBytes: 10 * 1024 });
    expect(db.totalFFF).toBe(1);
  });

  it("rejects a tarball with files but no materials, instead of caching an empty DB (Codex P2 #943)", async () => {
    // Files are present (fileCount > 0) but NONE under data/materials/ — a
    // malformed archive or an upstream layout change. The in-memory parser
    // must throw so runFetchWithRetries fails open to the stale cache rather
    // than caching an empty database (the old disk path threw here too, via
    // walkDir → ENOENT on a missing data/materials dir).
    const tarballPath = buildTarball({
      "OpenPrintTag-nomat/data/brands/x.yaml": "slug: x\nname: X\n",
      "OpenPrintTag-nomat/README.md": "no materials in this archive",
    });
    tarballsToCleanup.push(tarballPath);
    const buf = readFileSync(tarballPath);

    await expect(extractAndParse(buf, extractTmpDir)).rejects.toThrow(
      /no material files/,
    );
  });

  it("handles a zero-byte YAML entry without hanging (Codex P2 #943)", async () => {
    // A corrupt/unusual archive can carry an empty .yaml. node-tar may end the
    // zero-byte ReadEntry before readEntry attaches its 'end' listener; without
    // the zero-size short-circuit the buffered read never resolves and the whole
    // fetch hangs forever. The parse must complete and simply skip the empty file.
    const tarballPath = buildTarball({
      "OpenPrintTag-zb/data/brands/x.yaml": "slug: x\nname: X\n",
      "OpenPrintTag-zb/data/materials/x/empty.yaml": "",
      "OpenPrintTag-zb/data/materials/x/ok.yaml":
        "uuid: m\nslug: m\nbrand:\n  slug: x\nname: M\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);
    const buf = readFileSync(tarballPath);

    const db = await extractAndParse(buf, extractTmpDir);
    expect(db.totalFFF).toBe(1);
    expect(db.materials[0].slug).toBe("m");
  });

  // NOTE: the extract `filter`'s `..`-traversal rejection (defence-in-depth
  // over tar's own sanitisation) is intentionally NOT unit-tested. Triggering
  // it means throwing inside the live `tar` stream's filter, whose failure mode
  // is environment-dependent: on CI's Node 20/22 the throw surfaces as an
  // *uncaught* exception and the extract promise never settles (hang → 30s
  // timeout) rather than a clean rejection. It's a defence-in-depth guard (tar
  // sanitises too, and the tarball is a trusted GitHub download, not user
  // input), so it's left as a documented-defensive uncovered branch rather than
  // pinned by a flaky test.

  // Materials/brands parse-loop branch coverage (branches 1046/1049/1069/
  // 1077/1085): one tarball exercises every skip path so the FFF count only
  // reflects the genuinely-parseable FFF materials.
  it("skips non-yaml files, null-brand yaml, class-less, SLA, and unparseable-to-null materials", async () => {
    const tarballPath = buildTarball({
      // A non-yaml file in brands/ is skipped (branch 1046).
      "OpenPrintTag-mix/data/brands/README.md": "not yaml",
      // A brand yaml that parses but lacks required fields → parseBrandYaml
      // returns null → `if (brand)` false (branch 1049).
      "OpenPrintTag-mix/data/brands/broken.yaml": "foo: bar\n",
      // A valid brand.
      "OpenPrintTag-mix/data/brands/amolen.yaml": "slug: amolen\nname: Amolen\n",
      // Non-yaml file under materials/ → skipped (branch 1069).
      "OpenPrintTag-mix/data/materials/amolen/notes.txt": "ignore me",
      // A yaml with no `class` field → `!raw.class` continue (branch 1077).
      "OpenPrintTag-mix/data/materials/amolen/noclass.yaml":
        "uuid: n\nslug: n\nname: NoClass\ntype: PLA\n",
      // An SLA material → counted as SLA, skipped from FFF.
      "OpenPrintTag-mix/data/materials/amolen/resin.yaml":
        "uuid: r\nslug: r\nbrand:\n  slug: amolen\nname: Resin\nclass: SLA\ntype: Resin\n",
      // A FFF material missing `slug` → parseMaterialYaml returns null →
      // `if (material)` false (branch 1085).
      "OpenPrintTag-mix/data/materials/amolen/noslug.yaml":
        "uuid: ns\nname: No Slug\nclass: FFF\ntype: PLA\nbrand:\n  slug: amolen\n",
      // One genuinely-valid FFF material — the only one that should count.
      "OpenPrintTag-mix/data/materials/amolen/good.yaml":
        "uuid: g\nslug: good\nbrand:\n  slug: amolen\nname: Good PLA\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);
    const buf = readFileSync(tarballPath);

    const db = await extractAndParse(buf, extractTmpDir);
    expect(db.totalFFF).toBe(1);
    expect(db.totalSLA).toBe(1);
    expect(db.materials[0].slug).toBe("good");
    // The valid brand resolved its display name; the material inherits it.
    expect(db.materials[0].brandName).toBe("Amolen");
  });

  // Line 1029: an empty tarball (no top-level entries under tmpDir) throws
  // rather than dereferencing a missing repo root.
  it("throws when the tarball extracts to no files", async () => {
    // A tarball containing only an empty directory entry → readdir(tmpDir)
    // finds nothing to descend into (mkdtemp already exists but stays empty
    // because tar wrote no regular files at the top level). Build one with a
    // single empty dir.
    const staging = mkdtempSync(join(tmpdir(), "opt-empty-staging-"));
    // Intentionally leave staging empty; tar.c over "." yields a tarball whose
    // only entry is "./", which extracts nothing into tmpDir.
    const tarballPath = join(tmpdir(), `opt-empty-${Date.now()}.tgz`);
    tar.c({ gzip: true, file: tarballPath, cwd: staging, sync: true }, ["."]);
    rmSync(staging, { recursive: true, force: true });
    tarballsToCleanup.push(tarballPath);
    const buf = readFileSync(tarballPath);

    await expect(extractAndParse(buf, extractTmpDir)).rejects.toThrow(
      /produced no files/,
    );
  });

  // Line 1111: the brand-list sort comparator (`a.name.localeCompare`) only
  // runs when there are ≥2 brands to order. Two materials from two brands
  // exercise it and pin the alphabetical ordering.
  it("sorts the brand list alphabetically by name (>=2 brands)", async () => {
    const tarballPath = buildTarball({
      "OpenPrintTag-sort/data/brands/zeta.yaml": "slug: zeta\nname: Zeta Filament\n",
      "OpenPrintTag-sort/data/brands/alpha.yaml": "slug: alpha\nname: Alpha Filament\n",
      "OpenPrintTag-sort/data/materials/zeta/z.yaml":
        "uuid: z\nslug: z\nbrand:\n  slug: zeta\nname: Z\nclass: FFF\ntype: PLA\n",
      "OpenPrintTag-sort/data/materials/alpha/a.yaml":
        "uuid: a\nslug: a\nbrand:\n  slug: alpha\nname: A\nclass: FFF\ntype: PETG\n",
    });
    tarballsToCleanup.push(tarballPath);
    const buf = readFileSync(tarballPath);

    const db = await extractAndParse(buf, extractTmpDir);
    expect(db.brands.map((b) => b.name)).toEqual([
      "Alpha Filament",
      "Zeta Filament",
    ]);
  });
});

// ── #931: SHA-aware refresh ────────────────────────────────────────────

describe("shasMatch", () => {
  it("matches identical full SHAs", () => {
    expect(shasMatch("abc1234def5678", "abc1234def5678")).toBe(true);
  });

  it("matches abbreviated against full (cached short, upstream long)", () => {
    // The tarball-directory SHA is typically 7 chars; the commits API
    // returns the full 40-char SHA. The compare must succeed.
    expect(
      shasMatch(
        "abc1234567890abcdef1234567890abcdef123456",
        "abc1234",
      ),
    ).toBe(true);
  });

  it("is case-insensitive (GitHub returns lowercase, tar may capitalise)", () => {
    expect(shasMatch("ABC1234", "abc1234")).toBe(true);
  });

  it("returns false on a real mismatch", () => {
    expect(shasMatch("abc1234", "xyz9999")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(shasMatch("", "abc1234")).toBe(false);
    expect(shasMatch("abc1234", "")).toBe(false);
  });

  it("rejects a degenerately short common prefix", () => {
    // A 2-char overlap shouldn't count as a match.
    expect(shasMatch("ab", "abcdef1234")).toBe(false);
  });

  it("rejects anything shorter than MIN_SHA_PREFIX_LEN (7 chars)", () => {
    // The tarball regex emits `[0-9a-f]{7,40}`, so 7 is the smallest length
    // either source can produce. A 4–6 char value reaching shasMatch is a
    // malformed / truncated / hostile response and must NOT match — 1/65k
    // (4-char) or better random collision rate would let a broken proxy
    // lock the cache on a low-entropy prefix (hyiger P1 on PR #937).
    expect(shasMatch("abcdef", "abcdef1234567890abcdef1234567890abcdef12")).toBe(
      false,
    );
    expect(shasMatch("abcdef", "abcdef")).toBe(false);
    // 7 chars is the minimum accepted length.
    expect(
      shasMatch("abcdef1", "abcdef1234567890abcdef1234567890abcdef12"),
    ).toBe(true);
  });
});

describe("fetchUpstreamCommitSha", () => {
  beforeEach(() => {
    clearCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the SHA from the commits API on success", async () => {
    // Codex P2 on PR #937: the probe asks for `application/vnd.github.sha`
    // now, so GitHub returns the SHA as text/plain (a bare 40-char string),
    // NOT the full JSON commit blob. The mock mirrors that shape.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        "deadbeefcafef00d1234567890abcdef12345678",
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    });
    const sha = await fetchUpstreamCommitSha();
    expect(sha).toBe("deadbeefcafef00d1234567890abcdef12345678");
  });

  it("trims a trailing newline from the SHA text response", async () => {
    // Some HTTP clients append `\n` to text bodies; the probe must tolerate
    // that so the returned SHA is a pure hex string (Codex P2 on PR #937).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        "deadbeefcafef00d1234567890abcdef12345678\n",
        { status: 200, headers: { "content-type": "text/plain" } },
      ),
    );
    const sha = await fetchUpstreamCommitSha();
    expect(sha).toBe("deadbeefcafef00d1234567890abcdef12345678");
  });

  it("sends Accept: application/vnd.github.sha so GitHub returns the SHA as text/plain", async () => {
    // Codex P2 on PR #937 targeted a specific failure mode: on a big-refactor
    // upstream commit the default JSON response includes the changed-file
    // list and can exceed the 4 KB `readBodyCapped` cap. The switch to the
    // SHA media type is the load-bearing mechanism keeping the probe useful.
    // Without this assertion a silent revert to `application/vnd.github+json`
    // — the exact regression the fix targets — would pass every other test
    // in this file (all fetch mocks ignore the RequestInit argument).
    let capturedAcceptHeader: string | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      // RequestInit.headers is HeadersInit — normalise via a Headers instance
      // so plain-object and Headers-instance callers are both handled.
      const h = new Headers((init as RequestInit)?.headers);
      capturedAcceptHeader = h.get("accept");
      return new Response(
        "deadbeefcafef00d1234567890abcdef12345678",
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    });
    await fetchUpstreamCommitSha();
    expect(capturedAcceptHeader).toBe("application/vnd.github.sha");
  });

  it("attaches an EnvHttpProxyAgent dispatcher when HTTPS_PROXY is set (branch 705)", async () => {
    // The commits probe honours the same proxy dispatcher as the tarball
    // download so air-gapped / proxied deployments probe successfully.
    let capturedDispatcher: unknown;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      capturedDispatcher = (init as { dispatcher?: unknown }).dispatcher;
      return new Response("deadbeefcafef00d1234567890abcdef12345678", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });
    process.env.HTTPS_PROXY = "http://proxy.example.invalid:8080";
    try {
      const sha = await fetchUpstreamCommitSha();
      expect(sha).toBe("deadbeefcafef00d1234567890abcdef12345678");
      expect(capturedDispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    } finally {
      delete process.env.HTTPS_PROXY;
    }
  });

  it("returns null on a non-2xx response (fail-open)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 403 }),
    );
    expect(await fetchUpstreamCommitSha()).toBeNull();
  });

  it("returns null on network failure (fail-open)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND"));
    expect(await fetchUpstreamCommitSha()).toBeNull();
  });

  it("returns null when the response body is empty", async () => {
    // The SHA media type returns text/plain; an empty body signals a hostile
    // or broken response — fail-open to the tarball path.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(await fetchUpstreamCommitSha()).toBeNull();
  });

  it("returns null when the SHA is shorter than MIN_SHA_PREFIX_LEN (7)", async () => {
    // Belt-and-suspenders alongside shasMatch's own floor: reject the
    // degenerate prefix before it ever reaches the equality check, so a
    // hostile / truncated response can't stamp a low-entropy prefix on the
    // cache via subsequent flows (hyiger P1 on PR #937).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("abc123", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(await fetchUpstreamCommitSha()).toBeNull();
  });

  it("rejects a body that exceeds the 4 KB response cap", async () => {
    // The SHA-only payload is ~40 bytes; a hostile / misconfigured proxy
    // that returned a multi-MB body would previously be fully buffered
    // before parsing. `readBodyCapped` at 4 KB now backstops that (Codex P2
    // + hyiger P2 on PR #937). Simulate an oversize response via a manual
    // ReadableStream chunk larger than the cap.
    const oversize = Buffer.alloc(8 * 1024, "x");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(oversize), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(await fetchUpstreamCommitSha()).toBeNull();
  });
});

/**
 * #931 — end-to-end coverage for the SHA-aware refresh path.
 *
 * Setup model: `fetch` is mocked to discriminate on URL. The first call
 * populates the cache with a tarball whose directory name carries SHA "aaa…".
 * Subsequent `{force:true}` calls hit the commits API first; the test sets
 * the mock to return either the same SHA (slide-TTL path), a different SHA
 * (tarball refetch path), or 503 (fail-open → tarball refetch).
 */
describe("SHA-aware refresh (#931)", () => {
  let tarballsToCleanup: string[] = [];

  // The fetch shim needs the same isolated TMPDIR trick the parent suite uses,
  // because populating the cache requires running a full tarball extract.
  const savedTmpEnv: Record<string, string | undefined> = {};
  let isolatedTmpRoot = "";
  beforeAll(() => {
    for (const k of ["TMPDIR", "TMP", "TEMP"]) savedTmpEnv[k] = process.env[k];
    isolatedTmpRoot = mkdtempSync(join(tmpdir(), "opt-test-sha-root-"));
    process.env.TMPDIR = isolatedTmpRoot;
    process.env.TMP = isolatedTmpRoot;
    process.env.TEMP = isolatedTmpRoot;
  });
  afterAll(() => {
    for (const k of ["TMPDIR", "TMP", "TEMP"]) {
      if (savedTmpEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedTmpEnv[k];
    }
    try {
      rmSync(isolatedTmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  beforeEach(() => {
    clearCache();
    tarballsToCleanup = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const p of tarballsToCleanup) {
      try { rmSync(p, { force: true }); } catch { /* swallow */ }
    }
  });

  // Build a tarball whose extracted-root directory name embeds a particular
  // SHA. The extract path keys off the directory name suffix, so this is the
  // only way to seed a known cached SHA without poking at module internals.
  function tarballWithSha(sha: string): string {
    const tarballPath = buildTarball({
      [`OpenPrintTag-openprinttag-database-${sha}/data/brands/x.yaml`]:
        "slug: x\nname: X\n",
      [`OpenPrintTag-openprinttag-database-${sha}/data/materials/x/m.yaml`]:
        "uuid: m\nslug: m\nbrand:\n  slug: x\nname: M\nclass: FFF\ntype: PLA\n",
    });
    tarballsToCleanup.push(tarballPath);
    return tarballPath;
  }

  /**
   * Install a `fetch` mock that returns:
   *  - the commits-API response when the URL matches the commits endpoint
   *  - a streamed tarball otherwise
   *
   * Each commits-API response can be a SHA string (200/JSON), a status code
   * (4xx/5xx with empty body), or a thrown error to simulate network failure.
   * We also count calls per-bucket so the assertions can pin "tarball was/
   * wasn't re-downloaded".
   */
  function installMock(opts: {
    commitsResponses: Array<string | number | "throw">;
    tarballPath: string;
  }): { commitsCalls: () => number; tarballCalls: () => number } {
    let commitsIdx = 0;
    let commitsCalls = 0;
    let tarballCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/commits/main")) {
        commitsCalls += 1;
        const next = opts.commitsResponses[commitsIdx++];
        if (next === "throw") throw new Error("ENOTFOUND");
        if (typeof next === "number") {
          return new Response("err", { status: next });
        }
        // The probe asks for `application/vnd.github.sha` (Codex P2 on
        // PR #937), so GitHub returns the SHA as text/plain (a bare 40-char
        // string) — not the full JSON commit blob.
        return new Response(next, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      // Otherwise: stream the tarball.
      tarballCalls += 1;
      const nodeStream = createReadStream(opts.tarballPath);
      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          nodeStream.on("data", (chunk: Buffer | string) => {
            controller.enqueue(
              typeof chunk === "string"
                ? new TextEncoder().encode(chunk)
                : new Uint8Array(chunk),
            );
          });
          nodeStream.on("end", () => controller.close());
          nodeStream.on("error", (err) => controller.error(err));
        },
        cancel() {
          nodeStream.destroy();
        },
      });
      return new Response(webStream, {
        status: 200,
        headers: { "content-type": "application/x-gzip" },
      });
    });
    return {
      commitsCalls: () => commitsCalls,
      tarballCalls: () => tarballCalls,
    };
  }

  it("same SHA: probes commits API, serves cached, does NOT re-fetch tarball", async () => {
    const SHA = "abcdef0123456789abcdef0123456789abcdef01";
    const tarballPath = tarballWithSha(SHA);

    // First call: seed the cache with a tarball whose dir-name SHA matches.
    const counters = installMock({
      commitsResponses: [SHA], // for the SECOND call's probe
      tarballPath,
    });
    const first = await fetchOpenPrintTagDatabase();
    expect(first.totalFFF).toBe(1);
    expect(first.sha).toBe(SHA); // extracted from the tarball dir name
    expect(counters.tarballCalls()).toBe(1);
    expect(counters.commitsCalls()).toBe(0);

    // Second call with force=true: must hit commits API, see same SHA, and
    // serve cached data without re-downloading the tarball.
    const second = await fetchOpenPrintTagDatabase({ force: true });
    expect(counters.commitsCalls()).toBe(1);
    expect(counters.tarballCalls()).toBe(1); // unchanged from the first call
    expect(second.totalFFF).toBe(1);
    expect(second.sha).toBe(SHA);
    // The probe path stamped `shaCheckedAt` with a fresh ISO timestamp.
    // Pre-review this asserted `!== first.shaCheckedAt` which could flake on
    // fast CI when both `Date.now()` calls returned the same ms (Codex P2 on
    // PR #937). The commits-call counter above already proves the probe
    // branch ran; here we just pin that a valid ISO string landed.
    expect(second.shaCheckedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    );
    // Slide-TTL uses a SHALLOW spread — `materials` and `brands` MUST be the
    // same array references as the previous parse (a future refactor to
    // `structuredClone()` / `JSON.parse(JSON.stringify(...))` would re-allocate
    // ~11k materials on every probe, so this pins the reference-identity
    // invariant; hyiger P3 on PR #937).
    expect(second.materials).toBe(first.materials);
    expect(second.brands).toBe(first.brands);
  });

  it("changed SHA: probes commits API, then re-fetches tarball", async () => {
    const SHA_OLD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_NEW = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // Seed with the OLD tarball.
    let counters = installMock({
      commitsResponses: [],
      tarballPath: tarballWithSha(SHA_OLD),
    });
    const first = await fetchOpenPrintTagDatabase();
    expect(first.sha).toBe(SHA_OLD);
    expect(counters.tarballCalls()).toBe(1);
    vi.restoreAllMocks();

    // Now: commits API reports the NEW SHA, tarball stream serves the NEW
    // tarball. The library must probe THEN re-fetch.
    counters = installMock({
      commitsResponses: [SHA_NEW],
      tarballPath: tarballWithSha(SHA_NEW),
    });
    const second = await fetchOpenPrintTagDatabase({ force: true });
    expect(counters.commitsCalls()).toBe(1);
    expect(counters.tarballCalls()).toBe(1); // the NEW tarball was fetched
    expect(second.sha).toBe(SHA_NEW);
  });

  it("commits-API failure: falls through to tarball (fail-open)", async () => {
    const SHA = "cccccccccccccccccccccccccccccccccccccccc";
    // Seed.
    let counters = installMock({
      commitsResponses: [],
      tarballPath: tarballWithSha(SHA),
    });
    await fetchOpenPrintTagDatabase();
    expect(counters.tarballCalls()).toBe(1);
    vi.restoreAllMocks();

    // Refresh: commits API returns 503 — must NOT wedge the refresh.
    counters = installMock({
      commitsResponses: [503],
      tarballPath: tarballWithSha(SHA),
    });
    const refreshed = await fetchOpenPrintTagDatabase({ force: true });
    expect(counters.commitsCalls()).toBe(1);
    // Tarball WAS re-fetched (the fail-open fallback path).
    expect(counters.tarballCalls()).toBe(1);
    expect(refreshed.totalFFF).toBe(1);
  });

  it("cold start: no cache means no commits probe — straight to tarball", async () => {
    const SHA = "1111111111111111111111111111111111111111";
    const counters = installMock({
      commitsResponses: [],
      tarballPath: tarballWithSha(SHA),
    });
    // Force=true on a clean cache. There's nothing to compare against, so
    // the SHA probe must NOT run (it has no baseline) and we go directly to
    // the tarball download.
    const db = await fetchOpenPrintTagDatabase({ force: true });
    expect(counters.commitsCalls()).toBe(0);
    expect(counters.tarballCalls()).toBe(1);
    expect(db.totalFFF).toBe(1);
    expect(db.sha).toBe(SHA);
  });

  it("single-flight: N concurrent forced refreshes share ONE probe call", async () => {
    const SHA = "2222222222222222222222222222222222222222";

    // Seed the cache first so the probe branch is reachable.
    let counters = installMock({
      commitsResponses: [],
      tarballPath: tarballWithSha(SHA),
    });
    await fetchOpenPrintTagDatabase();
    expect(counters.tarballCalls()).toBe(1);
    vi.restoreAllMocks();

    // Now install a mock whose commits response can be consumed exactly ONCE
    // (a second commits call would return `undefined` and throw the mock —
    // making the amplification visible). Fire N forced refreshes IN PARALLEL:
    // pre-review each would fire its own probe → N calls hitting GitHub's
    // 60/hr unauthenticated quota; post-review the single-flight guard wraps
    // the probe so all N share ONE probe call and ONE decision.
    counters = installMock({
      commitsResponses: [SHA], // only ONE commits response provisioned
      tarballPath: tarballWithSha(SHA),
    });
    const results = await Promise.all([
      fetchOpenPrintTagDatabase({ force: true }),
      fetchOpenPrintTagDatabase({ force: true }),
      fetchOpenPrintTagDatabase({ force: true }),
      fetchOpenPrintTagDatabase({ force: true }),
      fetchOpenPrintTagDatabase({ force: true }),
    ]);
    // ONE probe call, ZERO tarball calls (same SHA → slide-TTL).
    expect(counters.commitsCalls()).toBe(1);
    expect(counters.tarballCalls()).toBe(0);
    // All callers got the same (slide-TTL upgraded) result.
    for (const r of results) {
      expect(r.sha).toBe(SHA);
      expect(r.totalFFF).toBe(1);
    }
    // And the shallow-spread invariant: all 5 results are the SAME object
    // reference (single-flight returned the same in-progress promise to
    // every caller, and the slide-TTL branch returns `cachedDatabase`).
    for (const r of results) {
      expect(r).toBe(results[0]);
    }
  });
});

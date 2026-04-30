import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, createReadStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as tar from "tar";

import {
  computeCompletenessScore,
  completenessTier,
  rgbaToHex,
  parseBrandYaml,
  parseMaterialYaml,
  mapToFilamentPayload,
  fetchOpenPrintTagDatabase,
  getProxyDispatcher,
  clearCache,
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
    const fullPath = join(stagingDir, relPath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
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
});

/**
 * OpenPrintTag Database Browser
 *
 * Fetches the OpenPrintTag community database from GitHub, parses the YAML
 * material files, filters to FFF (FDM) filaments, and scores each entry
 * by data completeness.
 *
 * Uses the GitHub tarball API to download the entire repo in a single request
 * (~3 MB compressed), extracts in a temp directory, and parses all YAML files.
 * Results are cached in memory with a 1-hour TTL.
 *
 * Reference: https://github.com/OpenPrintTag/openprinttag-database
 */

import { parse as parseYaml } from "yaml";
import { execSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { OPT_TAG } from "@/lib/openprinttag";

// ── Types ──────────────────────────────────────────────────────────────

export interface OPTBrand {
  slug: string;
  name: string;
  country?: string;
  materialCount: number;
}

export interface OPTMaterial {
  slug: string;
  uuid: string;
  brandSlug: string;
  brandName: string;
  name: string;
  type: string;
  abbreviation: string;
  color: string | null;
  density: number | null;
  nozzleTempMin: number | null;
  nozzleTempMax: number | null;
  bedTempMin: number | null;
  bedTempMax: number | null;
  chamberTemp: number | null;
  preheatTemp: number | null;
  dryingTemp: number | null;
  dryingTime: number | null;
  hardnessShoreD: number | null;
  transmissionDistance: number | null;
  tags: string[];
  photoUrl: string | null;
  productUrl: string | null;
  completenessScore: number;
  completenessTier: "rich" | "partial" | "stub";
}

export interface OPTDatabase {
  brands: OPTBrand[];
  materials: OPTMaterial[];
  cachedAt: string;
  totalFFF: number;
  totalSLA: number;
}

// ── Tag string → OPT_TAG enum mapping ──────────────────────────────────

const TAG_STRING_TO_OPT: Record<string, string> = {
  contains_glass_fiber: "CONTAINS_GLASS_FIBER",
  contains_carbon_fiber: "CONTAINS_CARBON_FIBER",
  contains_kevlar: "CONTAINS_KEVLAR",
  contains_aramid_fiber: "CONTAINS_ARAMID_FIBER",
  transparent: "TRANSPARENT",
  translucent: "TRANSLUCENT",
  abrasive: "ABRASIVE",
  food_safe: "FOOD_SAFE",
  heat_resistant: "HEAT_RESISTANT",
  uv_resistant: "UV_RESISTANT",
  flame_retardant: "FLAME_RETARDANT",
  flexible: "FLEXIBLE",
  conductive: "CONDUCTIVE",
  magnetic: "MAGNETIC",
  biodegradable: "BIODEGRADABLE",
  water_soluble: "WATER_SOLUBLE",
  high_impact: "HIGH_IMPACT",
  low_warp: "LOW_WARP",
  matte: "MATTE",
  silk: "SILK",
  imitates_marble: "MARBLE",
  wood_fill: "WOOD_FILL",
  metal_fill: "METAL_FILL",
  stone_fill: "STONE_FILL",
  sparkle: "SPARKLE",
  phosphorescent: "PHOSPHORESCENT",
  glow_in_dark: "GLOW_IN_THE_DARK",
  glow_in_the_dark: "GLOW_IN_THE_DARK",
  color_changing: "COLOR_CHANGING",
  fuzzy: "FUZZY",
  gradient: "GRADIENT",
  dual_color: "DUAL_COLOR",
  triple_color: "TRIPLE_COLOR",
  hygroscopic: "HYGROSCOPIC",
  anti_static: "ANTI_STATIC",
  esd_safe: "ESD_SAFE",
  chemically_resistant: "CHEMICALLY_RESISTANT",
  medical_grade: "MEDICAL_GRADE",
  automotive_grade: "AUTOMOTIVE_GRADE",
  aerospace_grade: "AEROSPACE_GRADE",
  recycled: "RECYCLED",
  high_speed: "HIGH_SPEED",
  glitter: "SPARKLE",
  blend: "BLEND",
  industrially_compostable: "BIODEGRADABLE",
  filtration_recommended: "FILTRATION_RECOMMENDED",
};

// ── Completeness scoring ───────────────────────────────────────────────

/**
 * Compute a completeness score (0–10) for a parsed OpenPrintTag material.
 * Each field that is present and non-empty contributes 1 point.
 */
export function computeCompletenessScore(raw: Record<string, unknown>): number {
  const props = (raw.properties || {}) as Record<string, unknown>;
  let score = 0;

  // 1. Color
  if (raw.primary_color && (raw.primary_color as Record<string, unknown>).color_rgba) score++;
  // 2. Density
  if (props.density != null) score++;
  // 3. Print temperatures
  if (props.min_print_temperature != null || props.max_print_temperature != null) score++;
  // 4. Bed temperatures
  if (props.min_bed_temperature != null || props.max_bed_temperature != null) score++;
  // 5. Drying temperature
  if (props.drying_temperature != null) score++;
  // 6. Hardness
  if (props.hardness_shore_d != null || props.hardness_shore_a != null) score++;
  // 7. Transmission distance
  if (raw.transmission_distance != null) score++;
  // 8. Chamber temperature
  if (props.chamber_temperature != null) score++;
  // 9. Photos
  if (Array.isArray(raw.photos) && raw.photos.length > 0) score++;
  // 10. Product URL
  if (raw.url) score++;

  return score;
}

/**
 * Map a completeness score to a tier label.
 */
export function completenessTier(score: number): "rich" | "partial" | "stub" {
  if (score >= 7) return "rich";
  if (score >= 4) return "partial";
  return "stub";
}

// ── RGBA to hex conversion ─────────────────────────────────────────────

/**
 * Convert an OpenPrintTag RGBA color string (#RRGGBBaa) to a standard hex (#RRGGBB).
 */
export function rgbaToHex(rgba: string | undefined | null): string | null {
  if (!rgba) return null;
  // Strip alpha channel if present (e.g., #ea5e1aff → #ea5e1a)
  const hex = rgba.replace(/^#/, "");
  if (hex.length === 8) return `#${hex.slice(0, 6)}`;
  if (hex.length === 6) return `#${hex}`;
  return null;
}

// ── YAML parsing ───────────────────────────────────────────────────────

/**
 * Parse a single brand YAML file into brand metadata.
 */
export function parseBrandYaml(
  content: string,
): { slug: string; name: string; country?: string } | null {
  try {
    const data = parseYaml(content) as Record<string, unknown>;
    if (!data || !data.slug || !data.name) return null;
    return {
      slug: data.slug as string,
      name: data.name as string,
      country: Array.isArray(data.countries_of_origin)
        ? (data.countries_of_origin[0] as string)
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a single material YAML file into an OPTMaterial (or null if SLA/invalid).
 */
export function parseMaterialYaml(
  content: string,
  brandMap: Map<string, { name: string; country?: string }>,
): OPTMaterial | null {
  try {
    const raw = parseYaml(content) as Record<string, unknown>;
    if (!raw || !raw.slug || !raw.name) return null;

    // Filter: FFF only
    if (raw.class !== "FFF") return null;

    const brandSlug = (raw.brand as Record<string, unknown>)?.slug as string || "";
    const brand = brandMap.get(brandSlug);
    const props = (raw.properties || {}) as Record<string, unknown>;
    const primaryColor = raw.primary_color as Record<string, unknown> | undefined;
    const photos = raw.photos as Array<Record<string, unknown>> | undefined;

    const score = computeCompletenessScore(raw);

    return {
      slug: raw.slug as string,
      uuid: (raw.uuid as string) || "",
      brandSlug,
      brandName: brand?.name || brandSlug,
      name: raw.name as string,
      type: (raw.type as string) || "Unknown",
      abbreviation: (raw.abbreviation as string) || (raw.type as string) || "",
      color: rgbaToHex(primaryColor?.color_rgba as string | undefined),
      density: (props.density as number) ?? null,
      nozzleTempMin: (props.min_print_temperature as number) ?? null,
      nozzleTempMax: (props.max_print_temperature as number) ?? null,
      bedTempMin: (props.min_bed_temperature as number) ?? null,
      bedTempMax: (props.max_bed_temperature as number) ?? null,
      chamberTemp: (props.chamber_temperature as number) ?? null,
      preheatTemp: (props.preheat_temperature as number) ?? null,
      dryingTemp: (props.drying_temperature as number) ?? null,
      dryingTime: (props.drying_time as number) ?? null,
      hardnessShoreD: (props.hardness_shore_d as number) ?? null,
      transmissionDistance: (raw.transmission_distance as number) ?? null,
      tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
      photoUrl:
        photos && photos.length > 0
          ? (photos[0].url as string) || null
          : null,
      productUrl: (raw.url as string) || null,
      completenessScore: score,
      completenessTier: completenessTier(score),
    };
  } catch {
    return null;
  }
}

// ── Map OPTMaterial to Filament DB creation payload ────────────────────

/**
 * Map an OpenPrintTag material to a Filament DB creation payload.
 * The result can be passed directly to `Filament.create()`.
 */
export function mapToFilamentPayload(
  m: OPTMaterial,
): Record<string, unknown> {
  // Map tag strings to OPT_TAG enum values
  const optTags: number[] = [];
  for (const tag of m.tags) {
    const enumKey = TAG_STRING_TO_OPT[tag];
    if (enumKey && enumKey in OPT_TAG) {
      optTags.push(OPT_TAG[enumKey]);
    }
  }

  return {
    name: `${m.brandName} ${m.name}`,
    vendor: m.brandName,
    type: m.type,
    color: m.color || "#808080",
    density: m.density,
    diameter: 1.75,
    temperatures: {
      nozzle: m.nozzleTempMax,
      nozzleFirstLayer: null,
      nozzleRangeMin: m.nozzleTempMin,
      nozzleRangeMax: m.nozzleTempMax,
      bed: m.bedTempMax,
      bedFirstLayer: null,
      standby: m.preheatTemp,
    },
    dryingTemperature: m.dryingTemp,
    dryingTime: m.dryingTime,
    shoreHardnessD: m.hardnessShoreD,
    transmissionDistance: m.transmissionDistance,
    optTags,
    settings: {
      openprinttag_uuid: m.uuid,
      openprinttag_slug: m.slug,
    },
  };
}

// ── Tarball fetching and extraction ────────────────────────────────────

/**
 * Walk a directory recursively, yielding file paths.
 */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Fetch the OpenPrintTag database from GitHub, parse all YAML files,
 * and return the structured result.
 */
export async function fetchOpenPrintTagDatabase(): Promise<OPTDatabase> {
  // Check cache
  if (cachedDatabase && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedDatabase;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "openprinttag-"));

  try {
    // Download tarball via GitHub API
    const tarballUrl =
      "https://api.github.com/repos/OpenPrintTag/openprinttag-database/tarball/main";

    execSync(
      `curl -sL -H "Accept: application/vnd.github+json" "${tarballUrl}" | tar xz -C "${tmpDir}"`,
      { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 },
    );

    // The tarball extracts to a subdirectory like OpenPrintTag-openprinttag-database-<sha>/
    const extracted = readdirSync(tmpDir);
    if (extracted.length === 0) throw new Error("Tarball extraction produced no files");
    const repoRoot = join(tmpDir, extracted[0]);

    // Parse brands
    const brandMap = new Map<string, { name: string; country?: string }>();
    const brandsDir = join(repoRoot, "data", "brands");
    try {
      for (const file of readdirSync(brandsDir)) {
        if (!file.endsWith(".yaml")) continue;
        const content = readFileSync(join(brandsDir, file), "utf-8");
        const brand = parseBrandYaml(content);
        if (brand) brandMap.set(brand.slug, { name: brand.name, country: brand.country });
      }
    } catch {
      // brands dir may not exist in some edge cases
    }

    // Parse materials
    const materials: OPTMaterial[] = [];
    let totalSLA = 0;
    const materialsDir = join(repoRoot, "data", "materials");
    const allFiles = walkDir(materialsDir);

    for (const filePath of allFiles) {
      if (!filePath.endsWith(".yaml")) continue;
      try {
        const content = readFileSync(filePath, "utf-8");
        const raw = parseYaml(content) as Record<string, unknown>;
        if (!raw || !raw.class) continue;

        if (raw.class === "SLA") {
          totalSLA++;
          continue;
        }

        const material = parseMaterialYaml(content, brandMap);
        if (material) materials.push(material);
      } catch {
        // Skip unparseable files
      }
    }

    // Build brand list with counts
    const brandCounts = new Map<string, number>();
    for (const m of materials) {
      brandCounts.set(m.brandSlug, (brandCounts.get(m.brandSlug) || 0) + 1);
    }

    const brands: OPTBrand[] = [];
    for (const [slug, count] of brandCounts) {
      const info = brandMap.get(slug);
      brands.push({
        slug,
        name: info?.name || slug,
        country: info?.country,
        materialCount: count,
      });
    }
    brands.sort((a, b) => a.name.localeCompare(b.name));

    const result: OPTDatabase = {
      brands,
      materials,
      cachedAt: new Date().toISOString(),
      totalFFF: materials.length,
      totalSLA,
    };

    // Cache
    cachedDatabase = result;
    cacheTimestamp = Date.now();

    return result;
  } finally {
    // Clean up temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

// ── Module-level cache ─────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedDatabase: OPTDatabase | null = null;
let cacheTimestamp = 0;

/**
 * Clear the cached database (useful for forcing a refresh).
 */
export function clearCache(): void {
  cachedDatabase = null;
  cacheTimestamp = 0;
}

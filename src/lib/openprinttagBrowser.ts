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
import { mkdtempSync, rmSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import { OPT_TAG } from "@/lib/openprinttag";

/**
 * Build an undici dispatcher that honours `HTTP_PROXY` / `HTTPS_PROXY` /
 * `NO_PROXY` env vars when the deployment sets them.
 *
 * Background: the previous `curl -L` shell call automatically respected
 * those variables, but Node's built-in fetch ignores them by default
 * (you'd otherwise need `NODE_USE_ENV_PROXY=1` or `--use-env-proxy`).
 * On the corporate / air-gapped Docker setups that motivated #136, that
 * regression would silently break OpenPrintTag refresh even though the
 * curl path used to work. Returning a dispatcher only when a proxy is
 * actually configured keeps the no-proxy fast path identical.
 */
export function getProxyDispatcher(
  env: Partial<Record<string, string | undefined>> = process.env,
): Dispatcher | undefined {
  const hasProxy = Boolean(
    env.HTTP_PROXY ||
      env.http_proxy ||
      env.HTTPS_PROXY ||
      env.https_proxy ||
      env.ALL_PROXY ||
      env.all_proxy,
  );
  return hasProxy ? new EnvHttpProxyAgent() : undefined;
}

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
  /** GH #477: secondary color hexes from OpenPrintTag spec keys 20–24
   *  (`secondary_color_0..4`). Empty array when the material has no
   *  secondary colors. Up to 5 entries. */
  secondaryColors: string[];
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
  // GH #604: real-world OPT YAMLs use `gradual_color_change` for the
  // gradient arrangement. Without this alias the parser drops the tag,
  // optTags doesn't get OPT_TAG.GRADIENT (27), and `deriveArrangement`
  // returns "solid" — so the imported filament renders as a flat
  // single-color swatch instead of a gradient even when its
  // secondary_colors list is fully populated.
  gradual_color_change: "GRADIENT",
  dual_color: "DUAL_COLOR",
  triple_color: "TRIPLE_COLOR",
  // GH #604: the same canonical-vs-real-world divergence as gradient
  // applies to the coextruded arrangement — the spec docs use
  // `dual_color`/`triple_color` but real OPT YAMLs use the more
  // descriptive `coextruded` tag. Map it to DUAL_COLOR by default;
  // `deriveArrangement` collapses both DUAL/TRIPLE into "coextruded"
  // anyway, so the slot count is already implicit in secondaryColors.
  coextruded: "DUAL_COLOR",
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
  industrially_compostable: "BIODEGRADABLE",
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
  // GH #632: require a real hex charset, not just the right length —
  // "zzzzzzzz" used to slip through as "#zzzzzz" and persist an invalid
  // color on the OPT import's update path (which skipped validators).
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return null;
  return `#${hex.slice(0, 6)}`;
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
  content: string | Record<string, unknown>,
  brandMap: Map<string, { name: string; country?: string }>,
): OPTMaterial | null {
  try {
    const raw = (typeof content === "string" ? parseYaml(content) : content) as Record<string, unknown>;
    if (!raw || !raw.slug || !raw.name) return null;

    // Filter: FFF only
    if (raw.class !== "FFF") return null;

    const brandSlug = (raw.brand as Record<string, unknown>)?.slug as string || "";
    const brand = brandMap.get(brandSlug);
    const props = (raw.properties || {}) as Record<string, unknown>;
    const primaryColor = raw.primary_color as Record<string, unknown> | undefined;
    // GH #477 / GH #604: secondary colors can arrive in two shapes.
    //
    //   1. Modern OPT db (real-world data, e.g. amolen-*-multicolor-* YAMLs):
    //      a flat list under `secondary_colors:` (plural), each entry
    //      `{ color_rgba: "RRGGBBAA" }`.
    //   2. Spec-aligned keyed slots `secondary_color_0..4:` (singular),
    //      each entry `{ color_rgba: "RRGGBBAA" }`. Spec keys 20–24.
    //
    // The pre-#604 parser only read shape (2), so every multi-color
    // OPT-imported filament came in with secondaryColors = [], the
    // primary fell back to "#808080", and the filament rendered as a
    // single grey swatch with no arrangement.
    //
    // Read shape (1) first because that's what the actual OPT database
    // emits; fall through to (2) so we stay forward-compatible if a
    // future schema cleanup keys the slots individually. In either case
    // rgbaToHex drops the alpha byte (we model RGB only) and we cap at
    // 5 entries to match the spec.
    const secondaryColors: string[] = [];
    const SECONDARY_CAP = 5;
    const secondaryList = raw.secondary_colors;
    if (Array.isArray(secondaryList)) {
      for (const entry of secondaryList.slice(0, SECONDARY_CAP)) {
        const hex = rgbaToHex(
          (entry as Record<string, unknown> | null | undefined)?.color_rgba as
            | string
            | undefined,
        );
        if (hex) secondaryColors.push(hex);
      }
    }
    if (secondaryColors.length === 0) {
      const SECONDARY_KEYS = [
        "secondary_color_0",
        "secondary_color_1",
        "secondary_color_2",
        "secondary_color_3",
        "secondary_color_4",
      ];
      for (const key of SECONDARY_KEYS) {
        const slot = raw[key] as Record<string, unknown> | undefined;
        const hex = rgbaToHex(slot?.color_rgba as string | undefined);
        if (hex) secondaryColors.push(hex);
      }
    }
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
      secondaryColors,
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
      optTags.push(OPT_TAG[enumKey as keyof typeof OPT_TAG]);
    }
  }

  return {
    name: `${m.brandName} ${m.name}`,
    vendor: m.brandName,
    type: m.type,
    // GH #477 (Codex P2 on PR #484): preserve null primary when the
    // material has secondary colors but no primary. The OPT spec says
    // coextruded / rainbow materials have null primary; the old `||
    // "#808080"` fallback would inject a phantom gray as the first
    // "color" in the swatch's allColors() list and re-export with a
    // gray slot that wasn't in the source. Only fall back to gray
    // when there are NO colors at all (single-color material with
    // missing primary — preserves the previous behaviour for the
    // common case).
    color: m.color || (m.secondaryColors.length > 0 ? null : "#808080"),
    // Pass through secondary colors so a coextruded / multi-color
    // material in the OPT database imports with all slots populated.
    secondaryColors: m.secondaryColors,
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
 *
 * #743: async (fs/promises) rather than readdirSync/statSync so the recursive
 * walk over the OpenPrintTag tree (~11k material files) doesn't block the
 * embedded server's single event loop on a cold parse.
 */
async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkDir(full)));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Fetch the OpenPrintTag database from GitHub, parse all YAML files,
 * and return the structured result.
 *
 * GH #225 — cold-fetch resilience:
 * - The fetch+extract pipeline is wrapped in a retry loop (3 attempts,
 *   exponential backoff) so a transient TimeoutError or network blip on
 *   the first request after Electron startup doesn't surface to the user
 *   as a 500. Most "OpenPrintTag fetch error: TimeoutError" reports trace
 *   to a cold connection that resolves on retry.
 * - If every retry fails BUT we have a previously-cached payload (even an
 *   expired one), serve the stale payload instead of throwing. The
 *   freshness window is wide enough that users prefer a one-hour-old
 *   brand list to "Failed to load."
 */
export async function fetchOpenPrintTagDatabase(): Promise<OPTDatabase> {
  // Check cache
  if (cachedDatabase && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedDatabase;
  }

  // #743: single-flight. On a fresh install the cache is empty, and the page
  // auto-fetches on mount — a reload / re-navigation / second tab would each
  // otherwise kick off an independent GitHub download + tar extract + ~11k-file
  // parse, piling up on the one embedded-server event loop and compounding the
  // freeze. Share ONE in-progress load; clear it in `finally` (success OR
  // failure) so a failed cold load doesn't leave a rejected promise that every
  // later caller awaits forever.
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = runFetchWithRetries();
  try {
    return await inFlightFetch;
  } finally {
    inFlightFetch = null;
  }
}

async function runFetchWithRetries(): Promise<OPTDatabase> {
  const MAX_ATTEMPTS = 3;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tmpDir = mkdtempSync(join(tmpdir(), "openprinttag-"));

    try {
      const result = await fetchAndParse(tmpDir);
      return result;
    } catch (err) {
      lastError = err;
      // Clean up the tmp dir from the failed attempt before retrying so
      // disk usage doesn't grow on a flaky network.
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      if (attempt < MAX_ATTEMPTS) {
        // Exponential backoff: 800ms, 2400ms. Total worst-case wait
        // ~3.2s extra over the base 60s per attempt — still well under
        // the user's tolerance for a one-time DB browser cold-load.
        await new Promise((r) => setTimeout(r, 800 * Math.pow(3, attempt - 1)));
      }
    }
  }

  // All retries failed. If we have a previously-cached payload (even
  // if it's past the TTL), serve it — better than failing the UI.
  if (cachedDatabase) {
    console.warn(
      "OpenPrintTag fetch failed after retries — serving stale cache from",
      new Date(cacheTimestamp).toISOString(),
    );
    return cachedDatabase;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("OpenPrintTag fetch failed: " + String(lastError));
}

/**
 * Single-attempt fetch + tarball extract + parse. Factored out so the
 * retry loop above can call it multiple times against fresh temp dirs.
 */
async function fetchAndParse(tmpDir: string): Promise<OPTDatabase> {
  try {
    // Download and extract the tarball via the GitHub tarball API. Earlier
    // versions shelled out to `curl ... | tar xz`, but the production
    // Docker image (node:22-alpine) doesn't ship curl, so users got
    // "/bin/sh: curl: not found" the moment they tried to browse the OPT
    // database (GH #136). Doing it in pure Node removes the dep on host
    // tools and works the same in dev, Electron, and Docker.
    const tarballUrl =
      "https://api.github.com/repos/OpenPrintTag/openprinttag-database/tarball/main";

    // Pass the proxy dispatcher when one is configured. `dispatcher` is an
    // undici-flavoured option not present on the standard RequestInit type,
    // hence the cast — it's a documented Node fetch extension.
    const dispatcher = getProxyDispatcher();
    const response = await fetch(tarballUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub returns 403 on unauthenticated requests with no UA.
        "User-Agent": "filament-db",
      },
      // 60s matches the previous execSync timeout. AbortSignal.timeout
      // produces a TypeError-shaped abort if exceeded.
      signal: AbortSignal.timeout(60_000),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: Dispatcher });
    if (!response.ok) {
      throw new Error(
        `GitHub tarball request failed: ${response.status} ${response.statusText}`,
      );
    }
    if (!response.body) {
      throw new Error("GitHub tarball response had no body");
    }

    // tar.x is a Writable transform that auto-detects gzip; pipeline()
    // resolves once the entire tarball has been extracted to disk.
    //
    // GH #258: bound the extraction so a hostile/compromised tarball
    // (tar bomb) can't fill the disk. The `filter` runs per entry with
    // the header-declared size, so a single entry claiming a huge size
    // — or a flood of small entries — trips the limit before the data
    // is written. It also rejects absolute paths and `..` traversal as
    // defence-in-depth over tar's own path sanitisation.
    const MAX_TARBALL_EXTRACT_BYTES = 256 * 1024 * 1024;
    const MAX_TARBALL_FILES = 50_000;
    let extractedBytes = 0;
    let fileCount = 0;
    await pipeline(
      // Cast: response.body is a Web ReadableStream, Readable.fromWeb wants
      // the same shape but the type lib for streams/web is a bit loose
      // across Node versions. Functionally identical.
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      tar.x({
        cwd: tmpDir,
        filter: (entryPath: string, entry: { size?: number }) => {
          if (
            entryPath.startsWith("/") ||
            entryPath.split(/[\\/]/).includes("..")
          ) {
            throw new Error(`Unsafe tarball entry path: ${entryPath}`);
          }
          fileCount += 1;
          extractedBytes += entry.size ?? 0;
          if (
            fileCount > MAX_TARBALL_FILES ||
            extractedBytes > MAX_TARBALL_EXTRACT_BYTES
          ) {
            throw new Error(
              "OpenPrintTag tarball exceeds extraction limits (possible tar bomb).",
            );
          }
          return true;
        },
      }),
    );

    // The tarball extracts to a subdirectory like OpenPrintTag-openprinttag-database-<sha>/
    const extracted = await readdir(tmpDir);
    if (extracted.length === 0) throw new Error("Tarball extraction produced no files");
    const repoRoot = join(tmpDir, extracted[0]);

    // Parse brands
    const brandMap = new Map<string, { name: string; country?: string }>();
    const brandsDir = join(repoRoot, "data", "brands");
    try {
      for (const file of await readdir(brandsDir)) {
        if (!file.endsWith(".yaml")) continue;
        const content = await readFile(join(brandsDir, file), "utf-8");
        const brand = parseBrandYaml(content);
        if (brand) brandMap.set(brand.slug, { name: brand.name, country: brand.country });
      }
    } catch {
      // brands dir may not exist in some edge cases
    }

    // Parse materials. #743: async file reads + a periodic event-loop yield so
    // this ~11k-file parse doesn't block the embedded server's single event
    // loop (which would freeze the WHOLE app — every other tab/route — on a
    // cold fetch, the reported symptom). parseYaml itself is synchronous, so we
    // also yield via setImmediate every YIELD_EVERY files to break up CPU bursts.
    const materials: OPTMaterial[] = [];
    let totalSLA = 0;
    const materialsDir = join(repoRoot, "data", "materials");
    const allFiles = await walkDir(materialsDir);

    const YIELD_EVERY = 256;
    let seen = 0;
    for (const filePath of allFiles) {
      if (!filePath.endsWith(".yaml")) continue;
      if (++seen % YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      try {
        const content = await readFile(filePath, "utf-8");
        const raw = parseYaml(content) as Record<string, unknown>;
        if (!raw || !raw.class) continue;

        if (raw.class === "SLA") {
          totalSLA++;
          continue;
        }

        const material = parseMaterialYaml(raw, brandMap);
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
// #743: in-progress fetch shared by concurrent callers (single-flight).
let inFlightFetch: Promise<OPTDatabase> | null = null;

/**
 * Clear the cached database (useful for forcing a refresh).
 *
 * #743 (Codex P1): clears ONLY the cached result — NOT `inFlightFetch`. The
 * refresh-POST path calls this and then re-fetches; if a cold load is still
 * running, forgetting (not cancelling) the in-flight promise would let the
 * refetch start a SECOND download+parse instead of joining the running one,
 * and the older load's `finally` could later clobber the newer in-flight/cache
 * state — reintroducing the duplicate cold parses this fix prevents. Leaving
 * `inFlightFetch` intact means a refresh joins any in-progress load (which is
 * itself a fresh download), or starts a clean one when none is running.
 */
export function clearCache(): void {
  cachedDatabase = null;
  cacheTimestamp = 0;
}

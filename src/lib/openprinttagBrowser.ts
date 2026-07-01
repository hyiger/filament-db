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
import { mkdtempSync } from "fs";
import { readFile, readdir, rm, stat } from "fs/promises";
import { basename, join } from "path";
import { tmpdir } from "os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as tar from "tar";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import { OPT_TAG } from "@/lib/openprinttag";
import { readBodyCapped } from "@/lib/externalUrlGuard";

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
  /** #931: SHA of the upstream `main` commit the cached data was parsed from.
   *  Stamped by `extractAndParse` from the tarball directory name (the GitHub
   *  tarball API extracts to `<owner>-<repo>-<sha>/`), or set after a
   *  successful commits-API probe. Optional because pre-#931 caches won't
   *  carry it on first load. */
  sha?: string;
  /** #931: ISO timestamp of the most recent commits-API probe (independent
   *  of `cachedAt`, which records the last tarball parse). When the probe
   *  finds the same SHA we serve cached data but update this. */
  shaCheckedAt?: string;
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

// Prefix on every diagnostic line so the OPT fetch flow is greppable in the
// packaged app's main.log (electron/main.ts mirrors the embedded server's
// stdout/stderr to %APPDATA%/Filament DB/logs/main.log).
const LOG = "[openprinttag]";

// All temp dirs this module creates share this prefix; the stale-dir sweep
// keys off it to reclaim partial copies left by an earlier interrupted run.
const TMP_PREFIX = "openprinttag-";

/**
 * Remove a temp dir robustly. Uses async `rm` (yields the event loop instead
 * of blocking it on a ~11k-file recursive delete — the reported "hang") with
 * Node's built-in retry, which backs off on the Windows file-lock errors
 * (EBUSY/EPERM/ENOTEMPTY) that antivirus / lingering handles trigger and that
 * a plain `force: true` does NOT retry — the cause of the partial leftovers.
 * Best-effort: logs the failure rather than throwing (cleanup must not mask
 * the real result), but does NOT swallow it silently.
 */
async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch (err) {
    console.warn(
      `${LOG} cleanup failed for ${dir} — may leave a partial copy:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Best-effort sweep of stale `openprinttag-*` temp dirs from earlier runs that
 * failed to clean up (e.g. an interrupted extract on Windows). Only removes
 * dirs older than STALE_AGE_MS so it can't race a concurrent in-progress fetch
 * (another tab/instance sharing %TEMP%). Never throws.
 */
async function sweepStaleTempDirs(): Promise<void> {
  const STALE_AGE_MS = 60 * 60 * 1000; // 1 hour
  const root = tmpdir();
  let reclaimed = 0;
  try {
    for (const name of await readdir(root)) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const full = join(root, name);
      try {
        const info = await stat(full);
        if (!info.isDirectory()) continue;
        if (Date.now() - info.mtimeMs < STALE_AGE_MS) continue;
        await rm(full, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
        reclaimed += 1;
      } catch {
        // per-entry best-effort — a locked dir is reclaimed on a later sweep
      }
    }
  } catch (err) {
    console.warn(
      `${LOG} stale temp-dir sweep failed:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }
  if (reclaimed > 0) {
    console.log(`${LOG} swept ${reclaimed} stale temp dir(s) from ${root}`);
  }
}

/**
 * Fetch the OpenPrintTag database from GitHub, parse all YAML files,
 * and return the structured result.
 *
 * GH #225 — cold-fetch resilience:
 * - Only the DOWNLOAD is retried (3 attempts, exponential backoff): a
 *   transient TimeoutError or network blip on the first request after
 *   Electron startup is the thing that actually resolves on retry. Most
 *   "OpenPrintTag fetch error: TimeoutError" reports trace to a cold
 *   connection. The extract/parse is deterministic — a retry won't fix a
 *   slow disk — so once the bytes are in hand it runs ONCE under its own
 *   generous deadline (PR #933 review: retrying the extract multiplied the
 *   worst-case wait past the client's timeout, so a cached user never
 *   reached the stale-cache fallback below).
 * - If the download (after retries) or the single extract/parse fails BUT
 *   we have a previously-cached payload (even an expired one), serve the
 *   stale payload instead of throwing. The freshness window is wide enough
 *   that users prefer a one-hour-old brand list to "Failed to load."
 */
export async function fetchOpenPrintTagDatabase(
  opts?: { force?: boolean },
): Promise<OPTDatabase> {
  const force = opts?.force === true;

  // Cache hit on the natural fast path (TTL not expired, not a forced refresh).
  // The SHA-aware probe below intentionally does NOT run here — when the TTL
  // is fresh the user just saw current data, no point hitting GitHub.
  if (!force && cachedDatabase && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedDatabase;
  }

  // #743 + #931 + PR #937 review (hyiger P2/P3): single-flight EVERYTHING
  // beyond the fast-path check — the SHA probe AND the tarball fetch.
  //
  // Pre-review the probe ran BEFORE the single-flight guard, so N concurrent
  // forced refreshes each fired their own commits-API request. With the
  // unauthenticated GitHub quota at 60 req/hr, a user mashing Refresh across
  // tabs could burn the quota fast; the 403/Retry-After path then 502s the UI
  // back for an hour. Wrapping the probe alongside the tarball fetch in one
  // in-flight promise makes concurrent forced refreshes share ONE probe result
  // AND ONE tarball-fetch decision.
  //
  // It also closes the slide-TTL race: pre-review two forced-refresh callers
  // could overlap on `await fetchUpstreamCommitSha()`, then caller A's
  // "unchanged" spread would overwrite caller B's newer `cachedDatabase` with
  // a stale sha (spread captures B's new content but re-stamps A's old sha).
  // Inside the single-flight guard only ONE caller runs `probeAndFetch` at a
  // time, so no interleaving is possible.
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = probeAndFetch();
  try {
    return await inFlightFetch;
  } finally {
    inFlightFetch = null;
  }
}

/**
 * #931 + PR #937 review: probe + decide + tarball. Runs INSIDE the single-flight
 * guard, so concurrent forced refreshes share ONE probe call and ONE tarball
 * fetch. Only invoked by `fetchOpenPrintTagDatabase` — not part of the public
 * surface.
 */
async function probeAndFetch(): Promise<OPTDatabase> {
  // Capture the baseline BEFORE the probe so the spread below merges from a
  // known snapshot even if a `clearCache` slips in between (single-flight
  // guarantees no other `probeAndFetch` runs concurrently, but the module
  // state is still mutable from test setup).
  const baseline = cachedDatabase;
  const baselineSha = baseline?.sha;
  if (baseline && baselineSha) {
    const upstreamSha = await fetchUpstreamCommitSha();
    if (upstreamSha === null) {
      // Probe failed — fall through to the tarball path (fail-open). A
      // commits-API hiccup must not wedge the refresh flow that was already
      // willing to download the whole tarball anyway.
      console.warn(`${LOG} commits probe failed — falling through to tarball`);
    } else if (shasMatch(upstreamSha, baselineSha)) {
      // Upstream unchanged. Slide the TTL and stamp the probe time so the UI
      // can show "checked Xm ago". `cachedAt` is untouched (it records the
      // last actual parse).
      console.log(
        `${LOG} commits SHA unchanged (${upstreamSha.slice(0, 7)}) — sliding TTL`,
      );
      cacheTimestamp = Date.now();
      // Stamp the FULL upstream SHA so subsequent compares don't keep losing
      // precision via the abbreviated tarball-dir SHA.
      cachedDatabase = {
        ...baseline,
        sha: upstreamSha,
        shaCheckedAt: new Date().toISOString(),
      };
      return cachedDatabase;
    } else {
      console.log(
        `${LOG} commits SHA changed ${baselineSha.slice(0, 7)} → ${upstreamSha.slice(0, 7)} — fetching tarball`,
      );
    }
  }

  return await runFetchWithRetries();
}

/**
 * #931: minimum SHA prefix length that we're willing to trust for equality.
 *
 * The tarball regex emits `[0-9a-f]{7,40}` and GitHub's commits API returns a
 * full 40-char SHA — so 7 is the smallest length either source produces. Any
 * value shorter than that arriving in `shasMatch` (or the commits-API JSON)
 * is a malformed / truncated response, and letting a shorter prefix match
 * would silently open us up to a hostile / broken proxy locking the cache
 * on a low-entropy prefix: at 4 chars the random collision rate is 1/65k,
 * at 7 chars it's 1/268M. Post PR #937 review (hyiger P1). Kept as an
 * exported constant so `fetchUpstreamCommitSha`'s length guard can't drift
 * from `shasMatch`'s floor.
 */
export const MIN_SHA_PREFIX_LEN = 7;

/**
 * #931: Case-insensitive prefix-compatible SHA equality.
 *
 * The cached SHA might be an abbreviated 7-char value extracted from the
 * tarball directory name (`<owner>-<repo>-<sha>/`) on first parse, while the
 * commits API always returns the full 40-char SHA. Plain `===` would mis-
 * report "changed" every time after a first cold load. We compare by the
 * shorter of the two lengths so a 7-char cached SHA matches its 40-char
 * upstream counterpart. Once a probe finds a match we re-stamp the cache with
 * the full SHA so subsequent compares are exact.
 *
 * A bare-prefix compare is safe here because GitHub's tarball-directory SHA
 * abbreviation is itself derived from the same commit — there's no third-
 * party-controlled value being prefix-matched. (Git's own short-SHA collision
 * risk is irrelevant: we're comparing the SAME repo's hashes, not searching
 * for a commit by prefix.) But we still refuse anything shorter than
 * `MIN_SHA_PREFIX_LEN` so a malformed / hostile / truncated value can't
 * lock the cache on a low-entropy prefix.
 */
export function shasMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const minLen = Math.min(a.length, b.length);
  if (minLen < MIN_SHA_PREFIX_LEN) return false;
  return a.slice(0, minLen).toLowerCase() === b.slice(0, minLen).toLowerCase();
}

/**
 * #931: Cheap "did upstream change?" probe. Hits GitHub's commits API for the
 * latest commit on `main` and returns just the SHA — no file list, no author
 * blob, no `parents` array. Returns the full SHA on success, `null` on any
 * failure; every caller fail-opens to the tarball path on null, so this
 * never wedges a refresh — the probe is pure latency savings.
 *
 * Honours the same proxy dispatcher as `downloadTarballToBuffer` so air-gapped
 * / proxied deployments work the same as the tarball path.
 *
 * Response shape (Codex P2 on PR #937): asks for `application/vnd.github.sha`
 * — the docs-supported media type that makes GitHub return the SHA as
 * text/plain (a bare 40-char string), NOT the full JSON commit blob. Pre-fix
 * the default JSON shape included the commit's changed-file list and could
 * exceed the read cap when the latest upstream commit touched many files,
 * killing the probe on exactly the "big refactor merged" days where the
 * probe path was most valuable. The SHA media type is fixed-size regardless
 * of commit content.
 *
 * Response-size cap (PR #937 review, hyiger P2): body is read via
 * `readBodyCapped` at 4 KB. The SHA-only response is ~40 bytes; 4 KB
 * accommodates any error-body GitHub might still stuff into the response
 * without permitting an OOM from a hostile / misconfigured proxy.
 *
 * Timeout (PR #937 review, hyiger P3): 5s default (was 10s). A 40-byte API
 * call that takes longer than 5s means the connection is dead — fail fast
 * and let the tarball path's existing retry backoff cover it. The full retry
 * budget comment near `runFetchWithRetries` bounds the worst-case wait; a
 * 10s probe eroded ~5s of that budget on a bad-network path.
 */
export async function fetchUpstreamCommitSha(opts?: {
  timeoutMs?: number;
}): Promise<string | null> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const commitsUrl =
    "https://api.github.com/repos/OpenPrintTag/openprinttag-database/commits/main";
  const dispatcher = getProxyDispatcher();
  try {
    const response = await fetch(commitsUrl, {
      headers: {
        // Codex P2 on PR #937: text/plain SHA rather than the full JSON
        // commit blob, so the response is fixed-size and can't blow the
        // read cap on a large commit's file list.
        Accept: "application/vnd.github.sha",
        "User-Agent": "filament-db",
      },
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: Dispatcher });
    if (!response.ok) {
      console.warn(
        `${LOG} commits API returned ${response.status} ${response.statusText}`,
      );
      return null;
    }
    // Cap the body BEFORE reading so a hostile proxy can't OOM the embedded
    // server. `readBodyCapped` throws when the cap is hit; the outer catch
    // treats that as a probe failure and fail-opens to the tarball path.
    // 4 KB is enormous for a 40-char SHA but leaves room for any error-body
    // GitHub might still send with a 2xx (unlikely; belt and suspenders).
    const rawBody = await readBodyCapped(response, 4 * 1024);
    // The SHA media type returns raw text — trim in case of a trailing
    // newline. Reject a shorter-than-`MIN_SHA_PREFIX_LEN` value so a
    // degenerate / hostile response can't lock the cache on a low-entropy
    // prefix (PR #937 review, hyiger P1). Length is checked against the same
    // constant `shasMatch` uses, so the two guards can never drift.
    const sha = rawBody.toString("utf-8").trim();
    if (sha.length < MIN_SHA_PREFIX_LEN) {
      console.warn(`${LOG} commits API response had no usable sha`);
      return null;
    }
    return sha;
  } catch (err) {
    console.warn(
      `${LOG} commits API request failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function runFetchWithRetries(): Promise<OPTDatabase> {
  // Reclaim any partial copies an earlier interrupted run left behind before
  // we start adding more.
  await sweepStaleTempDirs();

  try {
    // Retry ONLY the network download — that's the transient part (cold
    // connection / blip). Once the bytes are in hand, extract + parse runs
    // ONCE: it's deterministic, so a retry wouldn't fix a slow disk, and
    // retrying it would multiply the worst-case wait past the client's
    // timeout (PR #933 review) — at which point a cached user never reaches
    // the stale-cache fallback this path exists to serve.
    const tarballBuffer = await downloadWithRetries();
    return await extractParseOnce(tarballBuffer);
  } catch (err) {
    // The download (after retries) or the single extract/parse failed. If we
    // have a previously-cached payload (even past the TTL), serve it — better
    // than failing the UI.
    if (cachedDatabase) {
      console.warn(
        `${LOG} fetch failed — serving stale cache from`,
        new Date(cacheTimestamp).toISOString(),
        err instanceof Error ? err.message : err,
      );
      return cachedDatabase;
    }
    throw err instanceof Error
      ? err
      : new Error("OpenPrintTag fetch failed: " + String(err));
  }
}

// Budget math (kept in lockstep with the client abort in
// src/app/openprinttag/page.tsx). The download is network-bound and fast (the
// compressed tarball is ~3 MB), so it gets a tight deadline and is retried for
// transient blips. The extract writes ~11k tiny YAML files to disk — and on
// Windows hosts real-time antivirus (Defender) scans every one of those
// writes, which can push a cold extract past a minute even when the download
// itself took 600ms — so it gets a separate, more generous deadline but runs
// only once. Worst case: MAX_ATTEMPTS × DOWNLOAD_TIMEOUT_MS + backoff(3.2s) +
// EXTRACT_TIMEOUT_MS = 3×45 + 3.2 + 120 ≈ 258s, comfortably under the client's
// 300s (5 min) abort.
//
// Strictly: EXTRACT_TIMEOUT_MS bounds the gunzip→counter→tar.x PIPELINE only.
// `clearTimeout(extractTimer)` fires right after the pipeline resolves, so the
// YAML parse loop that follows has NO deadline. That's fine in practice —
// parse is CPU-bound, yields to the event loop every 256 files, and runs once
// per cold load — but a pathologically slow parse can still eat into the ~42s
// margin between the 258s server window and the 300s client abort. If parse
// ever takes long enough to matter, give it its own per-file or whole-loop
// budget rather than widening EXTRACT_TIMEOUT_MS, which only governs unpack.
const MAX_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const EXTRACT_TIMEOUT_MS = 120_000;
// Cap the compressed download we buffer into memory before extracting, so a
// hostile/huge response can't OOM the embedded server. The real OpenPrintTag
// tarball is ~3 MB; 128 MB is generous headroom. (The decompressed-size /
// file-count tar-bomb guard still runs during extraction below.)
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
// Cap the DECOMPRESSED stream during extract. A counting Transform between
// gunzip and tar.x trips this against bytes actually streamed (not the lyable
// header `size`). Injectable into extractAndParse so the trip can be unit-
// tested without allocating 256 MB; production uses the default.
const MAX_TARBALL_EXTRACT_BYTES = 256 * 1024 * 1024;
const MAX_TARBALL_FILES = 50_000;

/**
 * Retry the network download (exponential backoff) and return the compressed
 * tarball as an in-memory Buffer. Only the download is retried — see
 * runFetchWithRetries.
 */
async function downloadWithRetries(): Promise<Buffer> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`${LOG} download attempt ${attempt}/${MAX_ATTEMPTS} starting`);
    try {
      return await downloadTarballToBuffer();
    } catch (err) {
      lastError = err;
      console.error(
        `${LOG} download attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
        err instanceof Error ? err.message : err,
      );
      if (attempt < MAX_ATTEMPTS) {
        // Exponential backoff: 800ms, 2400ms (~3.2s total).
        await new Promise((r) => setTimeout(r, 800 * Math.pow(3, attempt - 1)));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("OpenPrintTag download failed: " + String(lastError));
}

/**
 * Fetch the GitHub tarball and buffer the full compressed body into memory.
 *
 * Buffering first decouples the extract phase from the network: previously the
 * response body streamed straight into tar.x, so the download signal stayed
 * armed across the whole disk-bound unpack and a slow Windows extract
 * (antivirus scanning each of ~11k file writes) aborted the still-open fetch
 * even though the bytes were already down. With the bytes fully in hand,
 * extraction runs under its own independent deadline and the network timeout
 * can no longer misfire mid-unpack.
 *
 * `maxBytes` / `timeoutMs` are injectable so the size cap and the
 * download-phase timeout relabel can be unit-tested without a 128 MB
 * allocation or a real 45s wait. Production uses the module defaults.
 */
export async function downloadTarballToBuffer(opts?: {
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const maxBytes = opts?.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const timeoutMs = opts?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;

  // Download the tarball via the GitHub tarball API. Earlier versions shelled
  // out to `curl ... | tar xz`, but the production Docker image
  // (node:22-alpine) doesn't ship curl, so users got "/bin/sh: curl: not
  // found" the moment they tried to browse the OPT database (GH #136). Doing
  // it in pure Node removes the dep on host tools and works the same in dev,
  // Electron, and Docker.
  const tarballUrl =
    "https://api.github.com/repos/OpenPrintTag/openprinttag-database/tarball/main";

  // Pass the proxy dispatcher when one is configured. `dispatcher` is an
  // undici-flavoured option not present on the standard RequestInit type,
  // hence the cast — it's a documented Node fetch extension.
  const dispatcher = getProxyDispatcher();
  const downloadStart = Date.now();
  console.log(`${LOG} download starting: ${tarballUrl}`);
  try {
    const response = await fetch(tarballUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub returns 403 on unauthenticated requests with no UA.
        "User-Agent": "filament-db",
      },
      // The download gets its OWN deadline (the extract that follows gets a
      // separate, more generous one). AbortSignal.timeout produces a
      // TimeoutError-shaped abort if exceeded.
      signal: AbortSignal.timeout(timeoutMs),
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

    let downloadedBytes = 0;
    // Readable.fromWeb can yield Uint8Array (the chunk type isn't always a
    // Node Buffer); Buffer.concat + .length accept it, so type honestly.
    const chunks: Uint8Array[] = [];
    for await (const chunk of Readable.fromWeb(
      response.body as Parameters<typeof Readable.fromWeb>[0],
    )) {
      downloadedBytes += chunk.length;
      // Check BEFORE push so the over-limit chunk is never retained.
      if (downloadedBytes > maxBytes) {
        throw new Error(
          "OpenPrintTag download exceeds size limit (possible malicious response).",
        );
      }
      chunks.push(chunk);
    }
    // Concat to a known total, then drop the per-chunk copies right away so the
    // ~3 MB (cap: maxBytes) of chunks isn't held GC-rooted through the entire
    // extract + ~11k-file parse — otherwise peak memory was ~2× the buffer.
    const tarballBuffer = Buffer.concat(chunks, downloadedBytes);
    chunks.length = 0;
    console.log(
      `${LOG} download response ${response.status}, ${downloadedBytes} bytes in ${Date.now() - downloadStart}ms`,
    );
    return tarballBuffer;
  } catch (err) {
    const relabeled = relabelTimeoutError(err, "download", { downloadTimeoutMs: timeoutMs });
    throw relabeled ?? err;
  }
}

/**
 * Extract the buffered tarball into `tmpDir`, parse all YAML, and clean up.
 * Runs once (no retry) — see runFetchWithRetries. Caches the result.
 */
async function extractParseOnce(tarballBuffer: Buffer): Promise<OPTDatabase> {
  const tmpDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  console.log(`${LOG} extract starting (tmpDir=${basename(tmpDir)})`);
  try {
    const result = await extractAndParse(tarballBuffer, tmpDir);
    console.log(
      `${LOG} succeeded — ${result.totalFFF} FFF / ${result.totalSLA} SLA materials`,
    );
    return result;
  } finally {
    // Clean up the temp directory. Async + retrying so it neither blocks the
    // event loop nor leaves a partial copy on a Windows file lock.
    await cleanupTempDir(tmpDir);
  }
}

export async function extractAndParse(
  tarballBuffer: Buffer,
  tmpDir: string,
  opts?: { maxExtractBytes?: number },
): Promise<OPTDatabase> {
  try {
    // GH #258: bound the extraction so a hostile/compromised tarball (tar
    // bomb) can't fill the disk. The `filter` rejects absolute paths / `..`
    // traversal (defence-in-depth over tar's own sanitisation) and caps the
    // file COUNT. A counting Transform between gunzip and the tar parser caps
    // the total DECOMPRESSED bytes against bytes actually streamed to disk —
    // not the attacker-declared header `size`, which a lying header could
    // under-report (PR #933 follow-up).
    //
    // The extract gets its OWN AbortController/timeout, independent of the
    // network deadline — a slow disk (Windows + antivirus) gets the full
    // EXTRACT_TIMEOUT_MS budget. Aborting the pipeline rejects with an
    // AbortError, which relabelTimeoutError recognises so the surfaced message
    // names the extract phase honestly.
    //
    // `maxExtractBytes` is injectable so the decompressed-size trip can be
    // unit-tested with a tiny cap — production uses MAX_TARBALL_EXTRACT_BYTES.
    const maxExtractBytes = opts?.maxExtractBytes ?? MAX_TARBALL_EXTRACT_BYTES;
    const extractStart = Date.now();
    let decompressedBytes = 0;
    let fileCount = 0;
    const extractController = new AbortController();
    const extractTimer = setTimeout(
      () => extractController.abort(),
      EXTRACT_TIMEOUT_MS,
    );
    const byteCounter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        decompressedBytes += chunk.length;
        if (decompressedBytes > maxExtractBytes) {
          cb(
            new Error(
              "OpenPrintTag tarball exceeds extraction limits (possible tar bomb).",
            ),
          );
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(
        // Wrap in an array so the whole buffer is emitted as ONE chunk —
        // `Readable.from(buffer)` is special-cased today but the array form is
        // unambiguous across Node versions (CI runs 20 + 22).
        Readable.from([tarballBuffer]),
        // Gunzip ourselves so the counter sees DECOMPRESSED bytes; tar.x then
        // parses raw (gzip:false) instead of detecting+decompressing again.
        createGunzip(),
        byteCounter,
        tar.x({
          cwd: tmpDir,
          gzip: false,
          filter: (entryPath: string) => {
            if (
              entryPath.startsWith("/") ||
              entryPath.split(/[\\/]/).includes("..")
            ) {
              throw new Error(`Unsafe tarball entry path: ${entryPath}`);
            }
            fileCount += 1;
            if (fileCount > MAX_TARBALL_FILES) {
              throw new Error(
                "OpenPrintTag tarball exceeds extraction limits (possible tar bomb).",
              );
            }
            return true;
          },
        }),
        { signal: extractController.signal },
      );
    } finally {
      clearTimeout(extractTimer);
    }

    console.log(
      `${LOG} extract done: ${fileCount} files / ${decompressedBytes} bytes in ${Date.now() - extractStart}ms`,
    );

    // The tarball extracts to a subdirectory like OpenPrintTag-openprinttag-database-<sha>/
    const extracted = await readdir(tmpDir);
    if (extracted.length === 0) throw new Error("Tarball extraction produced no files");
    const repoRoot = join(tmpDir, extracted[0]);
    // #931: pull the upstream commit SHA out of the directory name
    // (`<owner>-<repo>-<sha>/`) so the SHA-aware refresh probe has a baseline
    // to compare against later. GitHub's tarball API only emits the abbreviated
    // 7-char SHA in this path; we keep whatever it gives us. A missing/short
    // match still parses successfully — `sha` stays undefined and the SHA
    // probe falls through to a tarball fetch on first refresh.
    const shaMatch = /-([0-9a-f]{7,40})\/?$/i.exec(extracted[0]);
    const sha = shaMatch ? shaMatch[1] : undefined;

    // Parse brands
    const parseStart = Date.now();
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
    console.log(`${LOG} parsing ${allFiles.length} files under data/materials`);

    const YIELD_EVERY = 256;
    let seen = 0;
    for (const filePath of allFiles) {
      if (!filePath.endsWith(".yaml")) continue;
      if (++seen % YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        console.log(`${LOG} parse progress: ${seen}/${allFiles.length} files`);
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

    console.log(
      `${LOG} parse done: ${materials.length} FFF / ${totalSLA} SLA in ${Date.now() - parseStart}ms`,
    );

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
      sha,
      shaCheckedAt: new Date().toISOString(),
    };

    // Cache
    cachedDatabase = result;
    cacheTimestamp = Date.now();

    return result;
  } catch (err) {
    // Re-label an extract timeout/abort so the surfaced error (route returns
    // err.message as `detail`) tells the truth — the download completed but
    // the unpack stalled — instead of the old "connection timed out"
    // misattribution. Non-timeout errors (tar bomb, unsafe path) keep theirs.
    const relabeled = relabelTimeoutError(err, "extract");
    throw relabeled ?? err;
  }
}

/**
 * True for the AbortError / TimeoutError shapes Node's fetch +
 * AbortSignal.timeout (download deadline) and the extract AbortController
 * produce when a deadline fires. Exported for unit coverage.
 */
export function isTimeoutAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

/**
 * If `err` is a timeout/abort, return a fresh Error naming the phase it struck
 * (so an extract stall reads as an extract timeout, not a download failure);
 * otherwise return null and let the caller rethrow the original. Pure +
 * exported so both the phase wording and the per-phase deadline math are
 * unit-testable without driving a real timeout. The two phases carry separate
 * deadlines (download 45s / extract 120s); there is no "parse" phase here — the
 * parse loop has no abort signal, so it can never produce a timeout to relabel.
 */
export function relabelTimeoutError(
  err: unknown,
  phase: "download" | "extract",
  opts?: { downloadTimeoutMs?: number; extractTimeoutMs?: number },
): Error | null {
  if (!isTimeoutAbort(err)) return null;
  const limitMs =
    phase === "download"
      ? opts?.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS
      : opts?.extractTimeoutMs ?? EXTRACT_TIMEOUT_MS;
  const limitSec = Math.round(limitMs / 1000);
  return new Error(
    phase === "download"
      ? `OpenPrintTag download timed out (${limitSec}s limit)`
      : `OpenPrintTag extract timed out (${limitSec}s limit) — the download completed but the extract phase exceeded the deadline`,
  );
}

// ── Module-level cache ─────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedDatabase: OPTDatabase | null = null;
let cacheTimestamp = 0;
// #743: in-progress fetch shared by concurrent callers (single-flight).
let inFlightFetch: Promise<OPTDatabase> | null = null;

/**
 * Clear the cached database. Kept exported for test setup — production code
 * no longer calls it (the refresh-POST path now goes through
 * `fetchOpenPrintTagDatabase({force:true})`, which deliberately KEEPS the
 * cached entry so the SHA-aware probe has a baseline to compare against, #931).
 *
 * #743 (Codex P1): clears ONLY the cached result — NOT `inFlightFetch`. If a
 * cold load is still running, forgetting (not cancelling) the in-flight
 * promise would let a subsequent fetch start a SECOND download+parse instead
 * of joining the running one, and the older load's `finally` could later
 * clobber the newer in-flight/cache state — reintroducing the duplicate cold
 * parses this fix prevents. Leaving `inFlightFetch` intact means a refresh
 * joins any in-progress load, or starts a clean one when none is running.
 */
export function clearCache(): void {
  cachedDatabase = null;
  cacheTimestamp = 0;
}

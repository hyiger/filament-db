/**
 * GH #266: the slicer round-trip sync routes (PrusaSlicer / OrcaSlicer)
 * merge every unrecognised body key into a filament's `settings` Mixed
 * bag so slicer-specific config round-trips cleanly on the next export.
 *
 * Pre-fix that merge was unbounded — a caller could mass-assign an
 * arbitrary number of keys, or one multi-megabyte value, into the
 * embedded `settings` field. That document then bloats every subsequent
 * read of the filament (list aggregation, detail page, exports). This
 * helper caps both the total key count and the per-value serialized size
 * so a sync write can't degrade the filament.
 */

/** Max number of keys allowed in the merged `settings` bag. A real
 * slicer filament preset has on the order of ~100 keys; 400 is generous
 * headroom for forks / future keys without being an amplification sink. */
export const MAX_SETTINGS_KEYS = 400;

/** Max serialized length of any single settings value. Slicer values are
 * short scalars or small string arrays; 20k characters is far above any
 * legitimate value. */
export const MAX_SETTING_VALUE_LENGTH = 20_000;

export interface SettingsMergeResult {
  /** The merged bag (existing ∪ incoming non-structured keys). */
  settings: Record<string, unknown>;
  /** Keys that were added/updated from `incoming`. */
  added: string[];
  /**
   * Structured-owned keys that were PURGED from the seeded `existing` bag
   * (GH #950 sweep). A caller that only conditionally writes `update.settings`
   * (e.g. the OrcaSlicer per-id sync gates on `added`) MUST also write when
   * `removed` is non-empty, or the cleaned bag is discarded and the stale
   * shadow survives.
   */
  removed: string[];
  /** Non-null when a cap was exceeded — the caller should reject with 400. */
  error: string | null;
}

/**
 * Keys that must NEVER persist in the settings bag, regardless of the caller's
 * `structuredKeys`: `filament_settings_id` is re-derived from the filament's
 * CURRENT name on export, and `filamentdb_id`/`filamentdb_nozzle` are pure routing
 * hints. A STALE copy of any of these in `existing` shadows the re-derived value
 * on the next export (the 950.5 leak), so they are purged from the seeded bag.
 *
 * This is DELIBERATELY narrower than `structuredKeys`. GH #950 Codex r8: the Prusa
 * per-id calibration sync adds context-only keys (`extrusion_multiplier`,
 * retraction, fan speeds) to its `structuredKeys` — but those have NO top-level
 * filament home and can legitimately live in the bag as shared filament-wide
 * defaults, so purging the whole `structuredKeys` set erased them on every
 * per-nozzle sync. Purge ONLY the truly never-baggable keys here; the other
 * structured keys either have a top-level field that overrides any stale bag
 * shadow on export (harmless) or are legit shared defaults (must survive).
 */
export const NEVER_BAGGED_KEYS = new Set([
  "filament_settings_id",
  "filamentdb_id",
  "filamentdb_nozzle",
]);

/**
 * Merge `incoming` config keys into a copy of `existing`, skipping any
 * key in `structuredKeys` (those map to first-class Filament fields).
 * Enforces {@link MAX_SETTING_VALUE_LENGTH} per value and
 * {@link MAX_SETTINGS_KEYS} on the resulting bag.
 */
export function mergeSlicerSettings(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  structuredKeys: Set<string>,
): SettingsMergeResult {
  const settings: Record<string, unknown> = { ...existing };
  // GH #950 (sweep + Codex r8): purge only the truly never-baggable keys
  // ({@link NEVER_BAGGED_KEYS}) from the seeded `existing` bag — a stale copy of
  // those shadows the re-derived export value. Report them in `removed` so a
  // caller that only conditionally writes update.settings (the OrcaSlicer per-id
  // sync gates on `added`) still persists the purge. Crucially this does NOT strip
  // the whole `structuredKeys` set: per-id calibration syncs list context keys
  // (extrusion_multiplier / retraction / fans) there which can be legit shared
  // bag defaults and must survive.
  const removed: string[] = [];
  for (const key of NEVER_BAGGED_KEYS) {
    if (key in settings) {
      delete settings[key];
      removed.push(key);
    }
  }
  const added: string[] = [];

  for (const [key, value] of Object.entries(incoming)) {
    // Skip caller-structured keys AND the never-baggable keys (GH #950 Codex r9):
    // purging them only from `existing` is not enough — a caller whose
    // structuredKeys omits e.g. `filament_settings_id` (the OrcaSlicer per-id sync)
    // would otherwise re-add an incoming copy to the bag, re-shadowing the
    // re-derived export value. Keeping them out of BOTH sources makes the
    // never-baggable guarantee hold regardless of the caller's structured set.
    if (structuredKeys.has(key) || NEVER_BAGGED_KEYS.has(key)) continue;
    const serialized = JSON.stringify(value ?? null);
    if (serialized.length > MAX_SETTING_VALUE_LENGTH) {
      return {
        settings,
        added,
        removed,
        error: `settings.${key} value exceeds the ${MAX_SETTING_VALUE_LENGTH}-character limit`,
      };
    }
    settings[key] = value;
    added.push(key);
  }

  if (Object.keys(settings).length > MAX_SETTINGS_KEYS) {
    return {
      settings,
      added,
      removed,
      error: `settings bag exceeds the ${MAX_SETTINGS_KEYS}-key limit`,
    };
  }

  return { settings, added, removed, error: null };
}

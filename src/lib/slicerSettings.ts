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
  // GH #950 (adversarial sweep on PR #968): a structured-owned key must never
  // live in the settings bag — it's authoritative as a structured field, is
  // re-derived on export (e.g. `filament_settings_id` from the CURRENT name), or
  // is a pure routing hint (`filamentdb_id`/`filamentdb_nozzle`). The incoming
  // loop below already skips these, but a STALE copy carried in `existing`
  // (legacy data written before this rule) would otherwise survive the merge and
  // shadow the structured value on the next export — the exact 950.5 leak, closed
  // on the INI bulk-import path (which full-replaces a stripped bag) but not on
  // the per-id merge paths. Strip them from the seeded `existing` bag too so the
  // merge is source-agnostic, and report them in `removed` so a caller that only
  // conditionally writes update.settings (the OrcaSlicer per-id sync gates on
  // `added`) still persists the purge. Bambu passes an empty structuredKeys set →
  // no-op there.
  const removed: string[] = [];
  for (const key of structuredKeys) {
    if (key in settings) {
      delete settings[key];
      removed.push(key);
    }
  }
  const added: string[] = [];

  for (const [key, value] of Object.entries(incoming)) {
    if (structuredKeys.has(key)) continue;
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

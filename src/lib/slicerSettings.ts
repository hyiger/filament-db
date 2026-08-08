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

import { wrapIniString, serializeIniValue } from "./parseIni";

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
    // GH #1070 / Codex P2 round 6 on PR #1086: the settings bag is
    // WIRE-CANONICAL (src/lib/parseIni.ts codec docblock). A raw multi-line
    // string can only arrive from a JSON-sourced sync — the Orca per-id
    // route round-trips decodeMultilineWireValue's real newlines straight
    // back; INI-sourced bodies are line-based and can't carry one, and the
    // Bambu parser already wraps at its own ingestion (a wrapped value
    // holds escapes, not raw terminators, so this never double-wraps).
    // Wrapping HERE makes the invariant hold at every merge boundary — and
    // restores splitInheritedImportSet's strict per-key equality against a
    // parent's stored wire value, so an unchanged Orca sync of an inherited
    // multi-line setting keeps inheriting instead of pinning a variant
    // override that severs GH #106 live inheritance.
    const wireValue =
      typeof value === "string" && /[\r\n]/.test(value) ? wrapIniString(value) : value;
    const serialized = JSON.stringify(wireValue ?? null);
    if (serialized.length > MAX_SETTING_VALUE_LENGTH) {
      return {
        settings,
        added,
        removed,
        error: `settings.${key} value exceeds the ${MAX_SETTING_VALUE_LENGTH}-character limit`,
      };
    }
    settings[key] = wireValue;
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

/**
 * GH #1072 (item 2): validate a client-supplied whole `settings` bag against
 * the GH #266 caps. `mergeSlicerSettings` enforces them on the slicer sync
 * routes, but the generic `POST /api/filaments` and `PUT /api/filaments/{id}`
 * forward `body.settings` (a `Schema.Types.Mixed` field — `runValidators` is
 * a no-op for it) straight into create/findOneAndUpdate, so an unbounded bag
 * persisted and then rode every subsequent read of the filament (list
 * aggregation, detail page, all three slicer exports, snapshot, hybrid-sync
 * copies) — exactly the degradation GH #266 closed on the sync family only.
 *
 * Returns an error string for the route to 400 with, or `null` when valid.
 * `null`/`undefined` pass (nothing to validate; `settings: null` clears the
 * bag). Non-object shapes are rejected — Mixed would happily persist a
 * string/array bag that every reader expects to be a plain object.
 */
/**
 * GH #1070 / Codex P2 round 7 on PR #1086: the generic filament POST/PUT
 * accept a whole `settings` bag (and dotted `settings.<key>` update paths)
 * and persist them verbatim — they don't pass through mergeSlicerSettings,
 * so they were the one remaining writer that could land a NEW raw
 * multi-line string in the wire-canonical bag. serializeIniValue's emit
 * heuristic treats any raw multi-line value as a pre-#1070 legacy form
 * wrap; for a fresh generic write whose content legitimately starts and
 * ends with quote characters, that stripped genuine content quotes at
 * export. Normalizing here makes "raw multi-line ⇒ legacy row" true BY
 * CONSTRUCTION across every post-#1070 writer (slicer syncs →
 * mergeSlicerSettings, the Bambu parser → ingestion wrap, the form →
 * wrapIniString, generic API → this helper); the only raw multi-line bag
 * values left are genuinely legacy rows (or a snapshot restore of them),
 * exactly what the heuristic exists for.
 *
 * Mutates `body` in place. Call BEFORE the validators so the length caps
 * apply to the WRAPPED value (same posture as mergeSlicerSettings).
 * Idempotent: a wrapped value holds escapes, not raw terminators.
 *
 * Canonicalization DELEGATES to serializeIniValue with the bag key (Codex
 * P1 round 10): this route's input can be ECHOED STORED BYTES — the form's
 * wireOrEdited deliberately returns a pre-#1070 raw wrap byte-identical
 * (`"line one<NL>line two"`), and blind whole-value wrapping turned the
 * old wrapper quotes into literal content on an untouched save. The
 * key-scoped strip heals such a value to canonical wire of the SAME
 * content on the three legacy form keys, while every other key keeps its
 * boundary quotes as content (the round-9 export semantics, applied
 * symmetrically at the write boundary). mergeSlicerSettings deliberately
 * does NOT delegate: its input is always slicer-decoded CONTENT (the fork
 * echoes what the export decoded, never stored bytes), so quotes there
 * are content on every key.
 */
export function normalizeSettingsToWire(body: Record<string, unknown>): void {
  const bag = body.settings;
  if (bag && typeof bag === "object" && !Array.isArray(bag)) {
    const rec = bag as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v === "string" && /[\r\n]/.test(v)) {
        rec[k] = serializeIniValue(v, k);
      }
    }
  }
  for (const [k, v] of Object.entries(body)) {
    if (k.startsWith("settings.") && typeof v === "string" && /[\r\n]/.test(v)) {
      body[k] = serializeIniValue(v, k.slice("settings.".length));
    }
  }
}

export function validateSettingsBag(settings: unknown): string | null {
  if (settings === undefined || settings === null) return null;
  if (typeof settings !== "object" || Array.isArray(settings)) {
    return "settings must be an object";
  }
  const entries = Object.entries(settings as Record<string, unknown>);
  if (entries.length > MAX_SETTINGS_KEYS) {
    return `settings bag exceeds the ${MAX_SETTINGS_KEYS}-key limit`;
  }
  for (const [key, value] of entries) {
    if (JSON.stringify(value ?? null).length > MAX_SETTING_VALUE_LENGTH) {
      return `settings.${key} value exceeds the ${MAX_SETTING_VALUE_LENGTH}-character limit`;
    }
  }
  return null;
}

/**
 * GH #1072 (items 2+3): the DOTTED companion to {@link validateSettingsBag}.
 * Mongoose casts `{"settings.blob": …}` as a live nested update path (in
 * document construction too), so capping only the whole-object form leaves an
 * equivalent uncapped write shape. Each dotted value gets the same per-value
 * cap, and the resulting top-level key COUNT is bounded against the union
 * with `existingKeys` (the stored bag's keys — dotted paths MERGE into the
 * stored bag rather than replacing it, so repeated requests could otherwise
 * grow it past MAX_SETTINGS_KEYS incrementally). Pass `[]` for a create
 * (no stored bag yet).
 *
 * NESTED dotted paths (`settings.<key>.<sub>`) are rejected outright (Codex
 * P1 on PR #1089): the bag is FLAT by contract (slicer key → scalar value —
 * every writer, reader, exporter and the detail-page settings table assume
 * it), and Mongoose MERGES a nested path into the stored value. Counting
 * `settings.bucket.k1`, `settings.bucket.k2`, … as one `bucket` key while
 * each small leaf passes the per-value cap would let repeated requests grow
 * `bucket` into an arbitrarily large object — recreating exactly the
 * document bloat this validator exists to prevent. No first-party client
 * ever writes a nested settings path, so rejection breaks nothing.
 *
 * Returns an error string or `null`. A body with no `settings.`-prefixed
 * keys returns `null` immediately.
 */
export function validateDottedSettingsPaths(
  body: Record<string, unknown>,
  existingKeys: readonly string[],
): string | null {
  const dotted = Object.keys(body).filter((k) => k.startsWith("settings."));
  if (dotted.length === 0) return null;
  const mergedKeys = new Set(existingKeys);
  for (const key of dotted) {
    const sub = key.slice("settings.".length);
    if (sub.includes(".")) {
      return `${key}: nested settings paths are not supported — the settings bag is flat`;
    }
    mergedKeys.add(sub);
    if (JSON.stringify(body[key] ?? null).length > MAX_SETTING_VALUE_LENGTH) {
      return `${key} value exceeds the ${MAX_SETTING_VALUE_LENGTH}-character limit`;
    }
  }
  if (mergedKeys.size > MAX_SETTINGS_KEYS) {
    return `settings bag exceeds the ${MAX_SETTINGS_KEYS}-key limit`;
  }
  return null;
}

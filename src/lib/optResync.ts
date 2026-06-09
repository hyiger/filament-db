/**
 * GH #607 — re-sync settings from OpenPrintTag (Phase 1).
 *
 * Pure, DB-free helpers for comparing a filament that was imported from the
 * OpenPrintTag community database against the *current* upstream material,
 * and for applying the subset of changes the user accepts.
 *
 * The linkage already lives on the row: an OPT-imported filament carries
 * `settings.openprinttag_slug` + `settings.openprinttag_uuid` (written by
 * `src/app/api/openprinttag/import/route.ts`). This module never fetches or
 * touches the DB — the route does that and hands us:
 *   - the stored filament doc (lean),
 *   - the OPT material mapped through `mapToFilamentPayload` (the "incoming"
 *     value, already in Filament field shape),
 *   - the per-field provenance snapshot of what OPT last wrote.
 *
 * Provenance model (the crux — see #607): the import / last-sync captures a
 * snapshot of the OPT-offered value for each managed field under
 * `settings.openprinttag_snapshot`. On a re-check we classify each differing
 * field:
 *   - current is null (or the gray `#808080` color sentinel)  → `adopt`
 *       (gap-fill — the field was never set locally).
 *   - snapshot exists AND current === snapshot                → `adopt`
 *       (OPT owned this value and it was never edited; upstream changed it).
 *   - snapshot exists AND current !== snapshot                → `conflict`
 *       (the user edited away from OPT — don't silently revert).
 *   - no snapshot entry AND current differs from incoming     → `conflict`
 *       (no provenance to prove it's safe — surface it, let the user decide).
 *
 * Phase 1 lets the user pick which fields to apply, so the classification is
 * advisory: it drives default-checked vs. needs-confirmation in the UI, not
 * an auto-apply. Nothing here mutates anything.
 */

/** A flattened, comparable field value. */
export type OptValue = string | number | string[] | null;

export type OptChangeKind = "adopt" | "conflict";

export interface OptFieldChange {
  /** Stable field key — dotted for nested temps (`temperatures.nozzle`). */
  field: string;
  /** i18n key for the human label. */
  labelKey: string;
  /** Current stored value (null when unset). */
  current: OptValue;
  /** The value OpenPrintTag currently offers. Never null here. */
  incoming: OptValue;
  kind: OptChangeKind;
}

/**
 * The OPT-managed fields, in display order. Each maps a stored-doc path to
 * an i18n label. Both the stored filament and the `mapToFilamentPayload`
 * output share this shape, so one path reads both sides.
 *
 * Deliberately excluded: name / vendor / type (identity + unique-name key —
 * re-syncing them would break the link and the index), and diameter
 * (`mapToFilamentPayload` hardcodes 1.75; it isn't real OPT data).
 */
export const OPT_MANAGED_FIELDS: ReadonlyArray<{ field: string; labelKey: string; isColor?: boolean }> = [
  { field: "color", labelKey: "resync.field.color", isColor: true },
  { field: "secondaryColors", labelKey: "resync.field.secondaryColors" },
  { field: "density", labelKey: "resync.field.density" },
  { field: "temperatures.nozzle", labelKey: "resync.field.nozzleTemp" },
  { field: "temperatures.nozzleRangeMin", labelKey: "resync.field.nozzleRangeMin" },
  { field: "temperatures.nozzleRangeMax", labelKey: "resync.field.nozzleRangeMax" },
  { field: "temperatures.bed", labelKey: "resync.field.bedTemp" },
  { field: "temperatures.standby", labelKey: "resync.field.standbyTemp" },
  { field: "dryingTemperature", labelKey: "resync.field.dryingTemp" },
  { field: "dryingTime", labelKey: "resync.field.dryingTime" },
  { field: "shoreHardnessD", labelKey: "resync.field.shoreD" },
  { field: "transmissionDistance", labelKey: "resync.field.transmissionDistance" },
  { field: "optTags", labelKey: "resync.field.optTags" },
] as const;

const COLOR_SENTINEL = "#808080";

/** Snapshot keys can't contain dots (Mongo nesting). `temperatures.nozzle`
 *  → `temperatures_nozzle`. The snapshot is always written as one whole
 *  object so this sanitisation only matters for lookups. */
export function optSnapshotKey(field: string): string {
  return field.replace(/\./g, "_");
}

/** Read a (possibly nested) field from a plain object via a dotted path.
 *  Returns `null` for any missing / null / undefined segment so callers
 *  don't have to distinguish the three. */
function getPath(obj: Record<string, unknown> | null | undefined, path: string): OptValue {
  if (!obj) return null;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur == null) return null;
  if (Array.isArray(cur)) return cur.map((x) => String(x)) as string[];
  if (typeof cur === "number" || typeof cur === "string") return cur;
  return null;
}

/** Order-sensitive structural equality for OptValues. */
function valuesEqual(a: OptValue, b: OptValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** Does OPT actually offer a value for this field? (null / empty array = no.) */
function hasIncoming(v: OptValue): boolean {
  if (v == null) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

/**
 * Build the provenance snapshot from a mapped OPT payload — the OPT-offered
 * value for every managed field that OPT actually carries, keyed by the
 * dot-free snapshot key. Written to `settings.openprinttag_snapshot` on
 * import and on each sync so future re-checks can tell "OPT changed it" from
 * "the user changed it".
 */
export function buildOptSnapshot(payload: Record<string, unknown>): Record<string, OptValue> {
  const snap: Record<string, OptValue> = {};
  for (const { field } of OPT_MANAGED_FIELDS) {
    const v = getPath(payload, field);
    if (!hasIncoming(v)) continue;
    snap[optSnapshotKey(field)] = v;
  }
  return snap;
}

function classify(
  current: OptValue,
  snapshotVal: OptValue | undefined,
  hasSnapshotEntry: boolean,
  isColor: boolean,
): OptChangeKind {
  const sentinel = isColor && current === COLOR_SENTINEL;
  if (current == null || sentinel) return "adopt";
  if (hasSnapshotEntry) {
    return valuesEqual(current, snapshotVal ?? null) ? "adopt" : "conflict";
  }
  return "conflict";
}

/**
 * Diff a stored filament against the current OPT material (already mapped
 * through `mapToFilamentPayload`). Returns one entry per field that differs
 * AND that OPT actually offers a value for. Fields OPT doesn't carry, and
 * fields already equal to the upstream value, are omitted.
 */
export function diffOptFields(
  filament: Record<string, unknown>,
  payload: Record<string, unknown>,
  snapshot: Record<string, unknown> | null | undefined,
): OptFieldChange[] {
  const changes: OptFieldChange[] = [];
  for (const { field, labelKey, isColor } of OPT_MANAGED_FIELDS) {
    const incoming = getPath(payload, field);
    if (!hasIncoming(incoming)) continue;
    const current = getPath(filament, field);
    if (valuesEqual(current, incoming)) continue;
    const snapKey = optSnapshotKey(field);
    const hasSnapshotEntry = !!snapshot && Object.prototype.hasOwnProperty.call(snapshot, snapKey);
    const snapshotVal = hasSnapshotEntry ? getPath(snapshot as Record<string, unknown>, snapKey) : undefined;
    const kind = classify(current, snapshotVal, hasSnapshotEntry, !!isColor);
    changes.push({ field, labelKey, current, incoming, kind });
  }
  return changes;
}

/** The set of field keys the sync endpoint will accept — guards against a
 *  client asking us to `$set` an arbitrary path. */
export const OPT_MANAGED_FIELD_KEYS: ReadonlySet<string> = new Set(
  OPT_MANAGED_FIELDS.map((f) => f.field),
);

/**
 * Build the `$set` patch for the user-accepted subset. `selected` is the
 * list of field keys (validated against OPT_MANAGED_FIELD_KEYS by the
 * caller); unknown keys are skipped. Dotted keys are written as-is — Mongo
 * interprets `temperatures.nozzle` as the nested set, which is what we want.
 * Returns `{}` when nothing valid is selected.
 */
export function buildOptSyncUpdate(
  selected: string[],
  payload: Record<string, unknown>,
): Record<string, OptValue> {
  const update: Record<string, OptValue> = {};
  for (const field of selected) {
    if (!OPT_MANAGED_FIELD_KEYS.has(field)) continue;
    update[field] = getPath(payload, field);
  }
  return update;
}

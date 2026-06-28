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
 * `openprinttagSnapshot`. On a re-check we classify each differing
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

import { INHERITABLE_FIELDS } from "@/lib/resolveFilament";

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

/**
 * GH #607 (Codex P2): fields where an explicit null / empty-array from
 * OpenPrintTag is a REAL, syncable value rather than "OPT carries nothing
 * here". For these the diff must surface a clear:
 *   - `color: null` — the material went coextruded (primary dropped, the
 *     colors live in secondaryColors). `mapToFilamentPayload` only emits a
 *     null primary in that case, so a null color is always deliberate.
 *   - `secondaryColors: []` / `optTags: []` — the material lost its
 *     secondaries / tags.
 * For every OTHER managed field a null incoming means "OPT has no data"
 * (e.g. a sparse material with no density) — we must NOT offer to wipe the
 * user's local value, so those stay skipped.
 */
const OPT_CLEARABLE_FIELDS: ReadonlySet<string> = new Set([
  "color",
  "secondaryColors",
  "optTags",
]);

/**
 * GH #607 (Codex P2): the ARRAY clearables. A variant can't clear an
 * inherited array — `resolveFilament` treats an empty array as "inherit", so
 * `$set`-ing `[]` onto the variant just re-inherits the parent's array. The
 * effective value never reaches empty, so offering the clear would report a
 * no-op "success" and re-surface on every check. `diffOptFields(isVariant)`
 * suppresses these clears for variants. `color` is NOT here — it's a scalar
 * and variant-only (never inherited), so clearing it to null works fine.
 */
const OPT_CLEARABLE_ARRAY_FIELDS: ReadonlySet<string> = new Set([
  "secondaryColors",
  "optTags",
]);

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
  // Preserve element types (numbers stay numbers) — a shallow copy avoids
  // mutating the source. Stringifying here would write string tags into the
  // `optTags: [Number]` schema on sync.
  if (Array.isArray(cur)) return [...cur] as string[];
  if (typeof cur === "number" || typeof cur === "string") return cur;
  return null;
}

/** Order-sensitive structural equality for OptValues. `null` and `[]` both
 *  mean "nothing" and compare equal — so a field a user never set (null) and
 *  one OPT doesn't offer ([]) aren't surfaced as a spurious change. */
function valuesEqual(a: OptValue, b: OptValue): boolean {
  const aEmpty = a == null || (Array.isArray(a) && a.length === 0);
  const bEmpty = b == null || (Array.isArray(b) && b.length === 0);
  if (aEmpty && bEmpty) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** The managed fields whose values are hex colors. Hex is case-insensitive
 *  (`#AABBCC` === `#aabbcc`), so comparing them with raw `===` (GH #894) made
 *  a casing-only difference look like a real change → a permanent spurious
 *  `conflict` re-surfaced on every re-check. Compare these case-folded. */
const COLOR_FIELDS: ReadonlySet<string> = new Set(["color", "secondaryColors"]);

/** Lower-case a hex color value (string or array of strings) for comparison;
 *  pass anything else through unchanged. */
function canonicalizeColor(v: OptValue): OptValue {
  if (typeof v === "string") return v.toLowerCase();
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x.toLowerCase() : x)) as string[];
  return v;
}

/** `valuesEqual`, but case-insensitive for hex-color fields (GH #894). */
function valuesEqualForField(field: string, a: OptValue, b: OptValue): boolean {
  if (COLOR_FIELDS.has(field)) return valuesEqual(canonicalizeColor(a), canonicalizeColor(b));
  return valuesEqual(a, b);
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
 * dot-free snapshot key. Written to `openprinttagSnapshot` on
 * import and on each sync so future re-checks can tell "OPT changed it" from
 * "the user changed it".
 */
export function buildOptSnapshot(payload: Record<string, unknown>): Record<string, OptValue> {
  const snap: Record<string, OptValue> = {};
  for (const { field } of OPT_MANAGED_FIELDS) {
    const v = getPath(payload, field);
    // The gray sentinel is "OPT has no real color" — not a value worth
    // recording as the upstream offer.
    if (field === "color" && v === COLOR_SENTINEL) continue;
    // Only record actual values. A null/empty offer doesn't need a snapshot
    // entry: `valuesEqual` treats null ≈ [] so a later diff still compares
    // correctly, and the diff itself (not the snapshot) is what surfaces an
    // explicit upstream clear.
    if (!hasIncoming(v)) continue;
    // GH #894: store hex colors canonicalized (lower-case) so the recorded
    // upstream offer is in a stable case; the diff also case-folds, so even a
    // pre-existing mixed-case snapshot compares correctly without a backfill.
    snap[optSnapshotKey(field)] = COLOR_FIELDS.has(field) ? canonicalizeColor(v) : v;
  }
  return snap;
}

function classify(
  current: OptValue,
  snapshotVal: OptValue | undefined,
  hasSnapshotEntry: boolean,
  field: string,
): OptChangeKind {
  // The gray sentinel ("OPT has no real color") applies to the primary color only.
  const sentinel = field === "color" && current === COLOR_SENTINEL;
  // A null OR empty-array local value is "the user never set this" — a
  // gap-fill, safe to adopt (covers OPT newly providing secondaries/tags).
  const empty = current == null || (Array.isArray(current) && current.length === 0);
  if (empty || sentinel) return "adopt";
  if (hasSnapshotEntry) {
    // GH #894: case-fold hex colors so a casing-only difference vs the stored
    // snapshot classifies as `adopt` (unchanged), not a permanent `conflict`.
    return valuesEqualForField(field, current, snapshotVal ?? null) ? "adopt" : "conflict";
  }
  return "conflict";
}

/**
 * Diff a stored filament against the current OPT material (already mapped
 * through `mapToFilamentPayload`). Returns one entry per field that differs
 * AND that OPT actually offers a value for. Fields OPT doesn't carry, and
 * fields already equal to the upstream value, are omitted.
 *
 * `parentEffective` — the resolved values of the filament's PARENT, or null
 * for a root filament (GH #607, Codex P2). Used to suppress an UNAPPLYABLE
 * array clear: clearing a variant's `secondaryColors`/`optTags` writes `[]`,
 * which resolves back to the parent's array, so the clear only reaches empty
 * when the parent's array is ALSO empty. When the parent's array is non-empty
 * the clear can never take (it would re-offer every check), so it's dropped —
 * but a variant that OWNS a non-empty array over an EMPTY parent keeps the
 * (genuinely applyable) clear. Pass the EFFECTIVE (resolved) filament for the
 * values regardless.
 */
export function diffOptFields(
  filament: Record<string, unknown>,
  payload: Record<string, unknown>,
  snapshot: Record<string, unknown> | null | undefined,
  parentEffective?: Record<string, unknown> | null,
): OptFieldChange[] {
  const changes: OptFieldChange[] = [];
  for (const { field, labelKey, isColor } of OPT_MANAGED_FIELDS) {
    const incoming = getPath(payload, field);
    // The gray sentinel is "OPT has no real color" — never offer to push it
    // onto the user's filament.
    if (isColor && incoming === COLOR_SENTINEL) continue;
    // For a non-clearable field, a null/empty incoming means OPT carries no
    // value — skip (don't offer to wipe local data). For clearable fields
    // (color/secondaryColors/optTags) an explicit null/[] IS the update, so
    // fall through and let valuesEqual decide whether it's a real change
    // (GH #607, Codex P2 — explicit upstream clears must surface).
    if (!hasIncoming(incoming) && !OPT_CLEARABLE_FIELDS.has(field)) continue;
    // GH #607 (Codex P2): suppress an array clear that can't actually take.
    // Clearing a variant's array writes `[]`, which resolves to the parent's
    // array — so the clear only reaches empty when the parent's array is also
    // empty. Drop the change when the parent's array is non-empty (covers an
    // inherited array AND a variant-owned array over a non-empty parent); keep
    // it when the parent is empty (a variant-owned array can really be cleared)
    // and for roots (parentEffective is null).
    if (
      !hasIncoming(incoming) &&
      OPT_CLEARABLE_ARRAY_FIELDS.has(field) &&
      parentEffective &&
      hasIncoming(getPath(parentEffective, field))
    ) {
      continue;
    }
    const current = getPath(filament, field);
    // GH #894: hex colors compare case-insensitively, so `#AABBCC` already
    // stored vs an `#aabbcc` upstream offer isn't surfaced as a spurious change.
    if (valuesEqualForField(field, current, incoming)) continue;
    const snapKey = optSnapshotKey(field);
    const hasSnapshotEntry = !!snapshot && Object.prototype.hasOwnProperty.call(snapshot, snapKey);
    const snapshotVal = hasSnapshotEntry ? getPath(snapshot as Record<string, unknown>, snapKey) : undefined;
    const kind = classify(current, snapshotVal, hasSnapshotEntry, field);
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

/**
 * Build the `$set` patch that LINKS a filament to an OpenPrintTag material —
 * the `settings.openprinttag_slug` / `_uuid` reference plus the provenance
 * snapshot. Writes the linkage and provenance ONLY; it never touches a field
 * value, so linking an existing filament (Issue #753, approach C) can't
 * clobber a user-set or inherited value. The snapshot records the FULL current
 * OPT offer (`buildOptSnapshot`) so the very next "check for updates" classifies
 * each managed field correctly (unedited-equal-to-OPT → adopt, diverged →
 * conflict). Dotted `settings.*` keys are written so an existing row's other
 * settings survive the `$set`. Shared by the OPT import route and the link
 * route so both establish the link identically.
 */
export function buildOptLinkUpdate(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const settings = (payload.settings as Record<string, string> | undefined) ?? {};
  return {
    "settings.openprinttag_uuid": settings.openprinttag_uuid,
    "settings.openprinttag_slug": settings.openprinttag_slug,
    openprinttagSnapshot: buildOptSnapshot(payload),
  };
}

/**
 * Issue #753 (approach A) — prune a mapped OPT payload so that creating it as a
 * VARIANT of `parentEffective` carries only the fields that are DISTINCT from
 * the parent. Every inheritable field whose incoming OPT value EXACTLY equals
 * the parent's effective value is removed/emptied so the variant inherits it
 * dynamically via `resolveFilament` (matching the read-time inheritance model
 * exactly: scalars/temps → null, the whole-array fields → `[]`). Strict
 * equality only — a value that merely resembles the parent is kept.
 *
 * Never pruned:
 *   - `color` / `colorName` / `name` — variant-only (a color variant's whole
 *     point is its own color; `name` is the unique-name key). `color` isn't in
 *     INHERITABLE_FIELDS, so it's untouched here; `name` likewise.
 *   - `vendor` / `type` — required identity fields (`required: true` in the
 *     schema). A variant must carry its own (so it can't be left to inherit a
 *     null), and they're identity, not "a bunch of values to strip". Excluded
 *     even though they're inheritable.
 *   - `settings` / `openprinttagSnapshot` — the OPT linkage + provenance must
 *     ride on the variant itself (so it's the variant that's "linked").
 *
 * Pruning to inherit relies on the inheritance contract that null/""/[] mean
 * "inherit from parent" (see resolveFilament INHERITABLE_FIELDS + the
 * empty-array fallback). Pass the parent's EFFECTIVE (resolved) values — a
 * parent that is itself a variant must contribute its inherited values.
 * Returns the original payload unchanged when there's no parent.
 */
const PRUNE_TEMP_FIELDS = [
  "nozzle",
  "nozzleFirstLayer",
  "bed",
  "bedFirstLayer",
  "nozzleRangeMin",
  "nozzleRangeMax",
  "standby",
] as const;

/** Whole-array fields that inherit when empty (empty === inherit). */
const PRUNE_ARRAY_FIELDS = ["optTags", "secondaryColors"] as const;

/** Inheritable fields that must NOT be pruned: `vendor`/`type` are
 *  `required: true` in the schema, so a variant must carry its own value (it
 *  can't be left null to inherit) — and they're identity, not "values to
 *  strip". */
const PRUNE_SKIP_FIELDS: ReadonlySet<string> = new Set(["vendor", "type"]);

export function pruneOptPayloadAgainstParent(
  payload: Record<string, unknown>,
  parentEffective: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!parentEffective) return payload;
  const pruned: Record<string, unknown> = { ...payload };

  // Inheritable scalars (density, diameter, drying*, shore*, transmission,
  // etc.): drop when equal to the parent's effective value so the variant
  // inherits. `color`/`colorName`/`name` aren't in INHERITABLE_FIELDS (never
  // pruned); `vendor`/`type` are skipped (required identity).
  for (const field of INHERITABLE_FIELDS) {
    if (PRUNE_SKIP_FIELDS.has(field)) continue;
    if (!(field in pruned)) continue;
    const v = pruned[field] as OptValue;
    if (v == null || v === "") continue; // already inheriting
    if (valuesEqual(v, getPath(parentEffective, field))) {
      delete pruned[field];
    }
  }

  // Temperatures (nested): null out a subfield equal to the parent's so it
  // inherits via resolveFilament's `?? parentTemps[...]` fallback.
  if (pruned.temperatures && typeof pruned.temperatures === "object") {
    const pTemps = { ...(pruned.temperatures as Record<string, unknown>) };
    for (const tf of PRUNE_TEMP_FIELDS) {
      const v = pTemps[tf] as OptValue;
      if (v == null) continue;
      if (valuesEqual(v, getPath(parentEffective, `temperatures.${tf}`))) {
        pTemps[tf] = null;
      }
    }
    pruned.temperatures = pTemps;
  }

  // Whole-array fields: set `[]` when equal to the parent's so the variant
  // inherits the parent's array (empty === inherit, GH #106). A non-empty
  // array that DIFFERS from the parent stays — that's the variant's distinct
  // data (e.g. a coextruded variant's own secondaryColors).
  //
  // KNOWN LIMITATION (Codex P2 on #753): when the OPT material's array is EMPTY
  // but the parent's is NON-empty, the variant can't represent "explicitly
  // empty" — `resolveFilament` reads `[]` as "inherit", so the variant resolves
  // to the parent's array (e.g. a single-color/no-tag material imported under a
  // multi-color/tagged parent shows the parent's colors/tags). This is the SAME
  // empty=inherit constraint the resync side documents in
  // OPT_CLEARABLE_ARRAY_FIELDS above; there is no stored value that resolves to
  // empty while the parent is non-empty, so it can't be fixed here without a
  // model-level "no-inherit" array sentinel (out of scope — it would ripple
  // through resolveFilament, the resync diff, and exports). The user can still
  // override after import by editing the variant's colors/tags. The common case
  // (parent is a base catalog entry without secondaries/tags) is unaffected.
  for (const field of PRUNE_ARRAY_FIELDS) {
    const v = pruned[field];
    if (!Array.isArray(v) || v.length === 0) continue;
    if (valuesEqual(v as string[], getPath(parentEffective, field))) {
      pruned[field] = [];
    }
  }

  return pruned;
}

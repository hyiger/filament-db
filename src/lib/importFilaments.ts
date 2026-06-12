import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { unsanitizeCsvCell } from "@/lib/csvWriter";

export interface ImportRow {
  name?: string;
  vendor?: string;
  type?: string;
  color?: string;
  /** GH #477: comma-separated list of secondary color hexes from the
   *  "Secondary Colors" column. Round-trips with the EXPORT_COLUMNS
   *  entry of the same name. Empty/blank entries are filtered out;
   *  entries that don't match `#RRGGBB` are silently dropped (the
   *  schema validator would reject them anyway and the importer's
   *  job is to be tolerant of partial sources). Capped at 5 entries
   *  to match the spec. */
  secondaryColors?: string;
  diameter?: number | null;
  cost?: number | null;
  density?: number | null;
  nozzleTemp?: number | null;
  nozzleFirstLayerTemp?: number | null;
  bedTemp?: number | null;
  bedFirstLayerTemp?: number | null;
  maxVolumetricSpeed?: number | null;
  spoolWeight?: number | null;
  netFilamentWeight?: number | null;
  dryingTemperature?: number | null;
  dryingTime?: number | null;
  transmissionDistance?: number | null;
  glassTempTransition?: number | null;
  heatDeflectionTemp?: number | null;
  shoreHardnessA?: number | null;
  shoreHardnessD?: number | null;
  minPrintSpeed?: number | null;
  maxPrintSpeed?: number | null;
  colorName?: string | null;
  spoolType?: string | null;
  nozzleRangeMin?: number | null;
  nozzleRangeMax?: number | null;
  standbyTemp?: number | null;
  tdsUrl?: string | null;
  instanceId?: string | null;
  /**
   * GH #379: optional parent-filament name surfaced as the `Parent` column
   * in the filament CSV/XLSX export (see EXPORT_COLUMNS in
   * `src/lib/exportFilaments.ts`). Only honoured on CREATE/RESURRECT — for
   * an existing active filament we ignore it, because silently re-parenting
   * a row from a re-imported edit is a surprising user experience and the
   * "Create variant" / Clone-from-parent UI already covers the manual case.
   */
  parentName?: string | null;
}

/** Map header text (case-insensitive) to ImportRow keys */
const HEADER_MAP: Record<string, keyof ImportRow | undefined> = {
  name: "name",
  vendor: "vendor",
  type: "type",
  color: "color",
  "secondary colors": "secondaryColors",
  secondarycolors: "secondaryColors",
  "secondary color": "secondaryColors",
  "diameter (mm)": "diameter",
  diameter: "diameter",
  cost: "cost",
  "density (g/cm³)": "density",
  "density (g/cm3)": "density",
  density: "density",
  "nozzle temp (°c)": "nozzleTemp",
  "nozzle temp": "nozzleTemp",
  nozzletemp: "nozzleTemp",
  "nozzle first layer (°c)": "nozzleFirstLayerTemp",
  "nozzle first layer": "nozzleFirstLayerTemp",
  "bed temp (°c)": "bedTemp",
  "bed temp": "bedTemp",
  bedtemp: "bedTemp",
  "bed first layer (°c)": "bedFirstLayerTemp",
  "bed first layer": "bedFirstLayerTemp",
  "max vol. speed (mm³/s)": "maxVolumetricSpeed",
  "max volumetric speed": "maxVolumetricSpeed",
  "spool weight (g)": "spoolWeight",
  "spool weight": "spoolWeight",
  "net filament weight (g)": "netFilamentWeight",
  "net filament weight": "netFilamentWeight",
  spools: undefined, // skip spool count — computed, not importable
  "tds url": "tdsUrl",
  tdsurl: "tdsUrl",
  "instance id": "instanceId",
  instanceid: "instanceId",
  "instance_id": "instanceId",
  "drying temp": "dryingTemperature",
  "drying temp (°c)": "dryingTemperature",
  "drying temperature": "dryingTemperature",
  dryingtemperature: "dryingTemperature",
  "drying time": "dryingTime",
  "drying time (min)": "dryingTime",
  dryingtime: "dryingTime",
  "transmission distance": "transmissionDistance",
  "hueforge td": "transmissionDistance",
  transmissiondistance: "transmissionDistance",
  td: "transmissionDistance",
  "shore a": "shoreHardnessA",
  "shore hardness a": "shoreHardnessA",
  shorea: "shoreHardnessA",
  "shore d": "shoreHardnessD",
  "shore hardness d": "shoreHardnessD",
  shored: "shoreHardnessD",
  "glass transition": "glassTempTransition",
  "glass transition tg (°c)": "glassTempTransition",
  tg: "glassTempTransition",
  "heat deflection": "heatDeflectionTemp",
  "heat deflection hdt (°c)": "heatDeflectionTemp",
  hdt: "heatDeflectionTemp",
  "min print speed": "minPrintSpeed",
  "min print speed (mm/s)": "minPrintSpeed",
  "max print speed": "maxPrintSpeed",
  "max print speed (mm/s)": "maxPrintSpeed",
  "color name": "colorName",
  colorname: "colorName",
  "spool type": "spoolType",
  spooltype: "spoolType",
  "nozzle range min": "nozzleRangeMin",
  "nozzle range min (°c)": "nozzleRangeMin",
  "nozzle range max": "nozzleRangeMax",
  "nozzle range max (°c)": "nozzleRangeMax",
  "standby temp": "standbyTemp",
  "standby temp (°c)": "standbyTemp",
  // GH #379: round-trip the filament-level export's parent/variant columns.
  // "Parent" carries the parent filament's name (string); "Variant Count"
  // is derived/read-only and explicitly skipped so a re-import doesn't try
  // to set it as a field.
  parent: "parentName",
  "parent name": "parentName",
  parentname: "parentName",
  "variant count": undefined,
  variantcount: undefined,
};

const NUM_FIELDS = new Set<keyof ImportRow>([
  "diameter",
  "cost",
  "density",
  "nozzleTemp",
  "nozzleFirstLayerTemp",
  "bedTemp",
  "bedFirstLayerTemp",
  "maxVolumetricSpeed",
  "spoolWeight",
  "netFilamentWeight",
  "dryingTemperature",
  "dryingTime",
  "transmissionDistance",
  "shoreHardnessA",
  "shoreHardnessD",
  "glassTempTransition",
  "heatDeflectionTemp",
  "minPrintSpeed",
  "maxPrintSpeed",
  "nozzleRangeMin",
  "nozzleRangeMax",
  "standbyTemp",
]);

function parseNum(val: unknown): number | null {
  if (val == null || val === "") return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

/**
 * GH #627 item 3: free-text string fields whose exported form may carry the
 * formula-injection guard apostrophe (`csvCell` prefixes `'` to cells
 * starting with `=`, `+`, `-`, `@`, tab, CR — and since GH #627 item 5 the
 * XLSX export applies the same prefix). These get run through
 * `unsanitizeCsvCell` on import so a filament named `+95A TPU` exports as
 * `'+95A TPU` and re-imports as `+95A TPU` — pre-fix the apostrophe
 * persisted verbatim, the name no longer matched the existing row, and the
 * import created a corrupted duplicate. Mirrors what `/api/spools/import`
 * has done since the Codex P2 follow-up to PR #144.
 *
 * Deliberately NOT applied to `color` / `secondaryColors` / `tdsUrl` — those
 * are format-validated (`#rrggbb`, http(s)://) and can never start with a
 * trigger character, so a genuine leading apostrophe (if a user somehow stored
 * one) survives untouched.
 */
const UNSANITIZE_FIELDS = new Set<keyof ImportRow>([
  "name",
  "vendor",
  // `type` is a required free-text field the exporter also prefixes, so a
  // type like `+PLA` / `-CF` would re-import as `'+PLA` / `'-CF` and corrupt
  // the row without this (Codex P2 on PR #649).
  "type",
  "colorName",
  "spoolType",
  "parentName",
  // `instanceId` is NOT strictly hex-validated — legacy/custom IDs (e.g.
  // `custom-id-123`, or one starting with `-`/`+`/`=`/`@`) get formula-prefixed
  // on export, so it must be unstripped symmetrically or it round-trips
  // corrupted as `'...` (#679).
  "instanceId",
]);

export function mapHeaders(headers: string[]): (keyof ImportRow | null)[] {
  return headers.map((h) => {
    const key = HEADER_MAP[h.trim().toLowerCase()];
    return key ?? null;
  });
}

export function rowToImport(
  values: unknown[],
  mapping: (keyof ImportRow | null)[],
): ImportRow {
  const row: ImportRow = {};
  for (let i = 0; i < mapping.length; i++) {
    const key = mapping[i];
    if (!key) continue;
    const val = values[i];
    if (NUM_FIELDS.has(key)) {
      (row as Record<string, unknown>)[key] = parseNum(val);
    } else if (val == null || val === "") {
      (row as Record<string, unknown>)[key] = null;
    } else {
      const str = String(val);
      (row as Record<string, unknown>)[key] = UNSANITIZE_FIELDS.has(key)
        ? unsanitizeCsvCell(str)
        : str;
    }
  }
  return row;
}

export interface SkippedRow {
  row: number;
  name: string | undefined;
  reason: string;
}

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  skippedRows: SkippedRow[];
}

/**
 * GH #628: scalar fields the CSV/XLSX import can write that participate in
 * variant→parent inheritance (the intersection of `INHERITABLE_FIELDS` in
 * `src/lib/resolveFilament.ts` with the columns the importer maps).
 * `temperatures.*` dot-keys and the `secondaryColors` array are handled
 * separately in `splitInheritedImportSet` below.
 */
const IMPORT_INHERITABLE_SCALARS = new Set<string>([
  "vendor",
  "type",
  "cost",
  "density",
  "diameter",
  "maxVolumetricSpeed",
  "spoolWeight",
  "netFilamentWeight",
  "dryingTemperature",
  "dryingTime",
  "transmissionDistance",
  "glassTempTransition",
  "heatDeflectionTemp",
  "shoreHardnessA",
  "shoreHardnessD",
  "minPrintSpeed",
  "maxPrintSpeed",
  "spoolType",
  "tdsUrl",
]);

/** Required by the Filament schema — never `$unset` on a variant (the
 *  write would fail validation). Same rule as `REQUIRED_FIELDS` in
 *  `src/lib/bambuStudioApply.ts` (Codex P2 on PR #473 round 3). */
const IMPORT_REQUIRED_FIELDS = new Set<string>(["vendor", "type"]);

/** Loosely-typed filament doc — same posture as resolveFilament. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LeanFilament = Record<string, any>;

/**
 * GH #628: the CSV/XLSX export flattens variants through `resolveFilament`
 * (correct for export — every row stands alone), but re-importing that
 * flattened row onto an EXISTING variant used to `$set` every value,
 * pinning inherited fields as local overrides and severing the GH #106
 * live-inheritance link — parent edits silently stopped propagating.
 *
 * This helper splits the prepared `$set` body for a variant row following
 * the same semantics as `setIfNotInherited` in
 * `src/lib/bambuStudioApply.ts` (GH #403 / #473):
 *
 *   - incoming value equals the parent's value → SKIP the $set so the
 *     variant keeps inheriting dynamically at read time;
 *   - …and if the variant currently carries a local override that DIFFERS
 *     from the incoming value, emit an `$unset` so inheritance resumes
 *     (a stale divergence the import just reconciled) — except for
 *     schema-required fields, which are left in place;
 *   - incoming value differs from the parent → $set normally (a genuine
 *     variant override).
 *
 * Array + nested handling:
 *   - `temperatures.*` dot-keys compare against the parent's same subfield
 *     (resolveFilament inherits each temp independently via `??`).
 *   - `secondaryColors` inherits as a WHOLE array (resolveFilament treats
 *     an empty array as "inherit"), so it's skipped only when the incoming
 *     array matches the parent's array exactly (order-sensitive — order is
 *     meaningful for multi-color rendering).
 *   - The variant-local empty-string rule mirrors resolveFilament:67-72 —
 *     a variant value of `""` counts as "missing" (already inheriting), so
 *     it never triggers an $unset.
 *
 * Pure + exported for unit tests.
 */
export function splitInheritedImportSet(
  setBody: Record<string, unknown>,
  variant: LeanFilament,
  parent: LeanFilament,
): { set: Record<string, unknown>; unset: string[] } {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];

  const hasLocalValue = (v: unknown): boolean => v != null && v !== "";

  for (const [key, incoming] of Object.entries(setBody)) {
    if (key.startsWith("temperatures.")) {
      const sub = key.slice("temperatures.".length);
      const parentVal = parent.temperatures?.[sub] ?? null;
      const variantVal = variant.temperatures?.[sub] ?? null;
      if (incoming != null && parentVal === incoming) {
        if (variantVal != null && variantVal !== incoming) unset.push(key);
        continue;
      }
      set[key] = incoming;
      continue;
    }

    if (key === "secondaryColors" && Array.isArray(incoming)) {
      const parentArr: unknown[] = Array.isArray(parent.secondaryColors)
        ? parent.secondaryColors
        : [];
      const variantArr: unknown[] = Array.isArray(variant.secondaryColors)
        ? variant.secondaryColors
        : [];
      const equalsArr = (a: unknown[], b: unknown[]) =>
        a.length === b.length && a.every((v, i) => v === b[i]);
      if (incoming.length > 0 && equalsArr(incoming, parentArr)) {
        if (variantArr.length > 0 && !equalsArr(variantArr, incoming)) {
          unset.push(key);
        }
        continue;
      }
      set[key] = incoming;
      continue;
    }

    if (IMPORT_INHERITABLE_SCALARS.has(key)) {
      const parentVal = parent[key];
      const variantVal = variant[key];
      if (incoming != null && parentVal === incoming) {
        if (IMPORT_REQUIRED_FIELDS.has(key)) {
          // Required fields (vendor/type) are never null on a variant and
          // never inherit at read time — resolveFilament always uses the
          // variant's own value — so they can't be unset to "track the
          // parent". When incoming == parent but the stored value is stale
          // (e.g. a parent+variant import where the parent's vendor/type
          // changed), still write the new value through; otherwise the
          // variant keeps a stale required value (Codex P2 on #649).
          if (variantVal !== incoming) set[key] = incoming;
          continue;
        }
        if (hasLocalValue(variantVal) && variantVal !== incoming) {
          unset.push(key);
        }
        continue;
      }
      set[key] = incoming;
      continue;
    }

    // Variant-only / non-inheritable fields (name, color, colorName,
    // instanceId, …) always write through.
    set[key] = incoming;
  }

  return { set, unset };
}

export async function upsertImportRows(
  rows: ImportRow[],
): Promise<ImportResult> {
  await dbConnect();

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const skippedRows: SkippedRow[] = [];

  // Batch-load all existing filaments by name to avoid N+1 queries.
  // GH #379: also include every Parent value, because a variant row's
  // parent may not itself appear as an import row (i.e. only the variant
  // is being imported, against an already-active parent in the DB). Also
  // project `parentId` so the parent-validity check below can reject a
  // parentName pointing at a row that's itself a variant.
  const namesToLoad = new Set<string>();
  for (const r of rows) {
    if (r.name && r.vendor && r.type) namesToLoad.add(r.name);
    if (r.parentName) {
      const trimmed = r.parentName.trim();
      if (trimmed) namesToLoad.add(trimmed);
    }
  }

  // GH #628: the projection includes the inheritable fields (scalars +
  // temperatures + secondaryColors) so the variant-update path can compare
  // incoming values against the variant's current local values without a
  // second fetch. Heavy subdocuments (spools — photoDataUrl can be MBs)
  // stay excluded.
  const INHERITANCE_PROJECTION =
    "_id name parentId _deletedAt vendor type cost density diameter " +
    "maxVolumetricSpeed spoolWeight netFilamentWeight dryingTemperature " +
    "dryingTime transmissionDistance glassTempTransition heatDeflectionTemp " +
    "shoreHardnessA shoreHardnessD minPrintSpeed maxPrintSpeed spoolType " +
    "tdsUrl temperatures secondaryColors";

  const allExisting = await Filament.find({ name: { $in: [...namesToLoad] } })
    .select(INHERITANCE_PROJECTION)
    .lean();

  // The same map carries existing rows AND filaments created earlier in
  // this same import batch — pass-2 (variant rows) resolves the `Parent`
  // column against it, so an export → reimport works even when the parent
  // row only exists because pass 1 just created it.
  type IndexEntry = {
    _id: mongoose.Types.ObjectId;
    parentId: mongoose.Types.ObjectId | null;
    /** GH #628: the projected lean doc, when this entry came from the
     *  batch-load (in-batch created/resurrected entries omit it — the
     *  inherited-field skip then falls back to plain $set, which only
     *  matters for the degenerate duplicate-name-in-one-file case). */
    doc?: LeanFilament;
  };
  const activeByName = new Map<string, IndexEntry>();
  const deletedByName = new Map<string, IndexEntry>();
  for (const doc of allExisting) {
    const entry: IndexEntry = {
      _id: doc._id,
      parentId: doc.parentId ?? null,
      doc,
    };
    if (doc._deletedAt == null) {
      activeByName.set(doc.name, entry);
    } else if (!deletedByName.has(doc.name)) {
      deletedByName.set(doc.name, entry);
    }
  }

  // GH #628: batch-load the PARENT docs of every existing active variant
  // we might update. A variant's parent is referenced by id and may not
  // appear in the import file at all, so the name-keyed load above can't
  // be relied on to have it.
  //
  // GH #649 (Codex P2): load this AFTER pass 1, not before. The two-pass
  // driver below runs every parent/standalone row in pass 1 and every
  // variant row in pass 2, and `parentById` is read ONLY in pass 2 (a
  // pass-1 row has no parentId, so the inheritance split is skipped). If
  // a parent row updated its own value in pass 1, a fresh load here lets
  // pass 2 compare the variant's incoming value against the NEW parent
  // value — so a bulk restore that changes the parent doesn't get written
  // as a local override on the variant (severing GH #106 inheritance).
  // Recomputing the id set after pass 1 also picks up parents that were
  // resurrected into `activeByName` during pass 1.
  const parentById = new Map<string, LeanFilament>();
  async function loadParentDocs() {
    parentById.clear();
    const ids = new Set<string>();
    for (const entry of activeByName.values()) {
      if (entry.parentId) ids.add(String(entry.parentId));
    }
    if (ids.size === 0) return;
    const parentDocs = await Filament.find({
      _id: { $in: [...ids] },
      _deletedAt: null,
    })
      .select(INHERITANCE_PROJECTION)
      .lean();
    for (const p of parentDocs) parentById.set(String(p._id), p);
  }
  // Initial load covers pass-1 variant updates: an existing variant whose
  // import row omits the Parent column is routed to pass 1 and still needs
  // its parent for the inheritance split. Pass 2 gets a fresh reload below.
  await loadParentDocs();

  // GH #379 (Codex P2 follow-up): share one trim between the two-pass
  // router and processRow. If routing used raw `row.parentName` while
  // processRow trimmed before checking, a whitespace-only Parent cell
  // would be routed to pass 2 (delaying processing of a row that's
  // really a standalone), and any variant referencing that row's name
  // would skip with a misleading "Parent not found".
  function trimmedParentName(row: ImportRow): string {
    return row.parentName ? row.parentName.trim() : "";
  }

  async function processRow(rowIdx: number): Promise<void> {
    const row = rows[rowIdx];
    if (!row.name || !row.vendor || !row.type) {
      const missing = [
        !row.name && "name",
        !row.vendor && "vendor",
        !row.type && "type",
      ].filter(Boolean).join(", ");
      skippedRows.push({ row: rowIdx + 2, name: row.name, reason: `Missing required field(s): ${missing}` });
      skipped++;
      return;
    }

    const existing = activeByName.get(row.name);
    const softDeleted = !existing ? deletedByName.get(row.name) : undefined;

    // GH #379: resolve the optional Parent column. Honoured ONLY when this
    // row will produce a new active filament (create or resurrect); for an
    // already-active row we silently ignore it, because re-parenting an
    // existing filament via a re-imported CSV is a surprising UX and the
    // app already exposes the relationship explicitly via "Create variant"
    // and Clone-from-parent. Self-references are blocked outright.
    let resolvedParentId: mongoose.Types.ObjectId | null = null;
    const parentName = trimmedParentName(row);
    if (parentName && !existing) {
      if (parentName === row.name) {
        skippedRows.push({
          row: rowIdx + 2,
          name: row.name,
          reason: `Parent cannot reference self`,
        });
        skipped++;
        return;
      }
      const parentEntry = activeByName.get(parentName);
      if (!parentEntry) {
        skippedRows.push({
          row: rowIdx + 2,
          name: row.name,
          reason: `Parent "${parentName}" not found among active filaments`,
        });
        skipped++;
        return;
      }
      if (parentEntry.parentId) {
        skippedRows.push({
          row: rowIdx + 2,
          name: row.name,
          reason: `Parent "${parentName}" is itself a variant — variants-of-variants are not allowed`,
        });
        skipped++;
        return;
      }
      resolvedParentId = parentEntry._id;
    }

    // Build the update doc using only fields that were actually present in the
    // import row. This prevents overwriting existing data (e.g. temperatures,
    // calibrations) with nulls when the CSV simply doesn't have those columns.
    //
    // GH #183: pre-fix `color` and `diameter` were unconditionally set with
    // defaults (`#808080` / `1.75`), so importing a row that only carried
    // name/vendor/type would silently reset an existing filament's color
    // and diameter. Only attach them to `doc` when the row supplied them;
    // for the create path the Mongoose schema-level defaults still kick in
    // for missing fields.
    const doc: Record<string, unknown> = {
      name: row.name,
      vendor: row.vendor,
      type: row.type,
    };
    if (row.color !== undefined && row.color !== "" && row.color !== null) {
      // GH #503: drop bad-hex rows into skippedRows the same way the
      // route-level validators reject them on direct API calls. Without
      // this per-row guard the new schema validator on `color` would
      // throw on the bulk save() and we'd lose the WHOLE batch's
      // accounting rather than the one bad row.
      if (!/^#[0-9A-Fa-f]{6}$/.test(String(row.color))) {
        skippedRows.push({
          row: rowIdx + 2,
          name: row.name,
          reason: `Invalid color hex "${row.color}" (expected #RRGGBB)`,
        });
        skipped++;
        return;
      }
      doc.color = row.color;
    }
    // GH #477: parse the comma-separated "Secondary Colors" column,
    // trim/dedupe-empty, validate per-entry hex, cap at 5 to match the
    // schema validator. Defensive — the schema rejects bad shapes too,
    // but the importer should produce a clean doc rather than a
    // bulk-import row that fails save.
    if (row.secondaryColors !== undefined && row.secondaryColors !== null) {
      const raw = String(row.secondaryColors).trim();
      if (raw !== "") {
        const slots = raw
          .split(",")
          .map((c) => c.trim())
          .filter((c) => /^#[0-9A-Fa-f]{6}$/.test(c))
          .slice(0, 5);
        if (slots.length > 0) {
          doc.secondaryColors = slots;
          // GH #477 (Codex P2 on PR #484 r2): preserve null primary for
          // coextruded CSV round-trips. When the export side wrote an
          // empty Color cell (coextruded filaments have `color: null`
          // per OpenPrintTag spec) AND secondaryColors has entries,
          // the import would otherwise skip setting `doc.color` and the
          // schema default "#808080" would re-introduce a phantom gray
          // primary. Explicit `null` keeps the export → import → re-
          // export round-trip identity-preserving.
          if (row.color === null || row.color === "" || row.color === undefined) {
            doc.color = null;
          }
        }
      }
    }
    if (row.diameter !== undefined && row.diameter !== null) {
      doc.diameter = row.diameter;
    }

    // Only set optional scalar fields if they were explicitly provided
    if (row.cost !== undefined) doc.cost = row.cost ?? null;
    if (row.density !== undefined) doc.density = row.density ?? null;
    if (row.maxVolumetricSpeed !== undefined) doc.maxVolumetricSpeed = row.maxVolumetricSpeed ?? null;
    if (row.spoolWeight !== undefined) doc.spoolWeight = row.spoolWeight ?? null;
    if (row.netFilamentWeight !== undefined) doc.netFilamentWeight = row.netFilamentWeight ?? null;
    if (row.dryingTemperature !== undefined) doc.dryingTemperature = row.dryingTemperature ?? null;
    if (row.dryingTime !== undefined) doc.dryingTime = row.dryingTime ?? null;
    if (row.transmissionDistance !== undefined) doc.transmissionDistance = row.transmissionDistance ?? null;
    if (row.glassTempTransition !== undefined) doc.glassTempTransition = row.glassTempTransition ?? null;
    if (row.heatDeflectionTemp !== undefined) doc.heatDeflectionTemp = row.heatDeflectionTemp ?? null;
    if (row.shoreHardnessA !== undefined) doc.shoreHardnessA = row.shoreHardnessA ?? null;
    if (row.shoreHardnessD !== undefined) doc.shoreHardnessD = row.shoreHardnessD ?? null;
    if (row.minPrintSpeed !== undefined) doc.minPrintSpeed = row.minPrintSpeed ?? null;
    if (row.maxPrintSpeed !== undefined) doc.maxPrintSpeed = row.maxPrintSpeed ?? null;
    if (row.colorName !== undefined) doc.colorName = row.colorName ?? null;
    if (row.spoolType !== undefined) doc.spoolType = row.spoolType ?? null;
    if (row.nozzleRangeMin !== undefined) doc["temperatures.nozzleRangeMin"] = row.nozzleRangeMin ?? null;
    if (row.nozzleRangeMax !== undefined) doc["temperatures.nozzleRangeMax"] = row.nozzleRangeMax ?? null;
    if (row.standbyTemp !== undefined) doc["temperatures.standby"] = row.standbyTemp ?? null;
    if (row.tdsUrl !== undefined) doc.tdsUrl = row.tdsUrl ?? null;
    if (row.instanceId) doc.instanceId = row.instanceId;

    // Only set temperature sub-fields that were present in the import
    const temps: Record<string, number | null> = {};
    if (row.nozzleTemp !== undefined) temps.nozzle = row.nozzleTemp ?? null;
    if (row.nozzleFirstLayerTemp !== undefined) temps.nozzleFirstLayer = row.nozzleFirstLayerTemp ?? null;
    if (row.bedTemp !== undefined) temps.bed = row.bedTemp ?? null;
    if (row.bedFirstLayerTemp !== undefined) temps.bedFirstLayer = row.bedFirstLayerTemp ?? null;
    if (row.nozzleRangeMin !== undefined) temps.nozzleRangeMin = row.nozzleRangeMin ?? null;
    if (row.nozzleRangeMax !== undefined) temps.nozzleRangeMax = row.nozzleRangeMax ?? null;
    if (row.standbyTemp !== undefined) temps.standby = row.standbyTemp ?? null;

    if (existing) {
      // For updates, use dot-notation for temperatures to avoid overwriting
      // sub-fields that weren't in the import
      const updateDoc = { ...doc };
      delete updateDoc.temperatures;
      let $set: Record<string, unknown> = { ...updateDoc };
      for (const [tempKey, tempVal] of Object.entries(temps)) {
        $set[`temperatures.${tempKey}`] = tempVal;
      }
      // GH #628: when the target is a VARIANT, the export flattened its
      // inherited values through resolveFilament — blindly $set-ing them
      // back would pin every inherited field as a local override and
      // sever GH #106 live inheritance. Skip fields whose incoming value
      // matches the parent (and $unset stale diverging overrides) so the
      // variant keeps tracking parent edits after a round-trip.
      const update: Record<string, unknown> = {};
      const parentDoc = existing.parentId
        ? parentById.get(String(existing.parentId))
        : undefined;
      if (parentDoc && existing.doc) {
        const split = splitInheritedImportSet($set, existing.doc, parentDoc);
        $set = split.set;
        if (split.unset.length > 0) {
          update.$unset = Object.fromEntries(split.unset.map((k) => [k, ""]));
        }
      }
      update.$set = $set;
      // GH #276: runValidators so a CSV updating an existing filament
      // (e.g. `cost = -50`) can't bypass the schema validators — the
      // sibling resurrect path below was already hardened the same way.
      await Filament.updateOne(
        { _id: existing._id },
        update,
        { runValidators: true, context: "query" },
      );
      updated++;
    } else {
      // For creates/resurrections, include temperatures as a nested object
      if (Object.keys(temps).length > 0) {
        doc.temperatures = {
          nozzle: temps.nozzle ?? null,
          nozzleFirstLayer: temps.nozzleFirstLayer ?? null,
          bed: temps.bed ?? null,
          bedFirstLayer: temps.bedFirstLayer ?? null,
          nozzleRangeMin: temps.nozzleRangeMin ?? null,
          nozzleRangeMax: temps.nozzleRangeMax ?? null,
          standby: temps.standby ?? null,
        };
      }
      if (resolvedParentId) doc.parentId = resolvedParentId;
      if (softDeleted) {
        // GH #228: the resurrect path was the only Filament write in the
        // codebase running `updateOne` without `runValidators`. The pre-
        // update hook on `tdsUrl` still fires (it's gated by the
        // `update.tdsUrl` check inside the hook, not by `runValidators`),
        // but every other schema-level validator — `cost.min`,
        // `lowStockThreshold.min`, type coercions — was bypassed. A
        // malformed re-import of a previously-trashed row could persist
        // invalid numeric fields.
        await Filament.updateOne(
          { _id: softDeleted._id },
          { ...doc, _deletedAt: null },
          { runValidators: true, context: "query" },
        );
        // GH #379: re-promote into activeByName so a later pass-2 row
        // referencing this name as Parent resolves correctly. The
        // effective parentId after resurrect is `resolvedParentId ??
        // softDeleted.parentId` because we only include `parentId` in
        // `doc` when a Parent column was provided — without it the
        // soft-deleted row's prior parentId survives unchanged, and a
        // pass-2 row that tried to point its Parent at this resurrected
        // row would otherwise wrongly skip the variant-of-variant guard.
        const effectiveParentId = resolvedParentId ?? softDeleted.parentId;
        activeByName.set(row.name, { _id: softDeleted._id, parentId: effectiveParentId });
        deletedByName.delete(row.name);
        updated++;
      } else {
        const newDoc = await Filament.create(doc);
        // GH #379: seed activeByName with the freshly-created row so a
        // later pass-2 row referencing it as Parent can resolve in-batch
        // (the round-trip case: parent and variant rows in the same CSV).
        activeByName.set(row.name, { _id: newDoc._id, parentId: resolvedParentId });
        created++;
      }
    }
  }

  // GH #627 item 2: per-row error isolation. Any error escaping a row's
  // create/update — an E11000 from the partial-unique `instanceId` index
  // (realistic trigger: re-importing an export after renaming a filament,
  // so the name misses but the carried Instance ID collides), a
  // ValidationError the pre-write guards didn't cover, a transient driver
  // error — used to abort the WHOLE batch with a bare 500 and no report
  // of the rows already committed. Route it into skippedRows instead,
  // with a named reason for duplicate-key errors (mirrors the spool
  // importer's GH #370 per-row posture).
  function importErrorReason(err: unknown): string {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === 11000
    ) {
      const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue;
      const field = keyValue ? Object.keys(keyValue)[0] : "field";
      const value = keyValue ? Object.values(keyValue)[0] : "unknown";
      return `Duplicate ${field}: "${value}" already exists`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  async function processRowSafe(rowIdx: number): Promise<void> {
    try {
      await processRow(rowIdx);
    } catch (err) {
      skippedRows.push({
        row: rowIdx + 2,
        name: rows[rowIdx].name,
        reason: importErrorReason(err),
      });
      skipped++;
    }
  }

  // GH #379: two-pass driver. Rows without a Parent column run first so
  // any new top-level filaments are present in `activeByName` by the time
  // pass-2 (variant rows) tries to resolve them. Use the same trimmed
  // view of the cell that processRow does so a whitespace-only Parent
  // resolves to pass 1 (treated as a standalone). The skipped report is
  // sorted at the end to preserve original-row order even though we
  // visited rows out of order.
  for (let i = 0; i < rows.length; i++) {
    if (!trimmedParentName(rows[i])) await processRowSafe(i);
  }
  // GH #649 (Codex P2): refresh parent values written during pass 1 before
  // the variant rows compare against them in pass 2.
  await loadParentDocs();
  for (let i = 0; i < rows.length; i++) {
    if (trimmedParentName(rows[i])) await processRowSafe(i);
  }
  skippedRows.sort((a, b) => a.row - b.row);

  return { total: rows.length, created, updated, skipped, skippedRows };
}

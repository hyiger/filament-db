import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

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
    } else {
      (row as Record<string, unknown>)[key] = val == null || val === "" ? null : String(val);
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

  const allExisting = await Filament.find({ name: { $in: [...namesToLoad] } })
    .select("_id name parentId _deletedAt")
    .lean();

  // The same map carries existing rows AND filaments created earlier in
  // this same import batch — pass-2 (variant rows) resolves the `Parent`
  // column against it, so an export → reimport works even when the parent
  // row only exists because pass 1 just created it.
  type IndexEntry = {
    _id: mongoose.Types.ObjectId;
    parentId: mongoose.Types.ObjectId | null;
  };
  const activeByName = new Map<string, IndexEntry>();
  const deletedByName = new Map<string, IndexEntry>();
  for (const doc of allExisting) {
    const entry: IndexEntry = {
      _id: doc._id,
      parentId: doc.parentId ?? null,
    };
    if (doc._deletedAt == null) {
      activeByName.set(doc.name, entry);
    } else if (!deletedByName.has(doc.name)) {
      deletedByName.set(doc.name, entry);
    }
  }

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
      const $set: Record<string, unknown> = { ...updateDoc };
      for (const [tempKey, tempVal] of Object.entries(temps)) {
        $set[`temperatures.${tempKey}`] = tempVal;
      }
      // GH #276: runValidators so a CSV updating an existing filament
      // (e.g. `cost = -50`) can't bypass the schema validators — the
      // sibling resurrect path below was already hardened the same way.
      await Filament.updateOne(
        { _id: existing._id },
        { $set },
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

  // GH #379: two-pass driver. Rows without a Parent column run first so
  // any new top-level filaments are present in `activeByName` by the time
  // pass-2 (variant rows) tries to resolve them. Use the same trimmed
  // view of the cell that processRow does so a whitespace-only Parent
  // resolves to pass 1 (treated as a standalone). The skipped report is
  // sorted at the end to preserve original-row order even though we
  // visited rows out of order.
  for (let i = 0; i < rows.length; i++) {
    if (!trimmedParentName(rows[i])) await processRow(i);
  }
  for (let i = 0; i < rows.length; i++) {
    if (trimmedParentName(rows[i])) await processRow(i);
  }
  skippedRows.sort((a, b) => a.row - b.row);

  return { total: rows.length, created, updated, skipped, skippedRows };
}

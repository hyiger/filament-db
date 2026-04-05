import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

export interface ImportRow {
  name?: string;
  vendor?: string;
  type?: string;
  color?: string;
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
}

/** Map header text (case-insensitive) to ImportRow keys */
const HEADER_MAP: Record<string, keyof ImportRow | undefined> = {
  name: "name",
  vendor: "vendor",
  type: "type",
  color: "color",
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

  // Batch-load all existing filaments by name to avoid N+1 queries
  const validNames = rows
    .filter((r) => r.name && r.vendor && r.type)
    .map((r) => r.name!);

  const allExisting = await Filament.find({ name: { $in: validNames } }).lean();

  // Build lookup maps: name → active doc, name → soft-deleted doc
  const activeByName = new Map<string, { _id: mongoose.Types.ObjectId }>();
  const deletedByName = new Map<string, { _id: mongoose.Types.ObjectId }>();
  for (const doc of allExisting) {
    if (doc._deletedAt == null) {
      activeByName.set(doc.name, doc);
    } else if (!deletedByName.has(doc.name)) {
      deletedByName.set(doc.name, doc);
    }
  }

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    if (!row.name || !row.vendor || !row.type) {
      const missing = [
        !row.name && "name",
        !row.vendor && "vendor",
        !row.type && "type",
      ].filter(Boolean).join(", ");
      skippedRows.push({ row: rowIdx + 2, name: row.name, reason: `Missing required field(s): ${missing}` });
      skipped++;
      continue;
    }

    // Build the update doc using only fields that were actually present in the
    // import row. This prevents overwriting existing data (e.g. temperatures,
    // calibrations) with nulls when the CSV simply doesn't have those columns.
    const doc: Record<string, unknown> = {
      name: row.name,
      vendor: row.vendor,
      type: row.type,
      color: row.color || "#808080",
      diameter: row.diameter ?? 1.75,
    };

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

    const existing = activeByName.get(row.name);
    if (existing) {
      // For updates, use dot-notation for temperatures to avoid overwriting
      // sub-fields that weren't in the import
      const updateDoc = { ...doc };
      delete updateDoc.temperatures;
      const $set: Record<string, unknown> = { ...updateDoc };
      for (const [tempKey, tempVal] of Object.entries(temps)) {
        $set[`temperatures.${tempKey}`] = tempVal;
      }
      await Filament.updateOne({ _id: existing._id }, { $set });
      updated++;
    } else {
      const softDeleted = deletedByName.get(row.name);
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
      if (softDeleted) {
        await Filament.updateOne(
          { _id: softDeleted._id },
          { ...doc, _deletedAt: null },
        );
        updated++;
      } else {
        await Filament.create(doc);
        created++;
      }
    }
  }

  return { total: rows.length, created, updated, skipped, skippedRows };
}

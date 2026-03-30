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

export async function upsertImportRows(
  rows: ImportRow[],
): Promise<{ total: number; created: number; updated: number; skipped: number }> {
  await dbConnect();

  let created = 0;
  let updated = 0;
  let skipped = 0;

  // Batch-load all existing filaments by name to avoid N+1 queries
  const validNames = rows
    .filter((r) => r.name && r.vendor && r.type)
    .map((r) => r.name!);

  const allExisting = await Filament.find({ name: { $in: validNames } }).lean();

  // Build lookup maps: name → active doc, name → soft-deleted doc
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeByName = new Map<string, { _id: any }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deletedByName = new Map<string, { _id: any }>();
  for (const doc of allExisting) {
    if (doc._deletedAt == null) {
      activeByName.set(doc.name, doc);
    } else if (!deletedByName.has(doc.name)) {
      deletedByName.set(doc.name, doc);
    }
  }

  for (const row of rows) {
    if (!row.name || !row.vendor || !row.type) {
      skipped++;
      continue;
    }

    const doc = {
      name: row.name,
      vendor: row.vendor,
      type: row.type,
      color: row.color || "#808080",
      diameter: row.diameter ?? 1.75,
      cost: row.cost ?? null,
      density: row.density ?? null,
      temperatures: {
        nozzle: row.nozzleTemp ?? null,
        nozzleFirstLayer: row.nozzleFirstLayerTemp ?? null,
        bed: row.bedTemp ?? null,
        bedFirstLayer: row.bedFirstLayerTemp ?? null,
      },
      maxVolumetricSpeed: row.maxVolumetricSpeed ?? null,
      spoolWeight: row.spoolWeight ?? null,
      netFilamentWeight: row.netFilamentWeight ?? null,
      tdsUrl: row.tdsUrl ?? null,
      ...(row.instanceId ? { instanceId: row.instanceId } : {}),
    };

    const existing = activeByName.get(row.name);
    if (existing) {
      await Filament.updateOne({ _id: existing._id }, doc);
      updated++;
    } else {
      const softDeleted = deletedByName.get(row.name);
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

  return { total: rows.length, created, updated, skipped };
}

import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Location from "@/models/Location";
import { resolveFilament } from "@/lib/resolveFilament";

/**
 * Row shape for the spool CSV export. Column ORDER below is chosen so the
 * leading columns round-trip through `/api/spools/import` (same headers the
 * importer recognises): `filament`, `vendor`, `label`, `totalWeight`,
 * `lotNumber`, `purchaseDate`, `openedDate`, `location`. Trailing columns
 * are export-only context the importer ignores (read-only metadata, ids).
 *
 * Filament-level fields (vendor, type, spoolWeight, netFilamentWeight) are
 * resolved through `resolveFilament` so variants emit their parent's
 * inherited values rather than blank cells. The variant's own name is kept
 * verbatim — that's the row's natural label and what the importer matches
 * against to re-attach a spool to a specific filament.
 */
export interface SpoolExportRow {
  /** Filament name as stored on the filament doc (variant name for variants). */
  filament: string;
  vendor: string;
  type: string;
  color: string;
  label: string;
  /** Current remaining grams. The Filament schema treats `totalWeight` on a
   * spool as the live remaining figure, not the original net weight. */
  totalWeight: number | null;
  /** Empty spool weight in grams (typically inherited from the filament). */
  spoolWeight: number | null;
  /** Net filament weight at full spool (typically inherited from the filament). */
  netFilamentWeight: number | null;
  lotNumber: string | null;
  /** ISO date string ("YYYY-MM-DD") or null. */
  purchaseDate: string | null;
  openedDate: string | null;
  location: string | null;
  retired: boolean;
  dryCyclesCount: number;
  /** ISO datetime of the most recent dry cycle, or null if never dried. */
  lastDriedAt: string | null;
  /** Sum of grams consumed across this spool's usageHistory. */
  usedGrams: number;
  createdAt: string | null;
  instanceId: string;
  filamentId: string;
  spoolId: string;
}

export const SPOOL_EXPORT_COLUMNS: { key: keyof SpoolExportRow; header: string }[] = [
  // Round-trippable columns first — these match `/api/spools/import` exactly.
  { key: "filament", header: "filament" },
  { key: "vendor", header: "vendor" },
  { key: "label", header: "label" },
  { key: "totalWeight", header: "totalWeight" },
  { key: "lotNumber", header: "lotNumber" },
  { key: "purchaseDate", header: "purchaseDate" },
  { key: "openedDate", header: "openedDate" },
  { key: "location", header: "location" },
  // Export-only context columns.
  { key: "type", header: "type" },
  { key: "color", header: "color" },
  { key: "spoolWeight", header: "spoolWeight" },
  { key: "netFilamentWeight", header: "netFilamentWeight" },
  { key: "retired", header: "retired" },
  { key: "dryCyclesCount", header: "dryCyclesCount" },
  { key: "lastDriedAt", header: "lastDriedAt" },
  { key: "usedGrams", header: "usedGrams" },
  { key: "createdAt", header: "createdAt" },
  { key: "instanceId", header: "instanceId" },
  { key: "filamentId", header: "filamentId" },
  { key: "spoolId", header: "spoolId" },
];

function isoDateOnly(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function isoDateTime(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export async function getSpoolExportRows(): Promise<SpoolExportRow[]> {
  await dbConnect();

  const [filaments, locations] = await Promise.all([
    Filament.find({ _deletedAt: null }).sort({ name: 1 }).lean(),
    Location.find({ _deletedAt: null }).lean(),
  ]);

  // Build parent lookup so variants resolve inherited filament-level fields
  // (vendor, type, spoolWeight, netFilamentWeight). Spool-level fields are
  // never inherited — they belong to the spool subdoc itself.
  const parentMap = new Map<string, (typeof filaments)[number]>();
  for (const f of filaments) {
    if (!f.parentId) {
      parentMap.set(f._id.toString(), f);
    }
  }

  const locationNameById = new Map<string, string>();
  for (const l of locations) {
    locationNameById.set(l._id.toString(), l.name as string);
  }

  const rows: SpoolExportRow[] = [];
  for (const filament of filaments) {
    const resolved = filament.parentId
      ? resolveFilament(filament, parentMap.get(filament.parentId.toString()))
      : filament;

    for (const spool of filament.spools || []) {
      // Sum grams used (positive deltas only — the schema enforces grams >= 0).
      const usedGrams = (spool.usageHistory || []).reduce(
        (sum: number, u: { grams: number }) => sum + (u.grams || 0),
        0,
      );

      // Latest dry cycle by date — entries are pushed chronologically by the
      // UI but tolerate manual reordering by picking the max explicitly.
      let lastDried: Date | null = null;
      for (const c of spool.dryCycles || []) {
        const d = c.date instanceof Date ? c.date : new Date(c.date);
        if (Number.isNaN(d.getTime())) continue;
        if (!lastDried || d > lastDried) lastDried = d;
      }

      const locationName = spool.locationId
        ? locationNameById.get(spool.locationId.toString()) ?? null
        : null;

      rows.push({
        filament: filament.name,
        vendor: resolved.vendor ?? "",
        type: resolved.type ?? "",
        color: filament.color ?? "",
        label: spool.label ?? "",
        totalWeight: typeof spool.totalWeight === "number" ? spool.totalWeight : null,
        spoolWeight:
          typeof resolved.spoolWeight === "number" ? resolved.spoolWeight : null,
        netFilamentWeight:
          typeof resolved.netFilamentWeight === "number"
            ? resolved.netFilamentWeight
            : null,
        lotNumber: spool.lotNumber ?? null,
        purchaseDate: isoDateOnly(spool.purchaseDate),
        openedDate: isoDateOnly(spool.openedDate),
        location: locationName,
        retired: !!spool.retired,
        dryCyclesCount: (spool.dryCycles || []).length,
        lastDriedAt: isoDateTime(lastDried),
        usedGrams,
        createdAt: isoDateTime(spool.createdAt),
        instanceId: filament.instanceId ?? "",
        filamentId: filament._id.toString(),
        spoolId: spool._id ? spool._id.toString() : "",
      });
    }
  }

  return rows;
}

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
  /** Empty for a legacy roll — it has no spool subdocument to name. */
  spoolId: string;
  /** GH #1111: true when this row was synthesized from a legacy single-spool
   *  filament (empty `spools[]`, stock on the filament's own `totalWeight`)
   *  rather than read from a real spool subdocument. */
  legacyRoll: boolean;
  /**
   * Parent/variant relationship surfaced for export clarity — matches the
   * filament-level export columns (see exportFilaments.ts). `parentName`
   * is the parent filament's name when the spool belongs to a variant
   * (empty for roots/standalones); `variantCount` is how many variants
   * the spool's filament has (>0 only when the spool belongs to a parent
   * with variants).
   */
  parentName: string | null;
  variantCount: number;
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
  // GH #1111: true for a synthesized legacy single-spool row (no spools[]
  // subdocument). Export-only — the importer ignores unknown columns — so the
  // reader can tell a real spool from a filament-level one.
  { key: "legacyRoll", header: "legacyRoll" },
  // Parent/variant context — matches the filament-level export columns.
  // GH #515.3: header text aligns with exportFilaments.ts's
  // "Parent" / "Variant Count" — pre-fix the spool exporter emitted
  // camelCase headers while filament-export used Title-Case. Schema
  // keys stay camelCase to match the SpoolExportRow interface; only
  // the CSV header text shifts. Filament-export tests pin
  // `parentName` and `variantCount` as object keys but not header
  // text, so this is shape-safe.
  { key: "parentName", header: "Parent" },
  { key: "variantCount", header: "Variant Count" },
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

  // Count variants per parent for the variantCount column. A spool belonging
  // to a parent that has variants gets the count; variants and standalones
  // get 0. Built once and looked up by filament id below.
  const variantCountByParent = new Map<string, number>();
  for (const f of filaments) {
    if (f.parentId) {
      const key = f.parentId.toString();
      variantCountByParent.set(key, (variantCountByParent.get(key) ?? 0) + 1);
    }
  }

  const locationNameById = new Map<string, string>();
  for (const l of locations) {
    locationNameById.set(l._id.toString(), l.name as string);
  }

  const rows: SpoolExportRow[] = [];
  for (const filament of filaments) {
    const parentDoc = filament.parentId
      ? parentMap.get(filament.parentId.toString())
      : undefined;
    const resolved = filament.parentId
      ? resolveFilament(filament, parentDoc)
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
        // #732 Phase 5: the SPOOL's own id (per-spool identity), not the
        // filament-level id — so a spool CSV round-trips each roll's id.
        instanceId: spool.instanceId ?? "",
        filamentId: filament._id.toString(),
        spoolId: spool._id ? spool._id.toString() : "",
        parentName: parentDoc?.name ?? null,
        variantCount:
          variantCountByParent.get(filament._id.toString()) ?? 0,
        legacyRoll: false,
      });
    }

    // GH #1111: a LEGACY single-spool filament — stock tracked on the filament
    // itself, with no spools[] subdocument — contributed no rows at all, so it
    // vanished from the export while /inventory, the dashboard and the home
    // list all counted it. Every other spool surface has this fallback
    // (inventoryStats, the by-location aggregation, the dashboard); the
    // exporter was the only holdout.
    //
    // It matters more than a missing row: the filament-level export carries no
    // `totalWeight` column and the filament importer has no `totalWeight`
    // handling, so before this a legacy roll's remaining weight survived only a
    // full snapshot. "Export both CSVs, wipe, re-import" lost it silently.
    if ((filament.spools?.length ?? 0) === 0 && typeof filament.totalWeight === "number") {
      rows.push({
        filament: filament.name,
        vendor: resolved.vendor ?? "",
        type: resolved.type ?? "",
        color: filament.color ?? "",
        label: "",
        // The filament's OWN field, never `resolved` — totalWeight is in
        // VARIANT_ONLY_FIELDS and is deliberately not inherited.
        totalWeight: filament.totalWeight,
        // These two ARE inheritable, so read them resolved.
        spoolWeight:
          typeof resolved.spoolWeight === "number" ? resolved.spoolWeight : null,
        netFilamentWeight:
          typeof resolved.netFilamentWeight === "number"
            ? resolved.netFilamentWeight
            : null,
        lotNumber: null,
        purchaseDate: null,
        openedDate: null,
        location: null,
        retired: false,
        dryCyclesCount: 0,
        lastDriedAt: null,
        usedGrams: 0,
        createdAt: isoDateTime(filament.createdAt),
        // #732 Phase-1 carry-over: a legacy roll's durable identity IS the
        // filament's instanceId — it is what its printed label and NFC tag
        // encode. Emitting it keeps those resolving to the exact roll after
        // the migration, instead of the importer minting a new id and leaving
        // every label to fall back to the filament with matchedSpool: null.
        //
        // Honored on import: `isSpoolInstanceIdTaken` excludes the owning
        // filament, and a legacy filament has no spool holding the id yet
        // (pinned by "honors a cell equal to the filament's top-level id on
        // the CREATE path"). The collision guard only fires once a spool
        // already carries it — i.e. on a re-import after migration, where a
        // loud refusal is the correct outcome anyway.
        instanceId: filament.instanceId ?? "",
        filamentId: filament._id.toString(),
        // Deliberately empty: there is no spool subdocument, and putting the
        // filament id here would be an outright lie that the importer would
        // then fail to resolve.
        spoolId: "",
        parentName: parentDoc?.name ?? null,
        variantCount:
          variantCountByParent.get(filament._id.toString()) ?? 0,
        legacyRoll: true,
      });
    }
  }

  return rows;
}

/**
 * Pure transforms for the client-side shared-catalog import
 * (`src/app/share/[slug]/page.tsx`). Extracted here so the id-remap + strip
 * logic is unit-testable independent of the `"use client"` component.
 *
 * GH #956: a published catalog serialises its docs as raw lean documents that
 * still carry SOURCE-DB ObjectIds — filament `parentId`, printer
 * `installedNozzles` / `installedBedTypes` / `amsSlots`. Those ids don't exist
 * on the destination, so POSTing them verbatim 400s (parent-not-found /
 * ref-existence checks) and the import silently drops variants and degrades
 * printer-scoped calibrations to `printer: null`. Every reference must be
 * remapped to the freshly-created local record (or stripped) before POST.
 */

type IdMap = Map<string, string>;

export interface ShareImportFilament {
  _id: string;
  name: string;
  parentId?: unknown;
  compatibleNozzles?: unknown[];
  calibrations?: Array<{
    nozzle?: unknown;
    printer?: unknown;
    bedType?: unknown;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

export interface ShareImportPrinter {
  _id: string;
  name: string;
  installedNozzles?: unknown[];
  installedBedTypes?: unknown[];
  amsSlots?: unknown[];
  [k: string]: unknown;
}

const mapId = (v: unknown, m: IdMap): string | undefined =>
  v == null ? undefined : m.get(String(v));

/**
 * Split filaments into roots (imported FIRST, to build the source→local id map)
 * and variants (imported SECOND, with `parentId` remapped through that map).
 * A variant is any filament carrying a truthy `parentId`.
 */
export function partitionByParent<T extends ShareImportFilament>(
  items: T[],
): { roots: T[]; variants: T[] } {
  const roots: T[] = [];
  const variants: T[] = [];
  for (const item of items) {
    if (item.parentId) variants.push(item);
    else roots.push(item);
  }
  return { roots, variants };
}

/**
 * Build the POST body for a filament import: strip the source `_id`, remap
 * `compatibleNozzles` + each calibration's nozzle/printer/bedType through the
 * id maps (dropping unresolved refs, and dropping a calibration that loses its
 * required nozzle), and set `parentId` explicitly:
 *   - `undefined` (a root)  → the key is removed (create a root filament),
 *   - a string  (a variant) → the remapped LOCAL parent id.
 * There is deliberately no "keep the source parentId" path — a raw source id
 * would 400 on the destination.
 */
export function buildFilamentImportBody(
  f: ShareImportFilament,
  nozzleMap: IdMap,
  printerMap: IdMap,
  bedTypeMap: IdMap,
  parentId: string | undefined,
): Record<string, unknown> {
  const compatibleNozzles = (f.compatibleNozzles || [])
    .map((n) => mapId(n, nozzleMap))
    .filter((x): x is string => Boolean(x));
  const calibrations = (f.calibrations || [])
    .map((cal) => ({
      ...cal,
      nozzle: mapId(cal.nozzle, nozzleMap) ?? null,
      printer: mapId(cal.printer, printerMap) ?? null,
      bedType: mapId(cal.bedType, bedTypeMap) ?? null,
    }))
    // Calibrations require a nozzle; drop any whose nozzle didn't resolve.
    .filter((cal) => cal.nozzle);
  const body: Record<string, unknown> = {
    ...f,
    _id: undefined,
    compatibleNozzles,
    calibrations,
  };
  if (parentId === undefined) delete body.parentId;
  else body.parentId = parentId;
  return body;
}

/**
 * Build the POST body for a printer import: strip the source `_id`, remap
 * `installedNozzles` / `installedBedTypes` through the id maps (dropping
 * unresolved entries), and strip `amsSlots` entirely — its spool/filament ids
 * are source-DB-specific and meaningless on the destination (the publish route
 * already strips spools for the same reason). Requires the nozzle/bed-type
 * maps, so the caller must import nozzles + bed types BEFORE printers.
 */
export function buildPrinterImportBody(
  p: ShareImportPrinter,
  nozzleMap: IdMap,
  bedTypeMap: IdMap,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...p, _id: undefined };
  if (Array.isArray(p.installedNozzles)) {
    body.installedNozzles = p.installedNozzles
      .map((n) => mapId(n, nozzleMap))
      .filter((x): x is string => Boolean(x));
  }
  if (Array.isArray(p.installedBedTypes)) {
    body.installedBedTypes = p.installedBedTypes
      .map((b) => mapId(b, bedTypeMap))
      .filter((x): x is string => Boolean(x));
  }
  delete body.amsSlots;
  return body;
}

/**
 * Shared resolution + filename helpers for the single-filament slicer
 * export routes:
 *
 *   GET /api/filaments/{id}/prusaslicer   → <name>.ini
 *   GET /api/filaments/{id}/orcaslicer    → <name>.json
 *   GET /api/filaments/{id}/bambustudio   → <name>.json
 *
 * The bundle routes (`/api/filaments/prusaslicer`, `/orcaslicer`) export
 * every filament and are consumed by the slicer FilamentDB modules. These
 * per-filament routes exist so the filament detail page can offer a
 * one-click "export this filament" download without the user hand-editing
 * a multi-filament bundle.
 */

import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentDoc = Record<string, any>;

const POPULATE_PATHS = [
  "calibrations.nozzle",
  "calibrations.printer",
  "calibrations.bedType",
  // #872: needed so the PrusaSlicer export can build a
  // compatible_printers_condition from the compatible nozzle diameters.
  "compatibleNozzles",
] as const;

/**
 * Look up a single filament by ObjectId (or URL-encoded name) and return
 * it with parent inheritance resolved — so a variant exports its full
 * effective values, not just its own overrides. Returns `null` when no
 * matching active filament exists.
 *
 * Mirrors the resolution the bundle routes do, but for exactly one
 * filament. Calibration references are populated because the slicer
 * bundle generators read nozzle / printer / bed-type names off them.
 */
export async function resolveFilamentForExport(
  idOrName: string,
): Promise<FilamentDoc | null> {
  // `idOrName` comes straight from the Next.js App Router `params`, which
  // is ALREADY URL-decoded. Do NOT call decodeURIComponent on it again:
  // a valid filament name containing a literal `%` (e.g. "ABS 100%")
  // arrives here decoded, and a second decode throws URIError on the
  // dangling `%` — turning a valid export into a 500 (Codex P2 on
  // PR #247).

  // GH #950 / #867: a 24-hex param is an ObjectId and is AUTHORITATIVE — try it
  // FIRST, falling back to a name lookup only when that _id misses (a preset
  // legitimately NAMED with 24 hex chars). Name-first would let such a name
  // shadow another filament's real _id.
  let filament: FilamentDoc | null = null;
  if (/^[a-f0-9]{24}$/i.test(idOrName)) {
    filament = (await withPopulate(
      Filament.findOne({ _id: idOrName, _deletedAt: null }),
    ).lean()) as FilamentDoc | null;
  }
  if (!filament) {
    filament = (await withPopulate(
      Filament.findOne({ name: idOrName, _deletedAt: null }),
    ).lean()) as FilamentDoc | null;
  }

  if (!filament) return null;

  // Variant → resolve against the parent so inherited fields (cost,
  // temperatures, density, etc.) materialise in the exported preset.
  if (filament.parentId) {
    const parent = (await withPopulate(
      Filament.findOne({ _id: filament.parentId, _deletedAt: null }),
    ).lean()) as FilamentDoc | null;
    if (parent) {
      return resolveFilament(filament, parent);
    }
  }

  return filament;
}

/** Apply the standard calibration-ref populate chain to a query. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withPopulate(query: any) {
  for (const path of POPULATE_PATHS) {
    query = query.populate(path);
  }
  return query;
}

/**
 * Turn a filament name into a safe download filename stem. Strips path
 * separators and characters that browsers / OSes choke on, collapses
 * whitespace to underscores, and caps the length. Always returns a
 * non-empty string (`"filament"` when the name reduces to nothing).
 */
export function exportFilenameStem(name: string): string {
  const cleaned = (name || "")
    .replace(/[/\\?%*:|"<>]/g, "") // illegal filename chars
    .replace(/\s+/g, "_")
    .trim()
    .slice(0, 80)
    // slice() can leave a trailing underscore mid-collapse — tidy up.
    .replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "filament";
}

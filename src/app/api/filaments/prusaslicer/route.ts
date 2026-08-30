import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Printer from "@/models/Printer";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
import { liveTemplateIds, excludeTemplates } from "@/lib/templateExportFilter";
import {
  resolvePrinterScope,
  isOfferableOnPrinter,
  unknownPrinterBody,
} from "@/lib/slicerExportScope";
import { generatePrusaSlicerBundle, collapsePerNozzleImportSections } from "@/lib/prusaSlicerBundle";
import { parseIniFilaments } from "@/lib/parseIni";
import { upsertIniFilament } from "@/lib/iniImportApply";
import { checkContentLength, errorResponse, MAX_UPLOAD_SIZE } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/** 24-hex ObjectId, for validating user-supplied `?ids=` before a `$in`. */
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * GET /api/filaments/prusaslicer
 *
 * Export filaments as a PrusaSlicer-compatible INI config bundle.
 * All structured Filament DB fields are mapped to their PrusaSlicer
 * equivalents (filament_type, temperature, bed_temperature, etc.)
 * and merged with the settings passthrough bag.
 *
 * Query params:
 *   type   — filter by filament type (e.g. PLA, PETG)
 *   vendor — filter by vendor name
 *   ids    — comma-separated list of filament IDs
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const { searchParams } = request.nextUrl;
    const typeFilter = searchParams.get("type");
    const vendorFilter = searchParams.get("vendor");
    const idsFilter = searchParams.get("ids");

    // Narrow the bundle to what this printer can actually run. Opt-in: no
    // param leaves the response exactly as it was. Resolved BEFORE the heavy
    // query so a typo costs a 400, not a silently empty bundle.
    const scope = await resolvePrinterScope(Printer, searchParams.get("printer"));
    if (scope.kind === "not-found") {
      return NextResponse.json(unknownPrinterBody(scope.raw), { status: 400 });
    }

    // Build query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = { _deletedAt: null };
    if (typeFilter) query.type = typeFilter;
    if (vendorFilter) query.vendor = vendorFilter;
    if (idsFilter) {
      // Validate each id before the $in — an invalid value would CastError
      // into a 500 (#677).
      const ids = idsFilter.split(",").map((id) => id.trim()).filter(Boolean);
      const bad = ids.filter((id) => !OBJECT_ID_RE.test(id));
      if (bad.length > 0) {
        return errorResponse(`Invalid filament ID(s): ${bad.join(", ")}`, 400);
      }
      query._id = { $in: ids };
    }

    const filaments = await Filament.find(query)
      .sort({ name: 1 })
      // GH #1005 F2: the bundle mapping never reads spools — exclude the
      // array so a slicer startup doesn't deserialize photo blobs + ledgers.
      .select("-spools")
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .populate("calibrations.bedType")
      .populate("compatibleNozzles") // #872: diameters for compatible_printers_condition
      .lean();

    // Build parent lookup for resolving variants
    const parentMap = new Map<string, (typeof filaments)[number]>();
    for (const f of filaments) {
      if (!f.parentId) {
        parentMap.set(f._id.toString(), f);
      }
    }

    // GH: a template is not printable stock, so it must not reach the slicer as
    // a selectable preset. It still has to stay in `parentMap` above — its
    // variants resolve through it — so the filter applies to what is EMITTED,
    // not to what was loaded.
    const templateIds = await liveTemplateIds(Filament);
    const exportable = excludeTemplates(filaments, templateIds);

    // If a variant's parent isn't in the filtered results, batch-fetch missing parents
    const missingParentIds = [
      ...new Set(
        exportable
          .filter((f) => f.parentId && !parentMap.has(f.parentId.toString()))
          .map((f) => f.parentId!.toString()),
      ),
    ];
    if (missingParentIds.length > 0) {
      const missingParents = await Filament.find({
        _id: { $in: missingParentIds },
        _deletedAt: null,
      })
        .select("-spools") // GH #1005 F2: bundle generation never reads spools
        .populate("calibrations.nozzle")
        .populate("calibrations.printer")
        .populate("calibrations.bedType")
        .populate("compatibleNozzles") // #872
        .lean();
      for (const parent of missingParents) {
        parentMap.set(parent._id.toString(), parent);
      }
    }

    // Resolve variants
    const resolvedAll = exportable.map((f) =>
      f.parentId
        ? resolveFilament(f, parentMap.get(f.parentId.toString()))
        : f,
    );

    // Filter on the RESOLVED docs: compatibleNozzles is whole-array fallback,
    // so an inheriting variant's effective set only exists after resolution.
    const resolved =
      scope.kind === "scoped"
        ? resolvedAll.filter((f) => isOfferableOnPrinter(f, scope.nozzleIds))
        : resolvedAll;

    const bundle = generatePrusaSlicerBundle(resolved);

    return new NextResponse(bundle, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition":
          'attachment; filename="FilamentDB_PrusaSlicer.ini"',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to export PrusaSlicer bundle", detail: message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/filaments/prusaslicer
 *
 * Import a PrusaSlicer INI config bundle. Creates or updates filaments
 * in the database from [filament:Name] sections.
 *
 * Accepts: text/plain INI content in request body
 * Returns: { created: number, updated: number, filaments: string[] }
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  const sizeError = checkContentLength(request);
  if (sizeError) return sizeError;

  try {
    await dbConnect();

    const body = await request.text();
    // Byte length, not String.length — a non-ASCII UTF-8 body can exceed
    // 10 MB of bytes while under the char count when Content-Length was
    // missing/wrong.
    if (Buffer.byteLength(body, "utf8") > MAX_UPLOAD_SIZE) {
      return errorResponse("Request body too large. Maximum is 10 MB.", 413);
    }
    if (!body.trim()) {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    // #872: fold Filament DB's own per-nozzle suffixed sections back into
    // their base filament so a bundle round-trip updates the original
    // instead of spawning "<base> <Ø> <type>" orphans. NOTE the per-nozzle
    // calibration model is NOT reconstructed from a flat bundle — by
    // design; Settings → Backup & Restore is the lossless path.
    const parsed = collapsePerNozzleImportSections(parseIniFilaments(body));
    if (parsed.length === 0) {
      return NextResponse.json(
        { error: "No [filament:...] sections found" },
        { status: 400 },
      );
    }

    // GH #297: cap the bundle size (mirrors parseCsv's 10k maxRows).
    const MAX_IMPORT_FILAMENTS = 10_000;
    if (parsed.length > MAX_IMPORT_FILAMENTS) {
      return NextResponse.json(
        {
          error: `Import too large: ${parsed.length} sections exceeds the ${MAX_IMPORT_FILAMENTS} limit.`,
        },
        { status: 400 },
      );
    }

    let created = 0;
    let updated = 0;
    const names: string[] = [];
    const errors: string[] = [];

    for (const f of parsed) {
      // Skip internal/abstract presets (PrusaSlicer uses *name* convention)
      if (f.name.startsWith("*") && f.name.endsWith("*")) continue;

      // GH #872: wrap each row so one bad section degrades to a per-row
      // error instead of 500-ing the whole bundle (mirrors
      // /api/filaments/import's per-row resilience).
      try {
        // GH #951: the three-phase atomic upsert (active → resurrect-trashed
        // → create/race) lives in `upsertIniFilament`, shared with
        // POST /api/filaments/import, and preserves variant→parent
        // inheritance — the export flattens inherited values through
        // resolveFilament, so re-importing must NOT pin them as local
        // overrides (severing GH #106 live inheritance).
        const outcome = await upsertIniFilament(f, {
          // GH #605: a name-matched TEMPLATE target had per-variant fields
          // stripped rather than re-materialized — reported as a per-row
          // note; the row itself still imported.
          onTemplateFieldsStripped: (fields) =>
            errors.push(
              `${f.name}: skipped ${fields.join(", ")} — the local filament is a template (inventory and color live on its variants)`,
            ),
        });
        if (outcome === "created") created++;
        else updated++;
        names.push(f.name);
      } catch (rowErr) {
        const msg = rowErr instanceof Error ? rowErr.message : String(rowErr);
        errors.push(`${f.name}: ${msg}`);
      }
    }

    const result: Record<string, unknown> = { created, updated, filaments: names };
    if (errors.length > 0) result.errors = errors;
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to import PrusaSlicer bundle", detail: message },
      { status: 500 },
    );
  }
}

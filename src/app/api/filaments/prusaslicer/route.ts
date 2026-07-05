import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
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

    // Build query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = { _deletedAt: null };
    if (typeFilter) query.type = typeFilter;
    if (vendorFilter) query.vendor = vendorFilter;
    if (idsFilter) {
      // Validate each id is a real ObjectId before the $in — an invalid value
      // would otherwise throw a Mongoose CastError and 500 (#677).
      const ids = idsFilter.split(",").map((id) => id.trim()).filter(Boolean);
      const bad = ids.filter((id) => !OBJECT_ID_RE.test(id));
      if (bad.length > 0) {
        return errorResponse(`Invalid filament ID(s): ${bad.join(", ")}`, 400);
      }
      query._id = { $in: ids };
    }

    const filaments = await Filament.find(query)
      .sort({ name: 1 })
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

    // If a variant's parent isn't in the filtered results, batch-fetch missing parents
    const missingParentIds = [
      ...new Set(
        filaments
          .filter((f) => f.parentId && !parentMap.has(f.parentId.toString()))
          .map((f) => f.parentId!.toString()),
      ),
    ];
    if (missingParentIds.length > 0) {
      const missingParents = await Filament.find({
        _id: { $in: missingParentIds },
        _deletedAt: null,
      })
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
    const resolved = filaments.map((f) =>
      f.parentId
        ? resolveFilament(f, parentMap.get(f.parentId.toString()))
        : f,
    );

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
    // Byte length, not String.length (UTF-16 code units) — a non-ASCII UTF-8
    // body can exceed 10 MB of bytes while staying under the char count when
    // Content-Length was missing/wrong (Codex P2 on PR #685).
    if (Buffer.byteLength(body, "utf8") > MAX_UPLOAD_SIZE) {
      return errorResponse("Request body too large. Maximum is 10 MB.", 413);
    }
    if (!body.trim()) {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    // #872: fold Filament DB's own per-nozzle suffixed sections back into their
    // base filament so a bundle round-trip updates the original instead of
    // spawning "<base> <Ø> <type>" orphan records (Codex P2). NOTE the per-nozzle
    // calibration model is NOT reconstructed from a flat bundle — a fresh import of
    // a multi-nozzle export lands the base filament without its baked temps /
    // calibrations by design; Settings → Backup & Restore is the lossless path.
    const parsed = collapsePerNozzleImportSections(parseIniFilaments(body));
    if (parsed.length === 0) {
      return NextResponse.json(
        { error: "No [filament:...] sections found" },
        { status: 400 },
      );
    }

    // GH #297: cap the bundle size — a huge bundle would otherwise drive
    // unbounded sequential writes. Mirrors parseCsv's 10k maxRows.
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

      // GH #872 (Codex P2): wrap each row so one bad section degrades to a per-row
      // error instead of 500-ing the whole bundle — e.g. a partial per-nozzle
      // section collapsed without its required vendor/type fails create validation.
      // Mirrors the /api/filaments/import route's per-row resilience.
      try {
        // GH #951: the three-phase atomic upsert (active → resurrect-trashed →
        // create/race) lives in `upsertIniFilament`, shared with
        // POST /api/filaments/import, and preserves variant→parent inheritance
        // — the export flattens a variant's inherited values through
        // resolveFilament, so re-importing must NOT pin them as local overrides
        // (that would sever GH #106 live inheritance). See src/lib/iniImportApply.ts.
        const outcome = await upsertIniFilament(f);
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

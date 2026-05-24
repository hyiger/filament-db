import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
import { generatePrusaSlicerBundle } from "@/lib/prusaSlicerBundle";
import { parseIniFilaments } from "@/lib/parseIni";
import { isDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

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
      query._id = { $in: idsFilter.split(",").map((id) => id.trim()) };
    }

    const filaments = await Filament.find(query)
      .sort({ name: 1 })
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .populate("calibrations.bedType")
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

  try {
    await dbConnect();

    const body = await request.text();
    if (!body.trim()) {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    const parsed = parseIniFilaments(body);
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

    for (const f of parsed) {
      // Skip internal/abstract presets (PrusaSlicer uses *name* convention)
      if (f.name.startsWith("*") && f.name.endsWith("*")) continue;

      const doc = {
        name: f.name,
        vendor: f.vendor,
        type: f.type,
        color: f.color,
        cost: f.cost,
        density: f.density,
        diameter: f.diameter,
        temperatures: f.temperatures,
        maxVolumetricSpeed: f.maxVolumetricSpeed,
        inherits: f.inherits,
        settings: f.settings,
      };

      // GH #327 (Codex): each branch is a single atomic operation so
      // there is no findOne→write window for a concurrent soft-delete
      // or insert to slip through.

      // 1) Update an existing ACTIVE filament with this name.
      const activeUpdated = await Filament.findOneAndUpdate(
        { name: f.name, _deletedAt: null },
        { $set: doc },
        { runValidators: true, context: "query", returnDocument: "after" },
      );
      if (activeUpdated) {
        updated++;
      } else {
        // 2) GH #297: a trashed (non-purged) filament owning this name
        // is resurrected-and-updated rather than shadowed by a duplicate
        // active row — a duplicate would strand the trashed one (its
        // restore would 409 forever on the name conflict).
        const trashedResurrected = await Filament.findOneAndUpdate(
          { name: f.name, _deletedAt: { $ne: null }, _purged: { $ne: true } },
          { $set: { ...doc, _deletedAt: null } },
          { runValidators: true, context: "query", returnDocument: "after" },
        );
        if (trashedResurrected) {
          updated++;
        } else {
          // 3) Create; retry-on-duplicate. Two concurrent imports of the
          // same new name can both pass the lookups above and race into
          // create(); the partial-unique index throws E11000 for the
          // loser. Resolve that as an update so parallel identical
          // imports stay idempotent instead of 500-ing.
          try {
            await Filament.create(doc);
            created++;
          } catch (createErr) {
            if (!isDuplicateKeyError(createErr)) throw createErr;
            const raced = await Filament.findOneAndUpdate(
              { name: f.name, _deletedAt: null },
              { $set: doc },
              { runValidators: true, context: "query", returnDocument: "after" },
            );
            if (!raced) throw createErr;
            updated++;
          }
        }
      }

      names.push(f.name);
    }

    return NextResponse.json({ created, updated, filaments: names });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to import PrusaSlicer bundle", detail: message },
      { status: 500 },
    );
  }
}

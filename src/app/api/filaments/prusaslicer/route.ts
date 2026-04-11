import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
import { generatePrusaSlicerBundle } from "@/lib/prusaSlicerBundle";
import { parseIniFilaments } from "@/lib/parseIni";

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

    let created = 0;
    let updated = 0;
    const names: string[] = [];

    for (const f of parsed) {
      // Skip internal/abstract presets (PrusaSlicer uses *name* convention)
      if (f.name.startsWith("*") && f.name.endsWith("*")) continue;

      const existing = await Filament.findOne({
        name: f.name,
        _deletedAt: null,
      });

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

      if (existing) {
        await Filament.updateOne({ _id: existing._id }, { $set: doc });
        updated++;
      } else {
        await Filament.create(doc);
        created++;
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

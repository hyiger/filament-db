import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
import { generatePrusaSlicerBundle } from "@/lib/prusaSlicerBundle";

export async function GET() {
  try {
    await dbConnect();

    const filaments = await Filament.find({ _deletedAt: null })
      .sort({ name: 1 })
      // GH #1005 F2: the slicer bundle mapping never reads spools; exclude the
      // whole array (photoDataUrl blobs + usageHistory ledgers).
      .select("-spools")
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .populate("calibrations.bedType")
      .populate("compatibleNozzles") // #872: diameters for compatible_printers_condition
      .lean();

    // Build a parent lookup for resolving variants
    const parentMap = new Map<string, typeof filaments[number]>();
    for (const f of filaments) {
      if (!f.parentId) {
        parentMap.set(f._id.toString(), f);
      }
    }

    // Resolve inherited values for variants
    const resolved = filaments.map((f) =>
      f.parentId
        ? resolveFilament(f, parentMap.get(f.parentId.toString()))
        : f,
    );

    const iniContent = generatePrusaSlicerBundle(resolved);

    // GH #341: legacy alias for /api/filaments/prusaslicer (same INI bundle
    // output, kept for backward compatibility); charset aligned with that
    // route so the two endpoints serving the same bytes agree.
    return new NextResponse(iniContent, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="filament_profiles.ini"',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to export filaments", detail: message },
      { status: 500 },
    );
  }
}

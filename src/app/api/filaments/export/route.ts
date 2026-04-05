import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import { resolveFilament } from "@/lib/resolveFilament";
import { generatePrusaSlicerBundle } from "@/lib/prusaSlicerBundle";

export async function GET() {
  try {
    await dbConnect();

    const filaments = await Filament.find({ _deletedAt: null })
      .sort({ name: 1 })
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
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

    return new NextResponse(iniContent, {
      headers: {
        "Content-Type": "text/plain",
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

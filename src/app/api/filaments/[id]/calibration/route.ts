import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";

/**
 * GET /api/filaments/{id}/calibration?nozzle_diameter=0.4&bed_type=Smooth+PEI
 *
 * Returns calibration data for a specific filament and nozzle diameter.
 * Looks up the filament by name (URL-encoded) or ObjectId, then finds
 * the calibration entry whose nozzle diameter matches the query param.
 *
 * Optional bed_type param filters by bed type name or ID.
 * Falls back to a calibration without bed type if no bed-type-specific match.
 *
 * Used by PrusaSlicer to auto-adjust filament settings when the user
 * switches printer presets (which have different nozzle sizes).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const { searchParams } = request.nextUrl;
    const nozzleDiameter = parseFloat(searchParams.get("nozzle_diameter") || "0");

    if (!nozzleDiameter || isNaN(nozzleDiameter)) {
      return NextResponse.json(
        { error: "nozzle_diameter query param required (e.g. ?nozzle_diameter=0.4)" },
        { status: 400 }
      );
    }

    // Find filament by name or ObjectId
    const decodedName = decodeURIComponent(id);
    let filament = await Filament.findOne({ name: decodedName, _deletedAt: null })
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .populate("calibrations.bedType")
      .lean();

    if (!filament && /^[a-f0-9]{24}$/i.test(id)) {
      filament = await Filament.findOne({ _id: id, _deletedAt: null })
        .populate("calibrations.nozzle")
        .populate("calibrations.printer")
        .populate("calibrations.bedType")
        .lean();
    }

    if (!filament) {
      return NextResponse.json(
        { error: `Filament not found: ${decodedName}` },
        { status: 404 }
      );
    }

    // Resolve variant inheritance
    if (filament.parentId) {
      const parent = await Filament.findOne({ _id: filament.parentId, _deletedAt: null })
        .populate("calibrations.nozzle")
        .populate("calibrations.printer")
        .populate("calibrations.bedType")
        .lean();
      if (parent) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filament = resolveFilament(filament, parent) as any;
      }
    }

    // Find calibration matching the nozzle diameter
    const calibrations = ((filament as NonNullable<typeof filament>).calibrations || []) as Array<{
      nozzle?: { diameter?: number; name?: string; highFlow?: boolean };
      printer?: { name?: string };
      bedType?: { _id?: string; name?: string; material?: string } | null;
      extrusionMultiplier?: number;
      maxVolumetricSpeed?: number;
      pressureAdvance?: number;
      retractLength?: number;
      retractSpeed?: number;
      retractLift?: number;
      nozzleTemp?: number;
      nozzleTempFirstLayer?: number;
      bedTemp?: number;
      bedTempFirstLayer?: number;
      chamberTemp?: number;
      fanMinSpeed?: number;
      fanMaxSpeed?: number;
      fanBridgeSpeed?: number;
    }>;

    // Find best match: exact diameter match, optionally filtered by high_flow and bed_type
    const highFlowParam = searchParams.get("high_flow");
    const bedTypeParam = searchParams.get("bed_type");

    const diameterMatches = calibrations.filter((cal) => {
      if (!cal.nozzle || Math.abs((cal.nozzle.diameter || 0) - nozzleDiameter) >= 0.01)
        return false;
      if (highFlowParam !== null)
        return cal.nozzle.highFlow === (highFlowParam === "1");
      return true;
    });

    let match = diameterMatches[0];

    if (bedTypeParam) {
      // Try to find a bed-type-specific match first
      const bedTypeMatch = diameterMatches.find((cal) => {
        if (!cal.bedType) return false;
        return cal.bedType.name === bedTypeParam || cal.bedType._id?.toString() === bedTypeParam;
      });
      if (bedTypeMatch) {
        match = bedTypeMatch;
      } else {
        // Fall back to a calibration without bed type
        match = diameterMatches.find((cal) => !cal.bedType) || match;
      }
    } else {
      // No bed_type specified — prefer entries without bed type
      match = diameterMatches.find((cal) => !cal.bedType) || match;
    }

    if (!match) {
      return NextResponse.json(
        {
          error: `No calibration found for nozzle diameter ${nozzleDiameter}mm`,
          available: calibrations
            .filter((cal) => cal.nozzle)
            .map((cal) => ({
              diameter: cal.nozzle!.diameter,
              name: cal.nozzle!.name,
            })),
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      filament: (filament as NonNullable<typeof filament>).name,
      nozzle: {
        diameter: match.nozzle?.diameter,
        name: match.nozzle?.name,
        highFlow: match.nozzle?.highFlow,
      },
      printer: match.printer?.name || null,
      bedType: match.bedType ? { name: match.bedType.name, material: match.bedType.material } : null,
      calibration: {
        pressureAdvance: match.pressureAdvance ?? null,
        maxVolumetricSpeed: match.maxVolumetricSpeed ?? null,
        extrusionMultiplier: match.extrusionMultiplier ?? null,
        retractLength: match.retractLength ?? null,
        retractSpeed: match.retractSpeed ?? null,
        retractLift: match.retractLift ?? null,
        nozzleTemp: match.nozzleTemp ?? null,
        nozzleTempFirstLayer: match.nozzleTempFirstLayer ?? null,
        bedTemp: match.bedTemp ?? null,
        bedTempFirstLayer: match.bedTempFirstLayer ?? null,
        chamberTemp: match.chamberTemp ?? null,
        fanMinSpeed: match.fanMinSpeed ?? null,
        fanMaxSpeed: match.fanMaxSpeed ?? null,
        fanBridgeSpeed: match.fanBridgeSpeed ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to fetch calibration", detail: message },
      { status: 500 }
    );
  }
}

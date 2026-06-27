import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
import { calibrationToOrcaSlicerKeys } from "@/lib/orcaSlicerBundle";

/**
 * GET /api/filaments/{id}/calibration?nozzle_diameter=0.4&bed_type=Smooth+PEI
 *
 * Returns calibration data for a specific filament and nozzle diameter.
 * Looks up the filament by name (URL-encoded) or ObjectId, then finds
 * the calibration entry whose nozzle diameter matches the query param.
 *
 * Optional high_flow=0|1 disambiguates standard vs high-flow nozzles at the
 * same diameter. Optional nozzle_type (e.g. ?nozzle_type=Diamondback) further
 * disambiguates same-diameter nozzles of different type — symmetric with the
 * sync-back route's filamentdb_nozzle hint, so a multi-nozzle filament's
 * suffixed per-nozzle preset reads back ITS nozzle's pressure_advance (#872).
 *
 * Optional bed_type param filters by bed type name or ID.
 * Falls back to a calibration without bed type if no bed-type-specific match.
 *
 * Optional format=orcaslicer returns OrcaSlicer key names with array values.
 *
 * Used by PrusaSlicer and OrcaSlicer to auto-adjust filament settings when
 * the user switches printer presets (which have different nozzle sizes).
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

    // Find filament by name or ObjectId. `params.id` is ALREADY URL-decoded —
    // re-decoding throws URIError on a name with a literal `%` (#671).
    const decodedName = id;
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
      nozzle?: { diameter?: number; name?: string; type?: string; highFlow?: boolean };
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

    // Find best match: exact diameter match, optionally filtered by high_flow,
    // nozzle type, and bed_type
    const highFlowParam = searchParams.get("high_flow");
    const nozzleTypeParam = searchParams.get("nozzle_type");
    const bedTypeParam = searchParams.get("bed_type");

    const diameterMatches = calibrations.filter((cal) => {
      if (!cal.nozzle || Math.abs((cal.nozzle.diameter || 0) - nozzleDiameter) >= 0.01)
        return false;
      if (highFlowParam !== null)
        return cal.nozzle.highFlow === (highFlowParam === "1");
      return true;
    });

    // #872: disambiguate same-diameter nozzles of different TYPE (e.g. 0.4 Brass
    // vs 0.4 Diamondback) — symmetric with the sync-back route's filamentdb_nozzle
    // type hint. The fork sends nozzle_type when loading a suffixed per-nozzle
    // preset so it gets THAT nozzle's pressure_advance (PA is printer-scoped, so it
    // stays dynamic via this endpoint rather than baked into the flat preset).
    // The type compare is case-insensitive, matching the sync route's anchored
    // case-insensitive type query (route.ts). Soft filter: a type match wins, else
    // fall back to the diameter matches so a type/data mismatch never regresses to
    // a 404. NOTE this fallback intentionally DIVERGES from sync-back: on a type
    // miss the read returns a same-diameter (possibly other-type) calibration as a
    // best effort, whereas sync-back writes nothing per-nozzle (it has no nozzle to
    // attach to) and lets max-vol/temps fall through to the top-level fields.
    let scopedMatches = diameterMatches;
    if (nozzleTypeParam) {
      const wanted = nozzleTypeParam.trim().toLowerCase();
      const typeMatches = diameterMatches.filter(
        (cal) => (cal.nozzle?.type ?? "").trim().toLowerCase() === wanted,
      );
      if (typeMatches.length > 0) scopedMatches = typeMatches;
    }

    let match = scopedMatches[0];

    if (bedTypeParam) {
      // Try to find a bed-type-specific match first
      const bedTypeMatch = scopedMatches.find((cal) => {
        if (!cal.bedType) return false;
        return cal.bedType.name === bedTypeParam || cal.bedType._id?.toString() === bedTypeParam;
      });
      if (bedTypeMatch) {
        match = bedTypeMatch;
      } else {
        // Fall back to a calibration without bed type
        match = scopedMatches.find((cal) => !cal.bedType) || match;
      }
    } else {
      // No bed_type specified — prefer entries without bed type
      match = scopedMatches.find((cal) => !cal.bedType) || match;
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
              type: cal.nozzle!.type,
              highFlow: cal.nozzle!.highFlow,
            })),
        },
        { status: 404 }
      );
    }

    // OrcaSlicer format: return calibration with OrcaSlicer key names and array values
    const formatParam = searchParams.get("format");
    if (formatParam === "orcaslicer") {
      const orcaKeys = calibrationToOrcaSlicerKeys(match);
      return NextResponse.json({
        filament: (filament as NonNullable<typeof filament>).name,
        nozzle: {
          diameter: match.nozzle?.diameter,
          name: match.nozzle?.name,
          highFlow: match.nozzle?.highFlow,
        },
        printer: match.printer?.name || null,
        bedType: match.bedType ? { name: match.bedType.name, material: match.bedType.material } : null,
        calibration_orca: orcaKeys,
      });
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

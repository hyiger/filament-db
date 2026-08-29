import { NextRequest, NextResponse } from "next/server";
import { settingFlagIsOn } from "@/lib/slicerSettings";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import { generateOpenPrintTagBinary } from "@/lib/openprinttag";
import { resolveFilament } from "@/lib/resolveFilament";
import { selectSpoolForWrite } from "@/lib/selectSpoolForWrite";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await dbConnect();
    const { id } = await params;
    // Reject a non-ObjectId id up front (400) instead of a CastError 500
    // (#854).
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid filament id" }, { status: 400 });
    }

    const filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // #732: encode the SELECTED spool's instanceId (filament-level id only
    // for a spool-less filament). `?spool=<id>` targets a specific spool;
    // an unknown id is a 400 — don't silently write the wrong spool. Spools
    // are the filament's own (not inherited), so select off the raw doc.
    const requestedSpool = request.nextUrl.searchParams.get("spool");
    const selection = selectSpoolForWrite(filament, requestedSpool);
    if (!selection.ok) {
      return NextResponse.json(
        {
          error:
            selection.reason === "spool-not-found"
              ? "Spool not found on this filament"
              : "No instance ID available to encode",
        },
        { status: selection.reason === "spool-not-found" ? 400 : 422 },
      );
    }

    // Resolve inherited values if this is a variant
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolved: any = filament;
    if (filament.parentId) {
      const parent = await Filament.findOne({ _id: filament.parentId, _deletedAt: null }).lean();
      resolved = resolveFilament(filament, parent);
    }

    // #732: compute actual remaining weight from the SAME spool whose id we
    // encode — the tag must not identify one spool but carry another's
    // weight. The filament-level fallback uses the legacy top-level weight
    // (nulled by the create flow once a spool exists).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spools: any[] = resolved.spools ?? [];
    const selectedSpool =
      selection.source === "spool" && selection.spoolId
        ? spools.find((s) => String(s._id) === selection.spoolId)
        : null;
    const grossWeight = selectedSpool
      ? selectedSpool.totalWeight
      : selection.source === "filament"
        ? resolved.totalWeight
        : null;
    let actualWeightGrams: number | null = null;
    if (grossWeight != null && resolved.spoolWeight != null) {
      actualWeightGrams = Math.max(0, grossWeight - resolved.spoolWeight);
    }

    const binary = generateOpenPrintTagBinary({
      materialName: resolved.name,
      brandName: resolved.vendor,
      materialType: resolved.type,
      // GH #477: nullable primary per OpenPrintTag spec key 19 →
      // `undefined` omits the CBOR key entirely (coextruded case).
      color: resolved.color ?? undefined,
      // GH #477: surface secondaryColors like the Electron NFC write path,
      // so the downloaded `.bin` is faithful to a multi-color filament.
      secondaryColors: resolved.secondaryColors,
      density: resolved.density,
      diameter: resolved.diameter,
      nozzleTemp: resolved.temperatures?.nozzle,
      nozzleTempFirstLayer: resolved.temperatures?.nozzleFirstLayer,
      bedTemp: resolved.temperatures?.bed,
      bedTempFirstLayer: resolved.temperatures?.bedFirstLayer,
      chamberTemp:
        resolved.settings?.chamber_temperature != null
          ? Number(resolved.settings.chamber_temperature)
          : null,
      weightGrams: resolved.netFilamentWeight ?? null,
      actualWeightGrams,
      emptySpoolWeight: resolved.spoolWeight ?? null,
      spoolUid: selection.instanceId,
      dryingTemperature: resolved.dryingTemperature ?? null,
      dryingTime: resolved.dryingTime ?? null,
      transmissionDistance: resolved.transmissionDistance ?? null,
      abrasive: settingFlagIsOn(resolved.settings?.filament_abrasive),
      soluble: settingFlagIsOn(resolved.settings?.filament_soluble),
      shoreHardnessA: resolved.shoreHardnessA ?? null,
      shoreHardnessD: resolved.shoreHardnessD ?? null,
      optTags: resolved.optTags ?? [],
    });

    const safeName = resolved.name
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_");

    return new NextResponse(Buffer.from(binary) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="openprinttag_${safeName}.bin"`,
        "Content-Length": String(binary.byteLength),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to generate OpenPrintTag binary", detail: message },
      { status: 500 },
    );
  }
}

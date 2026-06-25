import { NextRequest, NextResponse } from "next/server";
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
    // A non-ObjectId id makes Mongoose throw a CastError that the generic
    // catch maps to 500; reject it up front as a 400 like the sibling routes
    // (check/sync/link). (#854, follow-up to #818)
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid filament id" }, { status: 400 });
    }

    const filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // #732 Phase 3: encode the SELECTED spool's instanceId (falling back to the
    // filament-level id only for a spool-less filament). `?spool=<id>` targets a
    // specific spool; an unknown id is a 400 (don't silently write the wrong
    // spool). Spools are the filament's own (not inherited), so select off the
    // raw doc rather than the variant-resolved view.
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

    // Compute actual remaining weight from the SAME spool whose id we encode
    // (#732, Codex P2): the tag must not identify one spool but carry another
    // spool's remaining weight. `selection` already picked the target spool
    // (the requested one, or the first non-retired by default). For the
    // filament-level fallback (a spool-less filament) use the legacy top-level
    // weight — which the create flow nulls once a spool exists, so spool-based
    // filaments read their gross off the spool. Codex P1/P2 on PR #707.
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
      // GH #477 (Codex P2 on PR #484): the Electron NFC write path
      // surfaces secondaryColors but this browser-download route was
      // missed in round 1 — so a `.bin` downloaded from the detail
      // page only carried the primary. Surface here too so the
      // downloaded tag binary is faithful to the multi-color filament.
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
      abrasive: resolved.settings?.filament_abrasive === "1",
      soluble: resolved.settings?.filament_soluble === "1",
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

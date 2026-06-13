import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import { generateOpenPrintTagBinary } from "@/lib/openprinttag";
import { resolveFilament } from "@/lib/resolveFilament";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await dbConnect();
    const { id } = await params;

    const filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Resolve inherited values if this is a variant
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolved: any = filament;
    if (filament.parentId) {
      const parent = await Filament.findOne({ _id: filament.parentId, _deletedAt: null }).lean();
      resolved = resolveFilament(filament, parent);
    }

    // Compute actual remaining weight. Prefer the live spool's gross — the
    // create flow (and the backfill script) move the initial weight onto a
    // spool and null the legacy top-level totalWeight, so reading totalWeight
    // alone would fall back to nominal for every spool-based filament. Fall
    // back to the legacy field for pre-spool rows (Codex P1 on PR #707).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeSpool = resolved.spools?.find((s: any) => !s.retired) ?? resolved.spools?.[0];
    const grossWeight = activeSpool?.totalWeight ?? resolved.totalWeight;
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
      spoolUid: filament.instanceId ?? null,
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

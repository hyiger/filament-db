import { NextRequest, NextResponse } from "next/server";
import {
  findExactRawNameId,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import Printer from "@/models/Printer";
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

    // GH #950 / #867: a 24-hex param is an ObjectId and is AUTHORITATIVE —
    // try it FIRST, name lookup only when that _id misses (name-first let a
    // 24-hex preset name shadow another filament's real _id). `params.id` is
    // ALREADY URL-decoded — do NOT re-decode (a literal `%` throws URIError,
    // #671).
    const decodedName = id;
    let filament = /^[a-f0-9]{24}$/i.test(id)
      ? await Filament.findOne({ _id: id, _deletedAt: null })
          .populate("calibrations.nozzle")
          .populate("calibrations.printer")
          .populate("calibrations.bedType")
          .lean()
      : null;

    if (!filament) {
      // name-lookup-ok: read-only; a miss is a 404
      // GH #1116: the EXACT stored spelling wins — the setter casts this
      // query, so with both "X" and "X " active a request addressed as "X "
      // would return the CANONICAL row's calibration.
      const exactId = await findExactRawNameId(
        Filament.collection as unknown as MinimalNameCollection,
        decodedName,
        { _deletedAt: null },
      );
      // name-lookup-ok: exact-spelling resolution above covers the cast case
      filament = await Filament.findOne(
        exactId
          ? { _id: exactId, _deletedAt: null }
          : { name: decodedName, _deletedAt: null },
      )
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
      // `_id` is an ObjectId at runtime (populated doc); typed loosely like
      // the bedType entry below so the lean() cast still overlaps.
      printer?: { _id?: unknown; name?: string; _deletedAt?: unknown };
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
    // GH #1047 Phase 0: the printer scope — without it a slicer got
    // whichever same-nozzle entry sorted first, including one tuned for a
    // different machine.
    const printerParam = searchParams.get("printer");

    const diameterMatches = calibrations.filter((cal) => {
      if (!cal.nozzle || Math.abs((cal.nozzle.diameter || 0) - nozzleDiameter) >= 0.01)
        return false;
      if (highFlowParam !== null)
        return cal.nozzle.highFlow === (highFlowParam === "1");
      return true;
    });

    // #872: disambiguate same-diameter nozzles of different TYPE — symmetric
    // with the sync-back route's filamentdb_nozzle hint; case-insensitive to
    // match its anchored type query. Soft filter: a type match wins, else
    // fall back to the diameter matches so a mismatch never regresses to a
    // 404. NOTE this fallback intentionally DIVERGES from sync-back: on a
    // type miss the read returns a same-diameter best-effort calibration,
    // whereas sync-back writes nothing per-nozzle.
    let scopedMatches = diameterMatches;
    if (nozzleTypeParam) {
      const wanted = nozzleTypeParam.trim().toLowerCase();
      const typeMatches = diameterMatches.filter(
        (cal) => (cal.nozzle?.type ?? "").trim().toLowerCase() === wanted,
      );
      if (typeMatches.length > 0) scopedMatches = typeMatches;
    }

    // GH #1047: PRIORITIZE by printer — deliberately reordering rather than
    // filtering. Dropping non-matching entries would discard the
    // printer-less BEDLESS default the bed_type step below falls back to,
    // breaking the documented "a bed-type miss falls back to a calibration
    // without a bed type". Soft throughout: a printer/data mismatch never
    // turns a working lookup into a 404.
    const genericEntries = scopedMatches.filter((cal) => !cal.printer);
    if (printerParam) {
      const raw = printerParam.trim();
      const wanted = raw.toLowerCase();
      // A 24-hex input is an OBJECTID and wins outright, before any name
      // matching: printer names are unrestricted, so one printer could be
      // NAMED as another's id. Ids compare case-folded (a populated `_id`
      // renders canonical lowercase).
      const looksLikeId = /^[0-9a-fA-F]{24}$/.test(raw);
      // Only a LIVE printer is addressable — `populate()` does not filter
      // tombstones, so a calibration pointing at a soft-deleted printer
      // would satisfy an id match and outrank an ACTIVE printer named with
      // that id. Applied to every rung below, so "exists" means the same
      // thing here as in the rest of the printer API.
      const addressable = scopedMatches.filter((cal) => cal.printer && !cal.printer._deletedAt);
      const idMatches = looksLikeId
        ? addressable.filter(
            (cal) => String(cal.printer?._id ?? "").trim().toLowerCase() === wanted,
          )
        : [];
      // Whether that id names a REAL printer is a question about the Printer
      // COLLECTION, not about the filtered rows — inferring existence from
      // `idMatches` conflates "no such printer" with "that printer has no
      // row for this nozzle", and only the first may fall back to name
      // matching. Queried only when the populated rows didn't already prove
      // existence. `_deletedAt: null` because that is what the rest of the
      // printer API means by "exists" — a soft-deleted row suppressing the
      // name path would hide an ACTIVE printer named with its id.
      const idIsRealPrinter =
        idMatches.length > 0 ||
        (looksLikeId && (await Printer.exists({ _id: raw, _deletedAt: null })) !== null);
      // Then the name, in three rungs from strictest to loosest. The Printer
      // name index is case-SENSITIVE ("XL" and "xl" can both exist), and
      // hybrid sync writes through the raw driver, bypassing the trim setter
      // ("X" and "X " can both exist too) — array order must not decide
      // between them when the caller spelled one exactly.
      //
      // 1. VERBATIM — no normalization on either side; the only rung that
      //    can tell "X" from "X ".
      const verbatimName = addressable.filter((cal) => (cal.printer?.name ?? "") === printerParam);
      // 2. Trimmed exact — tolerates stray whitespace around the input.
      const exactName = addressable.filter((cal) => (cal.printer?.name ?? "").trim() === raw);
      // 3. Case-folded.
      const loose = addressable.filter(
        (cal) => (cal.printer?.name ?? "").trim().toLowerCase() === wanted,
      );
      // Every rung gets the same existence question as the id: an identity
      // that EXISTS and simply has no calibration here must not be answered
      // by a weaker match — and it has to be asked PER RUNG (a live "X "
      // with no row here was answered by "X"'s row when the check ran only
      // once).
      //
      // Asked through the RAW driver, not the model: the schema's `trim`
      // setter applies to query VALUES too, so `Printer.exists({name:
      // "X "})` casts to `"X"` and answers about the wrong row (the GH #1116
      // trap). `_deletedAt: null` there also matches rows predating the
      // field.
      const liveNamed = async (name: string) =>
        (await Printer.collection.countDocuments(
          { name, _deletedAt: null },
          { limit: 1 },
        )) > 0;

      // Strongest rung first; each `liveNamed` is asked only when the rung
      // above found nothing and a weaker one would otherwise answer. The
      // ordinary lookup stops at `verbatimName` with no query at all.
      let printerMatches: typeof scopedMatches = [];
      if (idMatches.length > 0) printerMatches = idMatches;
      else if (idIsRealPrinter) printerMatches = [];
      else if (verbatimName.length > 0) printerMatches = verbatimName;
      else if ((exactName.length > 0 || loose.length > 0) && (await liveNamed(printerParam)))
        printerMatches = [];
      else if (exactName.length > 0) printerMatches = exactName;
      else if (loose.length > 0 && raw !== printerParam && (await liveNamed(raw)))
        printerMatches = [];
      else printerMatches = loose;
      if (printerMatches.length > 0) {
        // Printer-scoped first, shareable defaults retained behind them.
        scopedMatches = [...printerMatches, ...genericEntries];
      } else if (genericEntries.length > 0) {
        // Unknown printer → the shareable defaults (what prusaSlicerBundle
        // prefers when baking a preset).
        scopedMatches = genericEntries;
      }
    } else if (genericEntries.length > 0) {
      // No printer asked for: prefer the shareable defaults, keeping the
      // machine-specific entries behind them so a filament with ONLY
      // printer-scoped rows still answers.
      scopedMatches = [...genericEntries, ...scopedMatches.filter((cal) => cal.printer)];
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

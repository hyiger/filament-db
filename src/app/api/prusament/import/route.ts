import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import type { PrusamentScrapeResult } from "../route";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { isValidIsoDateString } from "@/lib/validateSpoolBody";

/**
 * GH #307: validate a renderer-supplied Prusament spool payload before
 * any DB write. The spool's `totalWeight` reaches the Filament via a
 * `$push`, which skips the subdocument validators the dedicated spool
 * routes rely on — so a non-numeric weight or a garbage colour would
 * otherwise be persisted. Returns a rejection reason, or null when ok.
 */
function validatePrusamentSpool(spool: unknown): string | null {
  if (!spool || typeof spool !== "object") {
    return "spool must be an object";
  }
  const s = spool as Record<string, unknown>;
  if (typeof s.spoolId !== "string" || s.spoolId.trim() === "") {
    return "spool.spoolId is required";
  }
  for (const field of [
    "diameter",
    "lengthMeters",
    "netWeight",
    "totalWeight",
    "spoolWeight",
  ]) {
    const v = s[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return `spool.${field} must be a non-negative number`;
    }
  }
  if (typeof s.colorHex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(s.colorHex)) {
    return "spool.colorHex must be a #RRGGBB hex colour";
  }
  if (typeof s.material !== "string" || s.material.trim() === "") {
    return "spool.material is required";
  }
  if (typeof s.colorName !== "string") {
    return "spool.colorName must be a string";
  }
  if (typeof s.manufactureDate !== "string") {
    return "spool.manufactureDate must be a string";
  }
  return null;
}

/**
 * POST /api/prusament/import
 *
 * Imports a scraped Prusament spool into the database.
 *
 * Body:
 *   spool       – PrusamentScrapeResult from the scrape endpoint
 *   filamentId  – (optional) existing filament ID to add a spool to
 *   action      – "create" | "add-spool"
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Database connection failed", detail: message }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
  }
  const spool: PrusamentScrapeResult = body.spool;
  const action: string = body.action; // "create" or "add-spool"
  const filamentId: string | undefined = body.filamentId;

  // GH #307: full shape validation — not just a spoolId truthiness check.
  const spoolError = validatePrusamentSpool(spool);
  if (spoolError) {
    return NextResponse.json({ error: spoolError }, { status: 400 });
  }

  if (action && action !== "create" && action !== "add-spool") {
    return NextResponse.json(
      { error: `Invalid action: "${action}". Must be "create" or "add-spool".` },
      { status: 400 },
    );
  }

  // Compute density from Prusament data: weight(g) / volume(cm³)
  // volume = length(m) * 100(cm/m) * π * (diameter_mm / 20)²
  const radiusCm = spool.diameter / 20;
  const volumeCm3 = spool.lengthMeters * 100 * Math.PI * radiusCm * radiusCm;
  const density = volumeCm3 > 0 ? Math.round((spool.netWeight / volumeCm3) * 100) / 100 : null;

  const spoolLabel = `${spool.spoolId} (${spool.manufactureDate.split(" ")[0]})`;

  if (action === "add-spool" && filamentId) {
    // GH #430: validate the filament id up front so a malformed id
    // surfaces as 400, not a downstream CastError → bare 500.
    if (!mongoose.isValidObjectId(filamentId)) {
      return NextResponse.json({ error: "Invalid filament id" }, { status: 400 });
    }

    // GH #430: cap per-filament spool count to keep a hostile client
    // from $push-ing an unbounded stream onto a single doc. 500
    // matches the order of magnitude of every other per-doc array
    // we touch (printer.amsSlots, filament.calibrations, etc.).
    const existing = await Filament.findOne(
      { _id: filamentId, _deletedAt: null },
      { spools: 1 },
    ).lean();
    if (!existing) {
      return NextResponse.json({ error: "Filament not found" }, { status: 404 });
    }
    const MAX_SPOOLS_PER_FILAMENT = 500;
    if ((existing.spools?.length ?? 0) >= MAX_SPOOLS_PER_FILAMENT) {
      return NextResponse.json(
        {
          error: `This filament already has ${MAX_SPOOLS_PER_FILAMENT} spools (the per-filament limit)`,
        },
        { status: 400 },
      );
    }

    // GH #430: carry the Prusament-specific traceability fields onto
    // the spool subdoc. Pre-fix the $push only carried label +
    // totalWeight, silently dropping the lot number and manufacture
    // date that are the whole point of a Prusament import.
    // `manufactureDate` is "YYYY-MM-DD HH:MM" — split off the time
    // and validate before persisting.
    const purchaseDateStr = spool.manufactureDate.split(" ")[0];
    const purchaseDate = isValidIsoDateString(purchaseDateStr)
      ? new Date(purchaseDateStr)
      : null;

    // Add spool to existing filament
    const filament = await Filament.findOneAndUpdate(
      { _id: filamentId, _deletedAt: null },
      {
        $push: {
          spools: {
            label: spoolLabel,
            totalWeight: spool.totalWeight,
            lotNumber: spool.spoolId,
            ...(purchaseDate ? { purchaseDate } : {}),
          },
        },
      },
      { returnDocument: "after" },
    ).lean();

    if (!filament) {
      return NextResponse.json({ error: "Filament not found" }, { status: 404 });
    }

    return NextResponse.json({
      action: "add-spool",
      filament,
      message: `Added spool ${spool.spoolId} to ${filament.name}`,
    });
  }

  // action === "create" — create a new filament
  const name = `Prusament ${spool.material} ${spool.colorName}`;

  // GH #430 (Codex follow-up on #463): the create flow ALSO has to
  // carry the Prusament traceability fields onto every spool subdoc
  // it writes. Pre-fix the create branch + the existing-name $push
  // fallback both wrote `{ label, totalWeight }` only, silently
  // dropping the spool id and manufacture date that are the whole
  // point of a Prusament import — even though the add-spool branch
  // higher up already did the right thing.
  const purchaseDateForCreate = isValidIsoDateString(
    spool.manufactureDate.split(" ")[0],
  )
    ? new Date(spool.manufactureDate.split(" ")[0])
    : null;
  const prusamentSpoolFields = {
    label: spoolLabel,
    totalWeight: spool.totalWeight,
    lotNumber: spool.spoolId,
    ...(purchaseDateForCreate ? { purchaseDate: purchaseDateForCreate } : {}),
  };

  // Atomically check for existing filament with same name and add spool if found
  const existingUpdated = await Filament.findOneAndUpdate(
    { name, _deletedAt: null },
    {
      $push: {
        spools: prusamentSpoolFields,
      },
    },
    { returnDocument: "after" },
  ).lean();

  if (existingUpdated) {
    return NextResponse.json({
      action: "add-spool",
      filament: existingUpdated,
      message: `Filament "${name}" already exists. Added spool ${spool.spoolId}.`,
    });
  }

  // Use the max nozzle temp as the default (Prusament typically recommends a range)
  const filament = await Filament.create({
    name,
    vendor: "Prusa Research",
    type: spool.material,
    color: spool.colorHex,
    cost: spool.priceUsd,
    density,
    diameter: spool.diameter,
    temperatures: {
      nozzle: spool.nozzleTempMax,
      nozzleFirstLayer: null,
      bed: spool.bedTempMax,
      bedFirstLayer: null,
    },
    spoolWeight: spool.spoolWeight,
    netFilamentWeight: spool.netWeight,
    spools: [prusamentSpoolFields],
    tdsUrl: spool.pageUrl,
    settings: {
      prusament_spool_id: spool.spoolId,
      nozzle_temp_range: `${spool.nozzleTempMin}-${spool.nozzleTempMax}`,
      bed_temp_range: `${spool.bedTempMin}-${spool.bedTempMax}`,
    },
  });

  return NextResponse.json({
    action: "create",
    filament,
    message: `Created "${name}" with spool ${spool.spoolId}`,
  }, { status: 201 });
}

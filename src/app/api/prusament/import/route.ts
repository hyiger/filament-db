import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import type { PrusamentScrapeResult } from "../route";
import { assertSameOriginRequest } from "@/lib/requestGuard";

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
    // Add spool to existing filament
    const filament = await Filament.findOneAndUpdate(
      { _id: filamentId, _deletedAt: null },
      {
        $push: {
          spools: {
            label: spoolLabel,
            totalWeight: spool.totalWeight,
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

  // Atomically check for existing filament with same name and add spool if found
  const existingUpdated = await Filament.findOneAndUpdate(
    { name, _deletedAt: null },
    {
      $push: {
        spools: {
          label: spoolLabel,
          totalWeight: spool.totalWeight,
        },
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
    spools: [
      {
        label: spoolLabel,
        totalWeight: spool.totalWeight,
      },
    ],
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

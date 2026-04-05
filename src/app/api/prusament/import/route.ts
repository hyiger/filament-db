import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import type { PrusamentScrapeResult } from "../route";

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

  if (!spool?.spoolId) {
    return NextResponse.json(
      { error: "Missing spool data" },
      { status: 400 },
    );
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
      { new: true },
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

  // Check for existing filament with same name
  const existing = await Filament.findOne({ name, _deletedAt: null }).lean();
  if (existing) {
    // Add spool to existing instead
    const updated = await Filament.findOneAndUpdate(
      { _id: existing._id },
      {
        $push: {
          spools: {
            label: spoolLabel,
            totalWeight: spool.totalWeight,
          },
        },
      },
      { new: true },
    ).lean();

    return NextResponse.json({
      action: "add-spool",
      filament: updated,
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

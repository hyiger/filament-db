import { NextRequest, NextResponse } from "next/server";

/** Shape of the spoolData JSON embedded in the Prusament spool page. */
interface PrusamentSpoolData {
  ff_goods_id: number;
  country: string;
  sample: unknown;
  diameter_avg: number;
  diameter_measurement: unknown;
  weight: number; // net filament weight in grams
  spool_weight: number;
  length: number; // metres
  manufacture_date: string;
  filament: {
    color_name: string;
    color_rgb: string; // hex without #
    material: string;
    name: string; // full product name
    photo_url: string;
    grade: string;
    he_min: number; // extruder temp min
    he_max: number; // extruder temp max
    hb_min: number; // heatbed temp min
    hb_max: number; // heatbed temp max
  };
  ovality: number;
  max_diameter_offset: number;
  standard_deviation?: number;
  price_eur?: number;
  price_usd?: number;
}

export interface PrusamentScrapeResult {
  spoolId: string;
  productName: string;
  material: string;
  colorName: string;
  colorHex: string;
  diameter: number;
  diameterAvg: number;
  diameterStdDev: number | null;
  ovality: number;
  netWeight: number;
  spoolWeight: number;
  totalWeight: number;
  lengthMeters: number;
  nozzleTempMin: number;
  nozzleTempMax: number;
  bedTempMin: number;
  bedTempMax: number;
  manufactureDate: string;
  country: string;
  goodsId: number;
  priceUsd: number | null;
  priceEur: number | null;
  photoUrl: string;
  pageUrl: string;
}

/**
 * GET /api/prusament?spoolId=<id>
 *
 * Fetches a Prusament spool page and extracts the embedded spoolData JSON.
 */
export async function GET(request: NextRequest) {
  const spoolId = request.nextUrl.searchParams.get("spoolId")?.trim();
  if (!spoolId) {
    return NextResponse.json(
      { error: "spoolId query parameter is required" },
      { status: 400 },
    );
  }

  // Accept either a bare ID or a full URL
  const cleanId = spoolId.includes("spoolId=")
    ? new URL(spoolId).searchParams.get("spoolId") ?? spoolId
    : spoolId;

  const pageUrl = `https://prusament.com/spool/?spoolId=${encodeURIComponent(cleanId)}`;

  let html: string;
  try {
    const res = await fetch(pageUrl, {
      headers: { "User-Agent": "FilamentDB/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Prusament returned HTTP ${res.status}` },
        { status: 502 },
      );
    }
    html = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return NextResponse.json(
      { error: `Failed to fetch Prusament page: ${msg}` },
      { status: 502 },
    );
  }

  // Extract the spoolData JSON from the page.
  // It appears as: var spoolData = '{...}'; or spoolData = "{...}"
  const match = html.match(/var\s+spoolData\s*=\s*'({[\s\S]*?})'\s*;/)
    ?? html.match(/var\s+spoolData\s*=\s*"({[\s\S]*?})"\s*;/);

  if (!match) {
    // Check if the page indicates spool not found
    if (html.includes("Spool not found") || html.includes("404")) {
      return NextResponse.json(
        { error: `Spool "${cleanId}" not found on Prusament` },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: "Could not extract spool data from Prusament page" },
      { status: 502 },
    );
  }

  let raw: PrusamentSpoolData;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return NextResponse.json(
      { error: "Failed to parse spool data JSON" },
      { status: 502 },
    );
  }

  const f = raw.filament;
  const result: PrusamentScrapeResult = {
    spoolId: cleanId,
    productName: f.name,
    material: f.material,
    colorName: f.color_name,
    colorHex: f.color_rgb.startsWith("#") ? f.color_rgb : `#${f.color_rgb}`,
    diameter: 1.75, // Prusament is always 1.75
    diameterAvg: raw.diameter_avg,
    diameterStdDev: raw.standard_deviation ?? null,
    ovality: raw.ovality,
    netWeight: raw.weight,
    spoolWeight: raw.spool_weight,
    totalWeight: raw.weight + raw.spool_weight,
    lengthMeters: raw.length,
    nozzleTempMin: f.he_min,
    nozzleTempMax: f.he_max,
    bedTempMin: f.hb_min,
    bedTempMax: f.hb_max,
    manufactureDate: raw.manufacture_date,
    country: raw.country,
    goodsId: raw.ff_goods_id,
    priceUsd: raw.price_usd ?? null,
    priceEur: raw.price_eur ?? null,
    photoUrl: f.photo_url,
    pageUrl,
  };

  return NextResponse.json(result);
}

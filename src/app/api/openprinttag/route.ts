import { NextResponse } from "next/server";
import { fetchOpenPrintTagDatabase, clearCache } from "@/lib/openprinttagBrowser";

/**
 * GET /api/openprinttag
 *
 * Fetch the OpenPrintTag community database from GitHub, filtered to FFF
 * (FDM) filaments only. Returns brands and materials with completeness
 * scores. Results are cached for 1 hour.
 *
 * Query params:
 *   refresh=true — force re-fetch from GitHub (clears cache)
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("refresh") === "true") {
      clearCache();
    }

    const db = await fetchOpenPrintTagDatabase();

    return NextResponse.json(db);
  } catch (err) {
    console.error("OpenPrintTag fetch error:", err);
    return NextResponse.json(
      { error: "Failed to fetch OpenPrintTag database", detail: String(err) },
      { status: 500 },
    );
  }
}

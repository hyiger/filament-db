import { NextRequest, NextResponse } from "next/server";
import { fetchOpenPrintTagDatabase } from "@/lib/openprinttagBrowser";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * GET /api/openprinttag
 *
 * Fetch the OpenPrintTag community database from GitHub, filtered to FFF
 * (FDM) filaments only. Returns brands and materials with completeness
 * scores. Results are cached for 1 hour.
 *
 * Note: cache refresh moved to POST /api/openprinttag (see below) as a
 * GET-with-side-effect is a REST smell — see GH #427.
 */
export async function GET() {
  try {
    const db = await fetchOpenPrintTagDatabase();
    return NextResponse.json(db);
  } catch (err) {
    console.error("OpenPrintTag fetch error:", err);
    return NextResponse.json(
      { error: "Failed to fetch OpenPrintTag database", detail: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/openprinttag — force-refresh the OpenPrintTag cache. A
 * same-origin POST, not `GET ?refresh=true` — a GET-with-side-effect lets a
 * cross-origin link thrash the cache (GH #427).
 *
 * #931: does NOT clear the cache up-front — the library runs a SHA-aware
 * probe, and an unchanged upstream commit just slides the TTL forward,
 * skipping the ~3 MB tarball download + ~11k-file extract.
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;
  try {
    const db = await fetchOpenPrintTagDatabase({ force: true });
    return NextResponse.json(db);
  } catch (err) {
    console.error("OpenPrintTag refresh error:", err);
    return NextResponse.json(
      { error: "Failed to refresh OpenPrintTag database", detail: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

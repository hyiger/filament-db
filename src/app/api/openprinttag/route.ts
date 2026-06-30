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
 * POST /api/openprinttag
 *
 * Force-refresh the OpenPrintTag cache. Previously this was triggered via
 * `GET ?refresh=true`, which is a GET-with-side-effect (cache mutation) —
 * cross-origin link can thrash the cache, and the verb misleads HTTP
 * intermediaries that assume GET is idempotent. Same-origin-only POST is the
 * right shape (GH #427).
 *
 * #931: this no longer clears the cache up-front. Instead it asks the library
 * to short-circuit the TTL check and run the SHA-aware probe — if upstream's
 * commit hasn't changed since the last parse, we serve cached data and just
 * slide the TTL window forward, skipping the ~3 MB tarball download +
 * ~11k-file extract. Only a moved SHA (or a never-cached fresh install or a
 * probe failure) takes the full tarball path.
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

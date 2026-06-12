import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { matchFilament } from "@/lib/matchFilament";

/**
 * Match a scanned NFC tag / QR / barcode against the filament database.
 *
 * The matching logic lives in `src/lib/matchFilament.ts` so the
 * `POST /api/nfc/decode` endpoint can reuse the exact same priority order
 * (instanceId → name → vendor+type → vendor) without it drifting between the
 * two call sites.
 */
/**
 * GH #513: bound every regex-compile path's input length, not just the
 * instanceId branch. escapeRegex prevents injection but NOT compile-cost
 * DoS — a 10MB query still produces a 10MB escaped pattern Mongo's
 * driver has to parse. The route is intentionally unguarded by
 * assertSameOriginRequest so PrusaSlicer / OrcaSlicer (and the mobile
 * scanner app) can hit it cross-origin, which means anyone reachable can
 * send any query string. 128 chars matches the cap already applied to
 * instanceId; production filament names / vendors / types are well under
 * that.
 */
function boundedParam(v: string | null): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const params = request.nextUrl.searchParams;
    const result = await matchFilament({
      name: boundedParam(params.get("name")),
      vendor: boundedParam(params.get("vendor")),
      type: boundedParam(params.get("type")),
      instanceId: boundedParam(params.get("instanceId")),
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to match filaments", detail: message },
      { status: 500 },
    );
  }
}

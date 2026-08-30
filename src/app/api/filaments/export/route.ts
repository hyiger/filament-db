import { NextRequest, NextResponse } from "next/server";
import { GET as prusaSlicerExport } from "../prusaslicer/route";

/**
 * GH #341: legacy alias for `/api/filaments/prusaslicer`, still the endpoint
 * the two UI download buttons call.
 *
 * It used to be a hand-copied duplicate of that route, and duplicated export
 * logic is exactly how a filter lands on one path and not the other — the
 * template exclusion shipped to `/prusaslicer` while every bundle downloaded
 * from the UI came through here unfiltered. Delegating removes the class:
 * there is one implementation, and this endpoint differs only in the download
 * filename it advertises.
 */
export async function GET(request: NextRequest) {
  const res = await prusaSlicerExport(request);
  // Errors pass through untouched — same status, same body.
  if (!res.ok) return res;
  return new NextResponse(await res.text(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="filament_profiles.ini"',
    },
  });
}

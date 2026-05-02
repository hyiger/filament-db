import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * POST /api/filaments/{id}/spools/{spoolId}/dry-cycles — log a dry cycle.
 *
 * Body: { date?: ISO string, tempC?: number, durationMin?: number, notes?: string }
 *
 * `date` defaults to now. All other fields optional.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; spoolId: string }> }
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }
  if (body !== null && typeof body !== "object") {
    return errorResponse("body must be an object", 400);
  }
  // Cap notes length so a malicious or accidental multi-MB POST can't
  // bloat a spool subdocument. 1000 chars is generous for a freeform
  // dry-cycle note; matches the spirit of the print-history `notes`
  // bound (2000) without giving as much rope, since this entry sits
  // inside an embedded subdocument array that's loaded on every spool
  // fetch.
  if (typeof body?.notes === "string" && body.notes.length > 1000) {
    return errorResponse("notes must be 1000 characters or fewer", 400);
  }

  const entry: Record<string, unknown> = {
    date: body?.date ? new Date(body.date) : new Date(),
    tempC:
      typeof body?.tempC === "number" && Number.isFinite(body.tempC) ? body.tempC : null,
    durationMin:
      typeof body?.durationMin === "number" && Number.isFinite(body.durationMin)
        ? body.durationMin
        : null,
    notes: typeof body?.notes === "string" ? body.notes : "",
  };

  try {
    await dbConnect();
    const { id, spoolId } = await params;
    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null, "spools._id": spoolId },
      { $push: { "spools.$.dryCycles": entry } },
      { returnDocument: "after" },
    ).lean();
    if (!filament) {
      return errorResponse("Filament or spool not found", 404);
    }
    return NextResponse.json(filament, { status: 201 });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to log dry cycle");
  }
}

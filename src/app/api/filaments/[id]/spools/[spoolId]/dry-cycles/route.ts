import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

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
      { new: true },
    ).lean();
    if (!filament) {
      return errorResponse("Filament or spool not found", 404);
    }
    return NextResponse.json(filament, { status: 201 });
  } catch (err) {
    return errorResponse("Failed to log dry cycle", 500, getErrorMessage(err));
  }
}

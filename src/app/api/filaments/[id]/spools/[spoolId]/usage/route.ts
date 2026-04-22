import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * POST /api/filaments/{id}/spools/{spoolId}/usage — manually log grams used.
 *
 * Body: { grams: number, jobLabel?: string, date?: ISO string }
 *
 * Decrements spool.totalWeight by `grams` (clamped at 0) and appends to
 * spool.usageHistory. This is the "I used 120g on a benchy" manual entry
 * from issue #92 — complements the slicer-driven /api/print-history route.
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
  if (!body || typeof body !== "object") {
    return errorResponse("body must be an object", 400);
  }
  if (typeof body.grams !== "number" || !Number.isFinite(body.grams) || body.grams <= 0) {
    return errorResponse("grams must be a positive number", 400);
  }
  const jobLabel = typeof body.jobLabel === "string" ? body.jobLabel : "";
  const date = body.date ? new Date(body.date) : new Date();

  try {
    await dbConnect();
    const { id, spoolId } = await params;
    const filament = await Filament.findOne({
      _id: id,
      _deletedAt: null,
      "spools._id": spoolId,
    });
    if (!filament) {
      return errorResponse("Filament or spool not found", 404);
    }
    // spools is typed as ISpool[] in our interface but at runtime is a
    // Mongoose DocumentArray that supports .id(). Use Array.find for a
    // type-clean lookup, then cast for subdoc mutation.
    const spool = filament.spools.find((s) => String(s._id) === spoolId);
    if (!spool) {
      return errorResponse("Spool not found", 404);
    }
    if (typeof spool.totalWeight === "number") {
      spool.totalWeight = Math.max(0, spool.totalWeight - body.grams);
    }
    spool.usageHistory = spool.usageHistory || [];
    spool.usageHistory.push({
      grams: body.grams,
      jobLabel,
      date,
      source: "manual",
    });
    await filament.save();
    return NextResponse.json(filament.toObject(), { status: 201 });
  } catch (err) {
    return errorResponse("Failed to log usage", 500, getErrorMessage(err));
  }
}

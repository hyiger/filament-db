import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/** GH #304: hard cap on a spool's embedded usageHistory array. Far
 * above any realistic per-spool history; exists to stop a client
 * looping POSTs from growing the filament document toward the 16MB
 * BSON limit. Oldest entries roll off once the cap is reached. */
const MAX_SPOOL_HISTORY = 1000;

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
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

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
  // Label + notes length bounds keep pathological input from bloating the
  // subdocument. 200 is generous for any realistic job name.
  if (typeof body.jobLabel === "string" && body.jobLabel.length > 200) {
    return errorResponse("jobLabel must be 200 characters or fewer", 400);
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
    // Array.find keeps the lookup strictly typed against our ISpool[]
    // interface; Mongoose's runtime DocumentArray also exposes .id() but
    // that's untyped in the interface and would need a cast to use.
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
      // No PrintHistory record backs a direct spool-UI usage log — the
      // print-history undo path keys off this being null to skip the
      // entry. Required by the IUsageEntry interface so the field is
      // explicit at every call site.
      jobId: null,
    });
    // GH #304: roll off the oldest entries once the cap is reached so
    // the embedded array can't grow the filament document unbounded.
    if (spool.usageHistory.length > MAX_SPOOL_HISTORY) {
      spool.usageHistory = spool.usageHistory.slice(-MAX_SPOOL_HISTORY);
    }
    await filament.save();
    return NextResponse.json(filament.toObject(), { status: 201 });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to log usage");
  }
}

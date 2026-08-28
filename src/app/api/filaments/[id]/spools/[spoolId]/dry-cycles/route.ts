import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import {
  parseSpoolResponseShape,
  findSpoolById,
  INVALID_SHAPE_MESSAGE,
} from "@/lib/spoolResponseShape";

/** GH #304: hard cap on a spool's embedded dryCycles array — same
 * unbounded-growth concern as usageHistory. The `$slice: -N` modifier
 * on the `$push` keeps only the most recent N entries atomically. */
const MAX_DRY_CYCLES = 1000;

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
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // GH #1027: ?shape=spool slims the 201 to the affected spool only.
  const shape = parseSpoolResponseShape(request.nextUrl.searchParams);
  if (shape === null) {
    return errorResponse(INVALID_SHAPE_MESSAGE, 400);
  }

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
  // Cap notes length so a multi-MB POST can't bloat a spool subdocument
  // (this entry sits inside an embedded array loaded on every spool fetch).
  if (typeof body?.notes === "string" && body.notes.length > 1000) {
    return errorResponse("notes must be 1000 characters or fewer", 400);
  }

  // GH #502.1: an Invalid Date reaching the doc later 500s /api/dashboard
  // (`.toISOString()` throws) — mirror the print-history POST guard.
  const cycleDate = body?.date ? new Date(body.date) : new Date();
  if (Number.isNaN(cycleDate.getTime())) {
    return errorResponse("date is not a valid date", 400);
  }

  // GH #502.2: the $push below intentionally omits `runValidators: true`
  // to keep the atomic $slice cap (#304) — enforce the schema's bounds
  // (tempC 0-300, durationMin >= 0) explicitly here.
  if (body?.tempC != null) {
    if (typeof body.tempC !== "number" || !Number.isFinite(body.tempC)) {
      return errorResponse("tempC must be a finite number", 400);
    }
    if (body.tempC < 0 || body.tempC > 300) {
      return errorResponse("tempC must be between 0 and 300", 400);
    }
  }
  if (body?.durationMin != null) {
    if (typeof body.durationMin !== "number" || !Number.isFinite(body.durationMin)) {
      return errorResponse("durationMin must be a finite number", 400);
    }
    if (body.durationMin < 0) {
      return errorResponse("durationMin must be non-negative", 400);
    }
  }

  const entry: Record<string, unknown> = {
    date: cycleDate,
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
    // GH #605: the positional $push mutates a spool subdocument, so it
    // serializes on the same per-filament mutex the promotion paths hold —
    // unserialized it could land between a promotion's snapshot and its
    // clearing write, minting the 201-acknowledged dry cycle onto neither
    // document. Single key, no nested lock inside.
    return await runExclusive(filamentLockKey(id), async () => {
      const filament = await Filament.findOneAndUpdate(
        { _id: id, _deletedAt: null, "spools._id": spoolId },
        // GH #304: $slice: -N keeps only the most recent MAX_DRY_CYCLES
        // entries, so a looping client can't grow the filament document
        // toward the 16MB BSON limit.
        { $push: { "spools.$.dryCycles": { $each: [entry], $slice: -MAX_DRY_CYCLES } } },
        { returnDocument: "after" },
      ).lean();
      if (!filament) {
        return errorResponse("Filament or spool not found", 404);
      }
      // GH #1027: the $push filter matched `spools._id`, so the null guard
      // is unreachable-in-practice defensiveness.
      if (shape === "spool") {
        const spool = findSpoolById(filament.spools, spoolId);
        if (!spool) {
          return errorResponse("Spool not found", 404);
        }
        return NextResponse.json({ spool }, { status: 201 });
      }
      return NextResponse.json(filament, { status: 201 });
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to log dry cycle");
  }
}

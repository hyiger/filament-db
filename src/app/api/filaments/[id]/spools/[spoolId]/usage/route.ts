import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { errorResponse, errorResponseFromCaught, handleVersionError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { capUsageHistory, MAX_SPOOL_HISTORY, MAX_USAGE_GRAMS } from "@/lib/capUsageHistory";
import {
  parseSpoolResponseShape,
  findSpoolById,
  INVALID_SHAPE_MESSAGE,
} from "@/lib/spoolResponseShape";

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
  if (!body || typeof body !== "object") {
    return errorResponse("body must be an object", 400);
  }
  if (typeof body.grams !== "number" || !Number.isFinite(body.grams) || body.grams <= 0) {
    return errorResponse("grams must be a positive number", 400);
  }
  // GH #1030: bound the MAGNITUDE too — `Number.isFinite` only excludes
  // Infinity/NaN, and a persisted 1e308 overflows a day's analytics sum to
  // Infinity, turning EVERY segment of that day into JSON null. Kept in
  // lockstep with the print-history POST's identical cap.
  if (body.grams > MAX_USAGE_GRAMS) {
    return errorResponse(
      `grams must be no greater than ${MAX_USAGE_GRAMS}`,
      400,
    );
  }
  // Length bound keeps pathological input from bloating the subdocument.
  if (typeof body.jobLabel === "string" && body.jobLabel.length > 200) {
    return errorResponse("jobLabel must be 200 characters or fewer", 400);
  }
  const jobLabel = typeof body.jobLabel === "string" ? body.jobLabel : "";
  const date = body.date ? new Date(body.date) : new Date();
  // Reject an unparseable date with a clean 400 rather than a raw Mongoose
  // cast error (#675; matches the print-history POST date guard).
  if (Number.isNaN(date.getTime())) {
    return errorResponse("date is not a valid date", 400);
  }

  try {
    await dbConnect();
    const { id, spoolId } = await params;
    // GH #605: the read-modify-save mutates a spool subdocument, so it runs
    // under the same per-filament mutex the promotion paths hold —
    // unserialized, the save could land between a promotion's snapshot and
    // its clearing write and the 201-acknowledged debit/ledger entry would
    // exist on neither document. (The promotion's completing write $incs
    // __v, so an interleaved save surfaces as the 409 VersionError below —
    // the lock removes the in-process case; the version guard stays for
    // out-of-process writers.) Single key, no nested lock inside.
    return await runExclusive(filamentLockKey(id), async () => {
      const filament = await Filament.findOne({
        _id: id,
        _deletedAt: null,
        "spools._id": spoolId,
      });
      if (!filament) {
        return errorResponse("Filament or spool not found", 404);
      }
      // Array.find keeps the lookup strictly typed against ISpool[]
      // (DocumentArray.id() is untyped in the interface).
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
        // entry.
        jobId: null,
      });
      // GH #304 / #954: cap the array so it can't grow the document
      // unbounded. Undo-aware (capUsageHistory) rather than a plain
      // `slice(-N)`: a manual log must not evict a still-live `source:"job"`
      // entry, whose later DELETE refund keys off the entry still being
      // present (GH #621); manual/nfc entries are evicted first.
      if (spool.usageHistory.length > MAX_SPOOL_HISTORY) {
        spool.usageHistory = capUsageHistory(spool.usageHistory, MAX_SPOOL_HISTORY);
      }
      // GH #905: validate modified paths only so a legacy out-of-range
      // field elsewhere can't block the log/debit.
      await filament.save({ validateModifiedOnly: true });
      // GH #1027: pick the affected spool out of the same toObject()
      // serialization the default path uses. The mobile weight refresh
      // reads `spool.totalWeight` off this — it must stay the GROSS
      // post-decrement value (tare-inclusive), which it is. The null guard
      // is unreachable-in-practice.
      if (shape === "spool") {
        const spoolObj = findSpoolById(filament.toObject().spools, spoolId);
        if (!spoolObj) {
          return errorResponse("Spool not found", 404);
        }
        return NextResponse.json({ spool: spoolObj }, { status: 201 });
      }
      return NextResponse.json(filament.toObject(), { status: 201 });
    });
  } catch (err) {
    // GH #504: surface optimistic-concurrency conflicts as 409 (retryable),
    // not a misleading 500.
    const conflict = handleVersionError(err);
    if (conflict) return conflict;
    return errorResponseFromCaught(err, "Failed to log usage");
  }
}

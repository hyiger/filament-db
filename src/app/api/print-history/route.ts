import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import PrintHistory from "@/models/PrintHistory";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/print-history — list print history entries.
 *
 * Supports optional query params:
 *   ?filamentId=...  — only entries referencing this filament
 *   ?printerId=...   — only entries on this printer
 *   ?limit=N         — cap on results (default 100, max 1000)
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();
    const searchParams = request.nextUrl.searchParams;
    const filamentId = searchParams.get("filamentId");
    const printerId = searchParams.get("printerId");
    const limitRaw = parseInt(searchParams.get("limit") ?? "100", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 1000);

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (filamentId) filter["usage.filamentId"] = filamentId;
    if (printerId) filter.printerId = printerId;

    const entries = await PrintHistory.find(filter)
      .sort({ startedAt: -1 })
      .limit(limit)
      .populate("printerId", "name")
      .populate("usage.filamentId", "name vendor type color")
      .lean();
    return NextResponse.json(entries);
  } catch (err) {
    return errorResponse("Failed to fetch print history", 500, getErrorMessage(err));
  }
}

/**
 * POST /api/print-history — record a print job.
 *
 * Body shape:
 * {
 *   jobLabel: string,
 *   printerId?: string,
 *   startedAt?: ISO string,
 *   source?: "manual" | "prusaslicer" | "orcaslicer" | "bambu" | "other",
 *   notes?: string,
 *   usage: [{ filamentId: string, spoolId?: string, grams: number }]
 * }
 *
 * For each usage entry:
 *   - Appends a usageHistory entry to the referenced spool (or to the first
 *     non-retired spool if no spoolId is given). These are tagged with
 *     `source: "job"` so analytics knows they're already represented in the
 *     PrintHistory record and doesn't double-count them.
 *   - Decrements spool.totalWeight by `grams` (clamped at 0 — prevents
 *     negative weights when a bad estimate comes in).
 * Then persists the top-level PrintHistory record for queryable reporting.
 *
 * Atomicity: all referenced filaments are fetched and validated FIRST. Only
 * if every one is found do we apply the in-memory mutations and save. This
 * prevents a partial write where spool weights mutate but no PrintHistory
 * record gets created (e.g. because a later usage entry 404s).
 */
export async function POST(request: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  if (!body || typeof body !== "object") {
    return errorResponse("Request body must be an object", 400);
  }
  if (typeof body.jobLabel !== "string" || body.jobLabel.trim() === "") {
    return errorResponse("jobLabel is required", 400);
  }
  // Guard against arbitrarily long strings in fields that go straight to
  // the database. 200 for labels, 2000 for free-form notes — these are
  // generous for real usage but stop a malicious client from stuffing
  // megabytes into a single document.
  if (body.jobLabel.length > 200) {
    return errorResponse("jobLabel must be 200 characters or fewer", 400);
  }
  if (!Array.isArray(body.usage) || body.usage.length === 0) {
    return errorResponse("usage must be a non-empty array", 400);
  }
  if (body.usage.length > 100) {
    return errorResponse("usage may contain at most 100 entries", 400);
  }
  for (const u of body.usage) {
    if (!u || typeof u !== "object") {
      return errorResponse("each usage entry must be an object", 400);
    }
    if (typeof u.filamentId !== "string" || !mongoose.Types.ObjectId.isValid(u.filamentId)) {
      return errorResponse("usage[i].filamentId must be a valid id", 400);
    }
    if (typeof u.grams !== "number" || !Number.isFinite(u.grams) || u.grams < 0) {
      return errorResponse("usage[i].grams must be a non-negative number", 400);
    }
  }

  const source = (["manual", "prusaslicer", "orcaslicer", "bambu", "other"] as const).includes(
    body.source,
  )
    ? body.source
    : "manual";
  const startedAt = body.startedAt ? new Date(body.startedAt) : new Date();
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 2000) : "";
  const printerId =
    typeof body.printerId === "string" && mongoose.Types.ObjectId.isValid(body.printerId)
      ? body.printerId
      : null;

  try {
    await dbConnect();

    const usage = body.usage as {
      filamentId: string;
      spoolId?: string;
      grams: number;
    }[];

    // Pass 1: fetch every referenced filament up front so we can validate
    // existence before mutating anything. A missing filament aborts the
    // whole request with 404 and the DB stays untouched.
    const uniqueIds = Array.from(new Set(usage.map((u) => u.filamentId)));
    const filaments = await Filament.find({
      _id: { $in: uniqueIds },
      _deletedAt: null,
    });
    const byId = new Map(filaments.map((f) => [String(f._id), f]));
    for (const u of usage) {
      if (!byId.has(u.filamentId)) {
        return errorResponse(`Filament not found: ${u.filamentId}`, 404);
      }
    }

    // Pass 2: apply mutations to in-memory docs. A single filament can be
    // referenced by multiple usage entries in one job, so we mutate the
    // shared doc instance and save each filament once at the end.
    const resolvedUsage: {
      filamentId: mongoose.Types.ObjectId;
      spoolId: mongoose.Types.ObjectId | null;
      grams: number;
    }[] = [];

    for (const u of usage) {
      const filament = byId.get(u.filamentId)!;

      // Pick the target spool: explicit spoolId, else first non-retired spool
      // with non-null totalWeight, else the first non-retired spool.
      let spool = u.spoolId
        ? filament.spools.find((s) => String(s._id) === u.spoolId)
        : filament.spools.find(
            (s) => !s.retired && s.totalWeight !== null && s.totalWeight > 0,
          ) ?? filament.spools.find((s) => !s.retired);
      if (!spool && filament.spools.length > 0) {
        spool = filament.spools[0];
      }

      if (spool) {
        if (typeof spool.totalWeight === "number") {
          spool.totalWeight = Math.max(0, spool.totalWeight - u.grams);
        }
        spool.usageHistory = spool.usageHistory || [];
        spool.usageHistory.push({
          grams: u.grams,
          jobLabel: body.jobLabel.trim(),
          date: startedAt,
          // "job" tags this as owned by a PrintHistory record. Analytics
          // filters these out of the per-spool fallback so totals aren't
          // double-counted against the aggregated PrintHistory pass.
          source: "job",
        });
        resolvedUsage.push({
          filamentId: filament._id,
          spoolId: spool._id,
          grams: u.grams,
        });
      } else {
        resolvedUsage.push({
          filamentId: filament._id,
          spoolId: null,
          grams: u.grams,
        });
      }
    }

    // Persist. Prefer a transaction so a mid-write failure rolls back any
    // already-applied spool mutations, matching the reviewer's ask for
    // "transactions or defer all saves until validation passes" (we do
    // both). Transactions require a replica set — Atlas deployments have
    // this by default, local mongod may not. On a standalone server
    // startSession().withTransaction() throws with a specific error, so
    // we fall back to sequential saves. The fallback keeps the fix for
    // the original reviewer concern (the 404-in-middle case) but can't
    // protect against a mid-batch write failure on non-replicated setups.
    let history;
    try {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          for (const f of filaments) {
            await f.save({ session });
          }
          const created = await PrintHistory.create(
            [{
              jobLabel: body.jobLabel.trim(),
              printerId,
              usage: resolvedUsage,
              startedAt,
              source,
              notes,
            }],
            { session },
          );
          history = created[0];
        });
      } finally {
        await session.endSession();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTxnUnsupported =
        msg.includes("Transaction numbers are only allowed") ||
        msg.includes("not supported on standalone") ||
        msg.includes("IllegalOperation");
      if (!isTxnUnsupported) throw err;

      // Fallback path for non-replicated mongod (offline/test). Sequential
      // saves so a mid-loop failure is localized rather than spawning
      // concurrent partial commits across the array.
      for (const f of filaments) {
        await f.save();
      }
      history = await PrintHistory.create({
        jobLabel: body.jobLabel.trim(),
        printerId,
        usage: resolvedUsage,
        startedAt,
        source,
        notes,
      });
    }

    return NextResponse.json(history, { status: 201 });
  } catch (err) {
    return errorResponse("Failed to record print history", 500, getErrorMessage(err));
  }
}

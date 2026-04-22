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
 *     non-retired spool if no spoolId is given).
 *   - Decrements spool.totalWeight by `grams` (clamped at 0 — prevents
 *     negative weights when a bad estimate comes in).
 * Then persists the top-level PrintHistory record for queryable reporting.
 *
 * On any spool-update error, the whole operation aborts and the DB is left
 * untouched.
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
  if (!Array.isArray(body.usage) || body.usage.length === 0) {
    return errorResponse("usage must be a non-empty array", 400);
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
  const notes = typeof body.notes === "string" ? body.notes : "";
  const printerId =
    typeof body.printerId === "string" && mongoose.Types.ObjectId.isValid(body.printerId)
      ? body.printerId
      : null;

  try {
    await dbConnect();

    // Apply each usage entry: append to spool.usageHistory + decrement weight.
    const resolvedUsage: {
      filamentId: mongoose.Types.ObjectId;
      spoolId: mongoose.Types.ObjectId | null;
      grams: number;
    }[] = [];

    for (const u of body.usage as {
      filamentId: string;
      spoolId?: string;
      grams: number;
    }[]) {
      const filament = await Filament.findOne({
        _id: u.filamentId,
        _deletedAt: null,
      });
      if (!filament) {
        return errorResponse(`Filament not found: ${u.filamentId}`, 404);
      }

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
        // Decrement weight (clamp at 0). Skip if weight not tracked.
        if (typeof spool.totalWeight === "number") {
          spool.totalWeight = Math.max(0, spool.totalWeight - u.grams);
        }
        spool.usageHistory = spool.usageHistory || [];
        spool.usageHistory.push({
          grams: u.grams,
          jobLabel: body.jobLabel.trim(),
          date: startedAt,
          source: source === "manual" ? "manual" : "slicer",
        });
        resolvedUsage.push({
          filamentId: filament._id,
          spoolId: spool._id,
          grams: u.grams,
        });
      } else {
        // No spools at all — still record the usage at the filament level
        resolvedUsage.push({
          filamentId: filament._id,
          spoolId: null,
          grams: u.grams,
        });
      }

      await filament.save();
    }

    const history = await PrintHistory.create({
      jobLabel: body.jobLabel.trim(),
      printerId,
      usage: resolvedUsage,
      startedAt,
      source,
      notes,
    });

    return NextResponse.json(history, { status: 201 });
  } catch (err) {
    return errorResponse("Failed to record print history", 500, getErrorMessage(err));
  }
}

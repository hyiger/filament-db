import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { escapeRegex } from "@/lib/matchFilament";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * GET /api/spools/usage-search — cross-spool usage-ledger search (GH #1168).
 *
 * Manual usage entries (`source: "manual"`, `jobId: null`) exist ONLY inside
 * `Filament.spools[].usageHistory[]` — no other endpoint unwinds that array
 * across spools, so a jobLabel written on a manual entry had no surface where
 * it could ever be recalled. This aggregation unwinds every spool's ledger
 * into flat rows for the /history page's "Spool usage ledger" tab.
 *
 * Query params:
 *   - label:  case-insensitive substring of the entry's jobLabel
 *             (escapeRegex + the GH #513 128-char cap — same posture as
 *             /api/filaments/match, the other regex-compiling GET).
 *   - source: manual | slicer | job | nfc — the tab defaults to "manual",
 *             the entries that exist nowhere else; job/slicer entries are
 *             projections of PrintHistory rows (docs/api.md's jobs-vs-manual
 *             separation), so a merged default would double-show every job.
 *   - limit:  1..1000, default 100.
 *
 * Projection is strict per the GH #1005 posture — spools carry multi-MB
 * photoDataUrl blobs that must never ride a query that doesn't render them.
 * Read-only GET ⇒ no assertSameOriginRequest (the guard covers mutating
 * verbs, GH #360); the optional FILAMENTDB_API_KEY gate applies via proxy.
 *
 * Completeness caveat surfaced to the UI: per-spool ledgers are capped at
 * MAX_SPOOL_HISTORY (1000) entries with manual/nfc entries evicted FIRST
 * (src/lib/capUsageHistory.ts), so very old entries may be absent — the
 * page footnotes this rather than pretending the ledger is total.
 */

const VALID_SOURCES = new Set(["manual", "slicer", "job", "nfc"]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_LABEL_LENGTH = 128;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const rawLabel = params.get("label");
  const label = rawLabel ? rawLabel.trim() : "";
  if (label.length > MAX_LABEL_LENGTH) {
    return errorResponse(`label must be ${MAX_LABEL_LENGTH} characters or fewer`, 400);
  }

  const source = params.get("source");
  if (source && !VALID_SOURCES.has(source)) {
    return errorResponse("source must be one of manual, slicer, job, nfc", 400);
  }

  let limit = DEFAULT_LIMIT;
  const rawLimit = params.get("limit");
  if (rawLimit) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return errorResponse(`limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
    }
    limit = parsed;
  }

  try {
    await dbConnect();

    const entryMatch: Record<string, unknown> = {};
    if (label) {
      entryMatch["spools.usageHistory.jobLabel"] = {
        $regex: escapeRegex(label),
        $options: "i",
      };
    }
    if (source) {
      entryMatch["spools.usageHistory.source"] = source;
    }

    const rows = await Filament.aggregate([
      { $match: { _deletedAt: null } },
      // GH #1005: never let photoDataUrl / dryCycles ride the pipeline.
      {
        $project: {
          name: 1,
          vendor: 1,
          type: 1,
          color: 1,
          "spools._id": 1,
          "spools.label": 1,
          "spools.usageHistory": 1,
        },
      },
      { $unwind: "$spools" },
      { $unwind: "$spools.usageHistory" },
      ...(Object.keys(entryMatch).length > 0 ? [{ $match: entryMatch }] : []),
      { $sort: { "spools.usageHistory.date": -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          filamentId: "$_id",
          filamentName: "$name",
          vendor: "$vendor",
          type: "$type",
          color: "$color",
          spoolId: "$spools._id",
          spoolLabel: "$spools.label",
          date: "$spools.usageHistory.date",
          grams: "$spools.usageHistory.grams",
          jobLabel: "$spools.usageHistory.jobLabel",
          source: "$spools.usageHistory.source",
        },
      },
    ]);

    return NextResponse.json({ entries: rows, limit });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to search spool usage");
  }
}

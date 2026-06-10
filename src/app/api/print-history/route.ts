import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import PrintHistory from "@/models/PrintHistory";
import { getErrorMessage, errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

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

    // GH #630: these params are cast into ObjectId fields by the query
    // below — a malformed value throws a CastError that the catch maps to
    // a hardcoded 500. Bad input is the client's fault: validate up front
    // and 400 (same hex-24 pattern as the import-atlas / snapshot routes).
    const OID_RE = /^[a-f0-9]{24}$/i;
    if (filamentId && !OID_RE.test(filamentId)) {
      return errorResponse("filamentId must be a valid id", 400);
    }
    if (printerId && !OID_RE.test(printerId)) {
      return errorResponse("printerId must be a valid id", 400);
    }

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
  // GH #306: `new Date("garbage")` is an Invalid Date, not an error. Left
  // unvalidated it gets persisted into the PrintHistory doc and every
  // spool `usageHistory[].date`, then later 500s the analytics endpoint
  // (`.toISOString()` → RangeError) and breaks the DELETE refund's
  // date-match logic (`.getTime()` → NaN).
  if (Number.isNaN(startedAt.getTime())) {
    return errorResponse("startedAt is not a valid date", 400);
  }
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
      const filament = byId.get(u.filamentId);
      if (!filament) {
        return errorResponse(`Filament not found: ${u.filamentId}`, 404);
      }
      // If the caller named a specific spool, confirm it exists on this
      // filament before we mutate anything. Otherwise an invalid or stale
      // spoolId silently falls through to "first spool" in pass 2 and
      // debits the wrong inventory.
      if (u.spoolId) {
        const hasSpool = filament.spools.some(
          (s) => String(s._id) === u.spoolId,
        );
        if (!hasSpool) {
          return errorResponse(
            `Spool not found on filament ${u.filamentId}: ${u.spoolId}`,
            400,
          );
        }
      }
    }

    // GH #224: snapshot every spool's pre-mutation state BEFORE pass 2
    // so the standalone-fallback path can roll back on a mid-loop
    // failure. Captures the real pre-debit totalWeight so the
    // `Math.max(0, ...)` clamp inside pass 2 can't make rollback
    // ambiguous. The transaction branch doesn't need this — Mongo
    // aborts the txn for us — but the fallback runs save() one at a
    // time and would otherwise leak a partial debit if save #2 throws
    // after save #1 committed.
    type SpoolSnapshot = {
      filamentId: string;
      spoolId: string;
      totalWeight: number | null;
    };
    const spoolSnapshots: SpoolSnapshot[] = [];
    for (const f of filaments) {
      for (const s of f.spools) {
        spoolSnapshots.push({
          filamentId: String(f._id),
          spoolId: String(s._id),
          totalWeight: typeof s.totalWeight === "number" ? s.totalWeight : null,
        });
      }
    }

    // Pass 2: apply mutations to in-memory docs. A single filament can be
    // referenced by multiple usage entries in one job, so we mutate the
    // shared doc instance and save each filament once at the end.
    //
    // Generate the PrintHistory _id up front so each spool usageHistory
    // entry can carry a jobId pointing back at this job. The undo path
    // (DELETE /api/print-history/{id}) uses that linkage to refund the
    // exact entries this POST created — without it the undo previously
    // matched by `(grams, date)` and silently removed the wrong entry
    // when a manual usage log happened to share both.
    const historyId = new mongoose.Types.ObjectId();

    const resolvedUsage: {
      filamentId: mongoose.Types.ObjectId;
      spoolId: mongoose.Types.ObjectId | null;
      grams: number;
    }[] = [];

    for (const u of usage) {
      const filament = byId.get(u.filamentId)!;

      // Pick the target spool: explicit spoolId, else first non-retired
      // spool with non-null totalWeight, else any non-retired spool.
      //
      // GH #305: there is deliberately no fall-through to `spools[0]`.
      // When every spool is retired, `spool` stays undefined and the
      // `else` branch below records the usage with `spoolId: null` — a
      // print job must not silently debit a retired spool, which would
      // corrupt the retired spool's preserved history and under-count
      // active inventory. An explicit `u.spoolId` is honoured even when
      // retired (the caller named it on purpose; pass 1 already
      // confirmed it exists).
      const spool = u.spoolId
        ? filament.spools.find((s) => String(s._id) === u.spoolId)
        : filament.spools.find(
            (s) => !s.retired && s.totalWeight !== null && s.totalWeight > 0,
          ) ?? filament.spools.find((s) => !s.retired);

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
          jobId: historyId,
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
    // we fall back to sequential saves.
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
              _id: historyId,
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
      // GH #224: surface concurrent-edit conflicts (Mongoose
      // VersionError) as a 409 so the caller can re-fetch and retry
      // against the fresh state. Without OCC enabled on the Filament
      // schema this would never throw — but two near-simultaneous
      // print-history POSTs that both load the same filament document
      // would silently end with one job's grams debit lost
      // (last-writer-wins). The schema-level `optimisticConcurrency:
      // true` setting in src/models/Filament.ts makes this safe.
      if (err instanceof mongoose.Error.VersionError) {
        return errorResponse(
          "Filament was modified by another request during this job. Please retry.",
          409,
        );
      }
      if (!isTxnUnsupported) throw err;

      // Fallback path for non-replicated mongod (offline/test). Sequential
      // saves with explicit rollback on failure — without this, save #2
      // throwing after save #1 committed would leak a partial debit
      // (spool weight gone, no PrintHistory row, no refund path).
      const savedFilaments: typeof filaments = [];
      try {
        for (const f of filaments) {
          await f.save();
          savedFilaments.push(f);
        }
        history = await PrintHistory.create({
          _id: historyId,
          jobLabel: body.jobLabel.trim(),
          printerId,
          usage: resolvedUsage,
          startedAt,
          source,
          notes,
        });
      } catch (innerErr) {
        // Reset every already-persisted filament to its pre-call state.
        // Reload from DB to avoid version conflicts, then splice off any
        // usageHistory entries we'd pushed and restore the original
        // totalWeight from the snapshot.
        for (const f of savedFilaments) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fresh: any = await Filament.findById(f._id);
            if (!fresh) continue;
            for (const s of fresh.spools) {
              const snap = spoolSnapshots.find(
                (sn) =>
                  sn.filamentId === String(f._id) &&
                  sn.spoolId === String(s._id),
              );
              if (!snap) continue;
              if (snap.totalWeight != null) s.totalWeight = snap.totalWeight;
              if (Array.isArray(s.usageHistory)) {
                s.usageHistory = s.usageHistory.filter(
                  (e: { jobId?: unknown }) =>
                    String(e.jobId ?? "") !== String(historyId),
                );
              }
            }
            await fresh.save();
          } catch {
            // Best-effort rollback — if a save errors here, log via
            // the wrapper and continue. Manual reconciliation is
            // preferable to silently swallowing the original error.
          }
        }
        // GH #224: surface concurrent-edit conflicts as 409 here too —
        // the fallback path catches VersionError inside this inner try,
        // and rethrowing would surface as a generic 500 to the caller.
        if (innerErr instanceof mongoose.Error.VersionError) {
          return errorResponse(
            "Filament was modified by another request during this job. Please retry.",
            409,
          );
        }
        throw innerErr;
      }
    }

    return NextResponse.json(history, { status: 201 });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to record print history");
  }
}

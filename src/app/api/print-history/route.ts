import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import PrintHistory from "@/models/PrintHistory";
import { getErrorMessage, errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { capUsageHistory, MAX_SPOOL_HISTORY } from "@/lib/capUsageHistory";

/**
 * Thrown when a precondition that pass 1 validated no longer holds on the
 * document the transaction reloads fresh — a filament soft-deleted/purged, or an
 * explicitly-named spool deleted, in the window between pass-1 validation and
 * the reload. Carries the HTTP status the handler's outer catch should surface,
 * so the caller sees the SAME contract pass 1 enforces (404 for a missing
 * filament, 400 for a missing named spool) rather than a 500 from a null
 * dereference or a silent no-debit success (GH #949 Codex follow-up).
 *
 * The fix reloads filaments inside the transaction, so the pass-1 map is no
 * longer the one the debit runs against — these checks re-assert on the reloaded
 * doc what pass 1 asserted on the original.
 */
class JobPreconditionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "JobPreconditionError";
    this.status = status;
  }
}

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

    // Generate the PrintHistory _id up front so each spool usageHistory
    // entry can carry a jobId pointing back at this job. The undo path
    // (DELETE /api/print-history/{id}) uses that linkage to refund the
    // exact entries this POST created — without it the undo previously
    // matched by `(grams, date)` and silently removed the wrong entry
    // when a manual usage log happened to share both. Stable across
    // transaction retries so the linkage is consistent no matter how many
    // times the callback below reruns.
    const historyId = new mongoose.Types.ObjectId();

    // Pass 2, as a reusable step: pick the target spool for each usage entry,
    // debit its weight, append a `source: "job"` usageHistory entry tagged with
    // the jobId, and return the resolved usage for the PrintHistory record.
    //
    // Selection and mutation are intentionally COUPLED in one pass — a later
    // usage entry for the same filament must see the earlier debit (e.g. so a
    // debit that empties one spool routes the next entry to the following
    // spool). It runs against WHATEVER doc set it's handed: freshly-reloaded
    // docs inside the transaction (re-applied per retry attempt), or the pass-1
    // docs in the standalone fallback.
    //
    // GH #305: there is deliberately no fall-through to `spools[0]`. When every
    // spool is retired, `spool` stays undefined and the entry is recorded with
    // `spoolId: null` — a print job must not silently debit a retired spool,
    // which would corrupt its preserved history and under-count active
    // inventory. An explicit `u.spoolId` is honoured even when retired (pass 1
    // confirmed it exists).
    const applyJobToFilaments = (
      filamentsById: Map<string, (typeof filaments)[number]>,
    ) => {
      const resolved: {
        filamentId: mongoose.Types.ObjectId;
        spoolId: mongoose.Types.ObjectId | null;
        grams: number;
      }[] = [];
      // GH #954 finding #6: collect the spools this job appends to so each can be
      // trimmed exactly ONCE after every usage row is applied. Trimming inside
      // the loop could evict an entry an earlier row of THIS job just pushed when
      // two usage rows target the same spool.
      const touchedSpools = new Set<(typeof filaments)[number]["spools"][number]>();
      for (const u of usage) {
        // Pass 1 validated existence, but the transaction path reloads fresh —
        // a filament can be soft-deleted/purged in that window and drop out of
        // the reload's `_deletedAt: null` filter. Surface it as a 404 (via the
        // outer catch) instead of dereferencing undefined into a 500.
        const filament = filamentsById.get(u.filamentId);
        if (!filament) {
          throw new JobPreconditionError(`Filament not found: ${u.filamentId}`, 404);
        }
        const spool = u.spoolId
          ? filament.spools.find((s) => String(s._id) === u.spoolId)
          : filament.spools.find(
              (s) => !s.retired && s.totalWeight !== null && s.totalWeight > 0,
            ) ?? filament.spools.find((s) => !s.retired);

        // An explicitly-named spool that pass 1 confirmed can likewise be
        // deleted before the reload. Without this, `spool` is undefined and the
        // `else` branch below records the entry with `spoolId: null` and NO
        // debit — the job is silently accepted without touching the requested
        // inventory (and the undo path skips `spoolId: null`). Re-assert pass
        // 1's 400 contract instead. Only fires for a NAMED spool; the no-spoolId
        // auto-select path still legitimately yields null when every spool is
        // retired (Codex P2 follow-up).
        if (u.spoolId && !spool) {
          throw new JobPreconditionError(
            `Spool not found on filament ${u.filamentId}: ${u.spoolId}`,
            400,
          );
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
            jobId: historyId,
          });
          touchedSpools.add(spool);
          resolved.push({
            filamentId: filament._id,
            spoolId: spool._id,
            grams: u.grams,
          });
        } else {
          resolved.push({
            filamentId: filament._id,
            spoolId: null,
            grams: u.grams,
          });
        }
      }
      return { resolved, touchedSpools };
    };

    // GH #304 / #954 finding #6: cap each touched spool's usageHistory so a
    // looping client can't grow the filament document unbounded. Undo-aware
    // (capUsageHistory) rather than a plain `slice(-N)`: an OLD, still-live
    // `source:"job"`/`"slicer"` entry must not be evicted, because its later
    // DELETE /api/print-history refund keys off the entry still being present
    // (GH #621). Manual/nfc entries roll off first; this job's just-pushed
    // entries are the newest + undo-relevant, so they always survive. Returns
    // the spools whose array was actually shortened, so the fallback path knows
    // which filaments need a re-save.
    //
    // WHEN this runs matters (Codex P2 on PR #961). The trim evicts PRE-EXISTING
    // manual/nfc rows that this job never touched — so it must only become
    // durable together with the job:
    //   - Transaction path: trim BEFORE the saves, inside the txn, so a mid-write
    //     failure rolls the eviction back atomically with everything else.
    //   - Standalone fallback: trim only AFTER the job is durably written, so a
    //     rolled-back fallback request can't permanently delete rows it never
    //     meant to touch (the rollback restores totalWeight + strips this job's
    //     entries, but a fresh reload can't resurrect trimmed-away rows).
    const capTouchedSpools = (
      touched: Set<(typeof filaments)[number]["spools"][number]>,
    ) => {
      const changed = new Set<(typeof filaments)[number]["spools"][number]>();
      for (const spool of touched) {
        if (spool.usageHistory && spool.usageHistory.length > MAX_SPOOL_HISTORY) {
          spool.usageHistory = capUsageHistory(spool.usageHistory, MAX_SPOOL_HISTORY);
          changed.add(spool);
        }
      }
      return changed;
    };

    // Persist. Prefer a transaction so a mid-write failure rolls back any
    // already-applied spool mutations, matching the reviewer's ask for
    // "transactions or defer all saves until validation passes" (we do
    // both). Transactions require a replica set — Atlas deployments have
    // this by default, local mongod may not. On a standalone server
    // connection.transaction() throws with a specific error, so we fall
    // back to sequential saves.
    let history;
    try {
      // GH #949 (+ Codex P1 follow-up): reload the filaments FRESH inside the
      // transaction callback and (re-)apply the debit HERE, per attempt, rather
      // than saving docs mutated once outside it.
      //
      // Why not mutate outside and just save inside? connection.transaction()
      // only resets a saved doc's modified-path/version/atomics state between
      // retries when the CALLBACK THROWS (mongoose gh-13698 —
      // `_wrapUserTransaction`'s catch calls `_resetSessionDocuments`). That
      // covers an operation-time TransientTransactionError (a WriteConflict on
      // save() re-throws → reset → rerun). But a TransientTransactionError
      // raised by commitTransaction reruns this callback WITHOUT the reset (the
      // callback resolved; nothing threw). The prior save() already cleared each
      // outside doc's modified paths, so re-saving them would write an empty
      // delta and silently drop the spool debit + usageHistory entry while
      // PrintHistory still commits — the exact silent inventory drift this
      // change fixes, just moved to the commit-retry path.
      //
      // Reloading fresh each attempt reads the transaction's rolled-back
      // baseline, so `applyJobToFilaments` lands the debit exactly once per
      // committed attempt regardless of which retry (operation- or commit-time)
      // fired — the idempotent-callback contract MongoDB's withTransaction
      // expects. `historyId` is generated once outside, so PrintHistory keeps a
      // stable _id and jobId linkage across retries.
      await mongoose.connection.transaction(async (session) => {
        const txnFilaments = await Filament.find({
          _id: { $in: uniqueIds },
          _deletedAt: null,
        }).session(session);
        const txnById = new Map(
          txnFilaments.map((f) => [String(f._id), f] as const),
        );
        const { resolved: resolvedUsage, touchedSpools } = applyJobToFilaments(txnById);
        // Trim inside the txn, before the saves — a mid-write failure rolls the
        // eviction back atomically along with the debit (see capTouchedSpools).
        capTouchedSpools(touchedSpools);
        for (const f of txnFilaments) {
          // GH #905: this job only mutates spool weight + usageHistory. Validate
          // ONLY modified paths so a legacy out-of-range field elsewhere on the
          // filament (e.g. a temperature stored before the numeric validators
          // existed) can't throw a ValidationError and block the spool debit.
          // Safe here because `f` was loaded from the DB with all required
          // fields present (unlike a create, where omitted required fields must
          // still be caught — which is why this is per-save, not schema-wide).
          await f.save({ session, validateModifiedOnly: true });
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

      // Fallback path for non-replicated mongod (offline/test). No transaction
      // to roll back, so we apply the debit to the pass-1 docs here (the txn
      // callback above never ran — connection.transaction() throws before
      // invoking it on a standalone server, so `filaments` is still pristine),
      // then save sequentially with explicit rollback on failure — without
      // this, save #2 throwing after save #1 committed would leak a partial
      // debit (spool weight gone, no PrintHistory row, no refund path).
      const { resolved: resolvedUsage, touchedSpools } = applyJobToFilaments(byId);
      const savedFilaments: typeof filaments = [];
      try {
        for (const f of filaments) {
          await f.save({ validateModifiedOnly: true }); // GH #905 (see above)
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
            await fresh.save({ validateModifiedOnly: true }); // GH #905 (rollback debit)
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

      // The job is now durably recorded, so trimming here is safe (Codex P2 on
      // PR #961): unlike a trim baked into the debit save, an eviction applied
      // now can't be undone by a rollback that would otherwise orphan
      // pre-existing manual/nfc rows this job never meant to touch. Best-effort —
      // being a couple of entries over the cap until the next write is harmless,
      // and a trim-save failure must not turn an already-recorded job into an
      // error.
      const cappedSpools = capTouchedSpools(touchedSpools);
      if (cappedSpools.size > 0) {
        for (const f of filaments) {
          if (f.spools.some((s) => cappedSpools.has(s))) {
            try {
              await f.save({ validateModifiedOnly: true });
            } catch {
              // Best-effort cap; the job is already recorded.
            }
          }
        }
      }
    }

    return NextResponse.json(history, { status: 201 });
  } catch (err) {
    // A precondition pass 1 validated (filament exists / named spool exists) no
    // longer held on the doc the transaction reloaded (concurrent delete) —
    // surface the SAME status pass 1 would (404 / 400), not a 500 from a null
    // dereference or a silent no-debit success (GH #949 Codex follow-up). The
    // persist-block catch rethrows it here (neither a VersionError nor a
    // txn-unsupported error).
    if (err instanceof JobPreconditionError) {
      return errorResponse(err.message, err.status);
    }
    return errorResponseFromCaught(err, "Failed to record print history");
  }
}

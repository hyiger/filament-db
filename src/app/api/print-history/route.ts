import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament, { generateInstanceId } from "@/models/Filament";
import { hasVariants } from "@/lib/resolveFilament";
import { TEMPLATE_NO_SPOOLS_BODY } from "@/lib/spoolTemplateGuard";
import PrintHistory from "@/models/PrintHistory";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { getErrorMessage, errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { capUsageHistory, MAX_SPOOL_HISTORY, MAX_USAGE_GRAMS } from "@/lib/capUsageHistory";

/** What one migration attempt decided. `created` records the spool this
 *  request materialized (as opposed to one it ADOPTED from a peer that
 *  migrated first) — kept because the distinction is load-bearing for the
 *  reader even though nothing undoes it any more. */
interface MigrationResult {
  refusal?: string;
  created?: { id: mongoose.Types.ObjectId; spoolId: unknown; totalWeight: number };
}

/**
 * Thrown when a precondition pass 1 validated no longer holds on the document
 * the transaction reloads fresh (a filament soft-deleted/purged, or a named
 * spool deleted, in the window). Carries the HTTP status so the caller sees
 * the SAME contract pass 1 enforces (404 missing filament / 400 missing named
 * spool) rather than a 500 or a silent no-debit success (GH #949).
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

    // GH #630: a malformed id would CastError in the query and surface as a
    // 500 — validate up front and 400.
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
      .populate("usage.filamentId", "name vendor type color _deletedAt _purged")
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
 *     non-retired spool if no spoolId is given), tagged `source: "job"` so
 *     analytics doesn't double-count them against the PrintHistory record.
 *   - Decrements spool.totalWeight by `grams` (clamped at 0).
 * Then persists the top-level PrintHistory record.
 *
 * Atomicity: all referenced filaments are fetched and validated FIRST, so a
 * later usage entry's 404 can't leave a partial write.
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
  // Length caps (200 labels / 2000 notes) stop a client from stuffing
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
    // GH #1030: bound the MAGNITUDE too — `Number.isFinite` only excludes
    // Infinity/NaN, so 1e308 would persist and poison analytics aggregates.
    // Kept in lockstep with the spool usage route's identical cap.
    if (u.grams > MAX_USAGE_GRAMS) {
      return errorResponse(
        `usage[i].grams must be no greater than ${MAX_USAGE_GRAMS}`,
        400,
      );
    }
  }

  const source = (["manual", "prusaslicer", "orcaslicer", "bambu", "other"] as const).includes(
    body.source,
  )
    ? body.source
    : "manual";
  const startedAt = body.startedAt ? new Date(body.startedAt) : new Date();
  // GH #306: `new Date("garbage")` is an Invalid Date, not an error — left
  // unvalidated it persists, later 500s analytics (`.toISOString()`) and
  // breaks the DELETE refund's date-match (`.getTime()` → NaN).
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

    // Pass 1: validate existence of every referenced filament before
    // mutating anything — a miss aborts with 404, DB untouched.
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
      // A named spool must exist on this filament — otherwise an invalid or
      // stale spoolId silently falls through to "first spool" in pass 2 and
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

    // GH #1121: materialize a LEGACY single-spool filament (stock on the
    // filament's own `totalWeight`, no spools[]) as a real spool before
    // anything else touches it — otherwise pass 2 selects nothing and the
    // job records `spoolId: null` with NO debit while analytics still counts
    // the grams.
    //
    // Debiting the top-level field instead is not viable: `usageHistory`
    // lives only on a spool subdocument, so there would be no ledger entry
    // for the undo path to key on, and GH #621's "refund only when an entry
    // is actually removed" idempotency would degrade into an unbounded
    // double-refund on retry. `spoolId: null` is also already spoken for —
    // "every spool retired, deliberately no debit" (GH #305). Migrating
    // routes debit AND refund through existing machinery.
    //
    // ORDER IS LOAD-BEARING: this must land before `spoolSnapshots` is built
    // below. That snapshot drives the sequential-fallback rollback, which
    // `continue`s past any spool it has no entry for — skipping BOTH the
    // weight restore and the usageHistory strip, leaving an unrefundable
    // orphan on a rolled-back request.
    // MUST run while the filament's key is HELD, and — for the
    // single-filament job — the SAME hold that spans the debit: between two
    // separate acquisitions a confirmed first-variant creation can move the
    // just-materialized spool onto the promoted sibling and clear the
    // parent, after which pass 2 reloads an empty template and commits a 201
    // with spoolId: null and no debit. So the caller decides where this
    // runs; it never acquires the key itself.
    const migrateLegacyFilamentInLock = async (
      index: number,
    ): Promise<MigrationResult> => {
      const filament = filaments[index];
      if (!filament) return {};
      if (filament.spools.length > 0 || filament.totalWeight == null) return {};
      // Re-read under the key: the pass-1 doc was fetched before we held it,
      // so its spools/totalWeight may already be stale.
      const fresh = await Filament.findOne({
        _id: filament._id,
        _deletedAt: null,
      });
      if (!fresh) {
        // Vanished while we waited. Pass 2's in-transaction reload raises the
        // same 404 pass 1 would have; leave the stale handle for it to find.
        return {};
      }
      if (fresh.spools.length > 0 || fresh.totalWeight == null) {
        // Somebody else got here first. Two distinct cases, and the SECOND
        // is easy to mistake for "nothing to do":
        //   (a) already migrated — `spools` non-empty. ADOPT the fresh
        //       document into both handles: the standalone fallback reuses
        //       these docs, so a stale empty-spool copy would write a SECOND
        //       spoolId: null history row with no debit.
        //   (b) a confirmed first-variant promotion won the key: it moved
        //       the legacy weight to a sibling and CLEARED the parent, so
        //       this reads as `spools: []` + `totalWeight: null`. The parent
        //       is now a template, and recording the job against it would
        //       201 with no debit instead of the documented refusal.
        filaments[index] = fresh;
        byId.set(String(fresh._id), fresh);
        if (
          fresh.spools.length === 0 &&
          (await hasVariants(Filament, String(fresh._id)))
        ) {
          return { refusal: TEMPLATE_NO_SPOOLS_BODY.message };
        }
        // NOTHING was created here — the spool on `fresh` belongs to whoever
        // migrated first, and this request merely adopted it.
        return {};
      }
      // #605: inventory belongs on a template's variants, never on the
      // template. Same contract text the spool routes use, and it names an
      // action the user can take.
      if (await hasVariants(Filament, String(fresh._id))) {
        return { refusal: TEMPLATE_NO_SPOOLS_BODY.message };
      }
      fresh.spools.push({
        label: "",
        totalWeight: fresh.totalWeight,
        // Carry the filament-level id onto the roll it always described
        // (#732 Phase 1), so a printed label or NFC tag keeps resolving.
        instanceId: fresh.instanceId ?? generateInstanceId(),
      } as unknown as Parameters<typeof fresh.spools.push>[0]);
      // Matches POST /api/filaments, which nulls the legacy field the moment
      // a real spool exists — leaving it would let every
      // `spools.length === 0` fallback resurrect the roll.
      const legacyWeight = fresh.totalWeight as number;
      fresh.totalWeight = null;
      // `validateModifiedOnly` like every other persist path here (GH #905):
      // a full-document validate would reject a legacy record over a field
      // this request never touched.
      try {
        await fresh.save({ validateModifiedOnly: true });
      } catch (err) {
        // An out-of-process writer touched this document between the in-lock
        // read and this save — OCC turns that into a retryable VersionError;
        // surface the route's 409 contract rather than a 500.
        if (err instanceof mongoose.Error.VersionError) {
          throw new JobPreconditionError(
            "Filament was modified by another request during this job. Please retry.",
            409,
          );
        }
        throw err;
      }
      // REPLACE the pass-1 document rather than mirroring the spool onto it:
      // the pass-1 copy's `__v` is now one behind, so its next `save()`
      // would VersionError into the 409 retry contract on every legacy job.
      // Both handles have to move.
      filaments[index] = fresh;
      byId.set(String(fresh._id), fresh);
      // Report the exact spool THIS request created, plus the weight it
      // replaced.
      const created = fresh.spools[fresh.spools.length - 1];
      return {
        created: {
          id: fresh._id as mongoose.Types.ObjectId,
          spoolId: created._id,
          totalWeight: legacyWeight,
        },
      };
    };

    /**
     * The migration's REFUSAL decision alone, with no write — the preflight
     * the multi-filament path runs over every target first. Must hold the
     * filament's key, like the migration it precedes.
     */
    const checkLegacyMigrationAllowed = async (
      index: number,
    ): Promise<string | null> => {
      const filament = filaments[index];
      if (!filament) return null;
      if (filament.spools.length > 0 || filament.totalWeight == null) return null;
      const fresh = await Filament.findOne({
        _id: filament._id,
        _deletedAt: null,
      }).lean();
      if (!fresh) return null;
      if (fresh.spools.length > 0) return null;
      return (await hasVariants(Filament, String(fresh._id)))
        ? TEMPLATE_NO_SPOOLS_BODY.message
        : null;
    };

    // NOTE: there is deliberately NO rollback of a migration once a LATER
    // step fails. "Has anyone touched the new spool?" is an OPEN set (a peer
    // can rename/move/retire it or attach it to an AMS slot without writing
    // the filament), so the compensation can't be made safe by enumeration —
    // and the migration is a REPRESENTATION change, not a semantic one: the
    // same roll with the same grams, rendered identically everywhere. A
    // migration left behind by a refused job costs nothing; a wrong rollback
    // destroys a spool other requests can already see. The preflight above
    // keeps the DETERMINISTIC case (legacy roll listed before a legacy
    // template) from writing anything; a promotion landing between preflight
    // and migrate simply leaves the migrated row in its new shape.

    // GH #224: snapshot every spool's pre-mutation state BEFORE pass 2 so
    // the standalone-fallback path can roll back a mid-loop failure —
    // capturing the real pre-debit totalWeight so the `Math.max(0, ...)`
    // clamp can't make rollback ambiguous. The transaction branch doesn't
    // need this (Mongo aborts the txn).
    //
    // Rebuildable, because a legacy migration ADDS a spool and the rollback
    // `continue`s past any spool it has no entry for — on the
    // single-filament path the migration runs inside the persist's lock
    // hold, so the snapshot has to be (re)built there too.
    type SpoolSnapshot = {
      filamentId: string;
      spoolId: string;
      totalWeight: number | null;
    };
    const spoolSnapshots: SpoolSnapshot[] = [];
    const buildSpoolSnapshots = () => {
      spoolSnapshots.length = 0;
      for (const f of filaments) {
        for (const s of f.spools) {
          spoolSnapshots.push({
            filamentId: String(f._id),
            spoolId: String(s._id),
            totalWeight: typeof s.totalWeight === "number" ? s.totalWeight : null,
          });
        }
      }
    };
    buildSpoolSnapshots();

    // Generate the PrintHistory _id up front so each spool usageHistory
    // entry can carry a jobId — the DELETE refund uses that linkage to
    // remove exactly the entries this POST created (a `(grams, date)` match
    // can hit the wrong entry). Stable across transaction retries.
    const historyId = new mongoose.Types.ObjectId();

    // Pass 2, as a reusable step: pick the target spool per usage entry,
    // debit it, append the tagged usageHistory entry, return the resolved
    // usage. Selection and mutation are intentionally COUPLED in one pass —
    // a later usage entry for the same filament must see the earlier debit.
    // Runs against WHATEVER doc set it's handed (txn-reloaded docs per retry
    // attempt, or the pass-1 docs in the standalone fallback).
    //
    // GH #305: there is deliberately no fall-through to `spools[0]`. When
    // every spool is retired, the entry is recorded with `spoolId: null` — a
    // print job must not silently debit a retired spool. An explicit
    // `u.spoolId` is honoured even when retired.
    const applyJobToFilaments = (
      filamentsById: Map<string, (typeof filaments)[number]>,
    ) => {
      const resolved: {
        filamentId: mongoose.Types.ObjectId;
        spoolId: mongoose.Types.ObjectId | null;
        grams: number;
        debitedGrams?: number;
      }[] = [];
      // GH #954: collect the spools this job appends to so each is trimmed
      // exactly ONCE after every usage row — trimming inside the loop could
      // evict an entry an earlier row of THIS job just pushed.
      const touchedSpools = new Set<(typeof filaments)[number]["spools"][number]>();
      for (const u of usage) {
        // Pass 1 validated existence, but the transaction path reloads
        // fresh — a filament soft-deleted/purged in that window drops out of
        // the reload. Surface as a 404, not an undefined dereference.
        const filament = filamentsById.get(u.filamentId);
        if (!filament) {
          throw new JobPreconditionError(`Filament not found: ${u.filamentId}`, 404);
        }
        const spool = u.spoolId
          ? filament.spools.find((s) => String(s._id) === u.spoolId)
          : filament.spools.find(
              (s) => !s.retired && s.totalWeight !== null && s.totalWeight > 0,
            ) ?? filament.spools.find((s) => !s.retired);

        // An explicitly-named spool can likewise be deleted before the
        // reload — without this the `else` branch records `spoolId: null`
        // with NO debit and the job is silently accepted. Re-assert pass 1's
        // 400. Only fires for a NAMED spool; the no-spoolId auto-select
        // still legitimately yields null when every spool is retired.
        if (u.spoolId && !spool) {
          throw new JobPreconditionError(
            `Spool not found on filament ${u.filamentId}: ${u.spoolId}`,
            400,
          );
        }

        if (spool) {
          // GH #1074: record the grams ACTUALLY removed BEFORE the clamp —
          // the debit clamps at zero, and a refund of the full requested
          // `grams` would leave the spool with MORE weight than before the
          // job existed. The refund pays back `debitedGrams`; `grams` stays
          // the requested amount so analytics totals are unchanged. When
          // totalWeight is untracked (null) nothing is subtracted, and
          // recording the full amount preserves the legacy refund behavior.
          // The outer Math.max(0, ...) guards a legacy negative totalWeight
          // predating the route-level >= 0 validation.
          const debited =
            typeof spool.totalWeight === "number"
              ? Math.max(0, Math.min(spool.totalWeight, u.grams))
              : u.grams;
          if (typeof spool.totalWeight === "number") {
            spool.totalWeight = Math.max(0, spool.totalWeight - u.grams);
          }
          spool.usageHistory = spool.usageHistory || [];
          spool.usageHistory.push({
            grams: u.grams,
            jobLabel: body.jobLabel.trim(),
            date: startedAt,
            // "job" = owned by a PrintHistory record; analytics filters
            // these out of the per-spool fallback to avoid double-counting.
            source: "job",
            jobId: historyId,
            debitedGrams: debited,
          });
          touchedSpools.add(spool);
          resolved.push({
            filamentId: filament._id,
            spoolId: spool._id,
            grams: u.grams,
            debitedGrams: debited,
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

    // GH #304 / #954: cap each touched spool's usageHistory so a looping
    // client can't grow the filament document unbounded. Undo-aware
    // (capUsageHistory) rather than a plain `slice(-N)`: an OLD, still-live
    // `source:"job"`/`"slicer"` entry must not be evicted, because its later
    // DELETE refund keys off the entry still being present (GH #621);
    // manual/nfc entries roll off first.
    //
    // WHEN this runs matters — the trim evicts PRE-EXISTING rows this job
    // never touched, so it must only become durable together with the job:
    //   - Transaction path: trim BEFORE the saves, inside the txn, so a
    //     mid-write failure rolls the eviction back atomically.
    //   - Standalone fallback: trim only AFTER the job is durably written —
    //     a rollback can't resurrect trimmed-away rows.
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
    // already-applied spool mutations. Transactions require a replica set —
    // on a standalone server connection.transaction() throws with a
    // specific error, so we fall back to sequential saves.
    //
    // GH #605: the debit save is a SPOOL WRITE, so it must hold the same
    // per-filament mutex every promotion path holds — unserialized, a debit
    // landing between a promotion's snapshot read and its clearing write is
    // silently erased (the acknowledged debit + usageHistory entry end up on
    // NEITHER document). The lock closes the in-process window; the schema's
    // OCC (VersionError → 409 below) guards out-of-process writers.
    //
    // Lock discipline (never hold two filament keys at once):
    //   - SINGLE-filament jobs: hold that one key across the WHOLE persist,
    //     txn commit included — a transactional save is invisible until
    //     commit, so an in-lock save alone would still let a promotion
    //     snapshot pre-commit state after the key was released.
    //   - MULTI-filament jobs: a cross-filament transaction can't be
    //     protected one key at a time (its commit would need every touched
    //     key held simultaneously — exactly what the no-nested-locks rule
    //     forbids), so the job takes the sequential-saves path directly,
    //     each save under its own key, the explicit rollback below playing
    //     the transaction's role (same 409 contract). Mirrors the repo's
    //     other multi-filament spool writers.
    let history;

    // The transactional persist, extracted so the single-filament path can
    // hold its lock across it.
    const persistWithTransaction = async (): Promise<void> => {
      // GH #949: reload the filaments FRESH inside the transaction callback
      // and (re-)apply the debit HERE, per attempt — never save docs mutated
      // once outside it. connection.transaction() only resets a saved doc's
      // modified-path/version state between retries when the CALLBACK THROWS
      // (mongoose gh-13698); a TransientTransactionError raised by
      // commitTransaction reruns the callback WITHOUT the reset, so
      // re-saving outside docs would write an empty delta and silently drop
      // the debit while PrintHistory still commits. Reloading fresh each
      // attempt gives the idempotent-callback contract withTransaction
      // expects; `historyId` is generated once outside so the jobId linkage
      // is stable across retries.
      await mongoose.connection.transaction(async (session) => {
        const txnFilaments = await Filament.find({
          _id: { $in: uniqueIds },
          _deletedAt: null,
        }).session(session);
        const txnById = new Map(
          txnFilaments.map((f) => [String(f._id), f] as const),
        );
        const { resolved: resolvedUsage, touchedSpools } = applyJobToFilaments(txnById);
        // Trim inside the txn, before the saves (see capTouchedSpools).
        capTouchedSpools(touchedSpools);
        for (const f of txnFilaments) {
          // GH #905: validate ONLY modified paths so a legacy out-of-range
          // field elsewhere on the filament can't block the spool debit.
          // Safe because `f` was loaded from the DB with all required fields
          // present (unlike a create — which is why this is per-save, not
          // schema-wide).
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
    };

    // The sequential-saves persist — the standalone-mongod fallback, and the
    // multi-filament path. Returns the 409 response on a concurrent-edit
    // conflict, null on success; every other failure propagates.
    //
    // `lockEachSave: true` runs every filament save (debit, rollback, cap
    // trim) under that filament's own key, sequentially — never two keys at
    // once. `false` means the caller ALREADY holds the single relevant key
    // (re-acquiring it here would self-deadlock on the chained mutex).
    const persistSequential = async (
      lockEachSave: boolean,
    ): Promise<NextResponse | null> => {
      const withFilamentLock = <T,>(
        f: (typeof filaments)[number],
        fn: () => Promise<T>,
      ): Promise<T> =>
        lockEachSave ? runExclusive(filamentLockKey(f._id), fn) : fn();

      // Apply the debit to the pass-1 docs (on the standalone fallback the
      // txn callback never ran, so `filaments` is still pristine), then save
      // sequentially with explicit rollback — otherwise save #2 throwing
      // after save #1 committed leaks a partial debit with no refund path.
      const { resolved: resolvedUsage, touchedSpools } = applyJobToFilaments(byId);
      const savedFilaments: typeof filaments = [];
      try {
        for (const f of filaments) {
          // In-lock so this save can't land inside a promotion's
          // snapshot→clear window. The doc was loaded pre-lock; staleness is
          // covered by OCC — a promotion completing since pass 1 bumped __v,
          // so the save VersionErrors into the 409 retry contract.
          await withFilamentLock(f, async () => {
            await f.save({ validateModifiedOnly: true }); // GH #905 (see above)
          });
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
        // Reset every already-persisted filament: reload from DB (avoids
        // version conflicts), strip this job's usageHistory entries, restore
        // totalWeight from the snapshot. The rollback is a spool write too,
        // so it takes the same per-filament key (one at a time).
        for (const f of savedFilaments) {
          try {
            await withFilamentLock(f, async () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const fresh: any = await Filament.findById(f._id);
              if (!fresh) return;
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
            });
          } catch {
            // Best-effort rollback — continue; manual reconciliation beats
            // swallowing the original error.
          }
        }
        // GH #224: surface concurrent-edit conflicts as 409 here too —
        // rethrowing a VersionError would surface as a generic 500.
        if (innerErr instanceof mongoose.Error.VersionError) {
          return errorResponse(
            "Filament was modified by another request during this job. Please retry.",
            409,
          );
        }
        throw innerErr;
      }

      // The job is now durably recorded, so trimming here is safe (see
      // capTouchedSpools). Best-effort — a trim-save failure must not turn
      // an already-recorded job into an error.
      const cappedSpools = capTouchedSpools(touchedSpools);
      if (cappedSpools.size > 0) {
        for (const f of filaments) {
          if (f.spools.some((s) => cappedSpools.has(s))) {
            try {
              await withFilamentLock(f, async () => {
                await f.save({ validateModifiedOnly: true });
              });
            } catch {
              // Best-effort cap; the job is already recorded.
            }
          }
        }
      }
      return null;
    };

    if (uniqueIds.length === 1) {
      // Single-filament job: one key held across the whole persist (txn
      // commit included). No other key is ever taken inside the hold.
      const conflict = await runExclusive(
        filamentLockKey(uniqueIds[0]),
        async (): Promise<NextResponse | null> => {
          // Inside the hold that spans the debit — see
          // `migrateLegacyFilamentInLock`. Resolved by id rather than
          // assuming position 0: the lock is keyed on `uniqueIds[0]` and the
          // two must name the same row.
          const migration = await migrateLegacyFilamentInLock(
            filaments.findIndex((f) => String(f._id) === uniqueIds[0]),
          );
          if (migration.refusal) return errorResponse(migration.refusal, 400);
          buildSpoolSnapshots();
          try {
            await persistWithTransaction();
            return null;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isTxnUnsupported =
              msg.includes("Transaction numbers are only allowed") ||
              msg.includes("not supported on standalone") ||
              msg.includes("IllegalOperation");
            // GH #224: surface VersionError as 409 so the caller can
            // re-fetch and retry. In-process this can no longer fire (the
            // lock serializes every same-family spool writer); it stays as
            // the guard for out-of-process writers.
            if (err instanceof mongoose.Error.VersionError) {
              return errorResponse(
                "Filament was modified by another request during this job. Please retry.",
                409,
              );
            }
            if (!isTxnUnsupported) throw err;

            // Standalone-mongod fallback — already inside the single
            // filament's lock hold.
            return await persistSequential(false);
          }
        },
      );
      if (conflict) return conflict;
    } else {
      // Multi-filament job: sequential per-filament locked saves — see the
      // lock-discipline note above for why the cross-filament transaction
      // cannot be used here. A continuous hold is impossible for the same
      // reason, so this path keeps the pre-existing window in which a
      // concurrent promotion can move a spool out from under a job.
      //
      // PREFLIGHT every target before migrating any of them: this route is
      // all-or-nothing, and with a single pass an ordinary legacy roll
      // listed before a legacy TEMPLATE would already be rewritten by the
      // time the template's refusal returned the 400. The check is read-only
      // and takes each key exactly as the migration will.
      for (let i = 0; i < filaments.length; i++) {
        const refusal = await runExclusive(filamentLockKey(filaments[i]._id), () =>
          checkLegacyMigrationAllowed(i),
        );
        if (refusal) return errorResponse(refusal, 400);
      }
      // ...then migrate. A target that turns into a template in the gap
      // still refuses, and any migration already applied is LEFT IN PLACE
      // (see the no-rollback note above).
      for (let i = 0; i < filaments.length; i++) {
        const migration = await runExclusive(
          filamentLockKey(filaments[i]._id),
          () => migrateLegacyFilamentInLock(i),
        );
        if (migration.refusal) return errorResponse(migration.refusal, 400);
      }
      buildSpoolSnapshots();
      const conflict = await persistSequential(true);
      if (conflict) return conflict;
    }

    return NextResponse.json(history, { status: 201 });
  } catch (err) {
    // See JobPreconditionError: surface the SAME status pass 1 would.
    if (err instanceof JobPreconditionError) {
      return errorResponse(err.message, err.status);
    }
    return errorResponseFromCaught(err, "Failed to record print history");
  }
}

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
/** What one migration attempt decided. `created` records the spool this
 *  request materialized (as opposed to one it ADOPTED from a peer that
 *  migrated first) — kept because the distinction is load-bearing for the
 *  reader even though nothing undoes it any more. */
interface MigrationResult {
  refusal?: string;
  created?: { id: mongoose.Types.ObjectId; spoolId: unknown; totalWeight: number };
}

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
    // GH #1030: bound the MAGNITUDE too — `Number.isFinite` only excludes
    // Infinity/NaN, so 1e308 persisted here and poisoned every analytics
    // aggregate. Kept in lockstep with the spool usage route's identical cap;
    // see MAX_USAGE_GRAMS for the bound's derivation.
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

    // GH #1121: materialize a LEGACY single-spool filament before anything
    // else touches it.
    //
    // A legacy roll keeps its stock on the filament's own `totalWeight` with
    // no spools[] subdocument, so pass 2's selection found nothing and the job
    // was recorded with `spoolId: null` and NO debit — analytics reported the
    // grams and the cost while the remaining weight never moved.
    //
    // Debiting the top-level field instead is not viable: `usageHistory` lives
    // only on a spool subdocument, so there would be no ledger entry for the
    // undo path to key on, and GH #621's "refund only when an entry is
    // actually removed" idempotency would degrade into an unbounded
    // double-refund on retry. `spoolId: null` is also already spoken for — it
    // means "every spool retired, deliberately no debit" (GH #305).
    //
    // Migrating is what the app already tells users to do (the /inventory row
    // for a legacy roll links to "Manage on filament →"), and it makes the
    // debit AND the refund run through existing machinery: a real spoolId, a
    // real usageHistory entry, `debitedGrams`, all three DELETE matcher tiers.
    //
    // ORDER IS LOAD-BEARING: this must land before `spoolSnapshots` is built
    // below. That snapshot drives the sequential-fallback rollback, which
    // `continue`s past any spool it has no entry for — skipping BOTH the
    // weight restore and the usageHistory strip. A spool created afterwards
    // would leave an unrefundable orphan on a rolled-back request.
    // MUST run while the filament's key is HELD, and — for the single-filament
    // job — the SAME hold that spans the debit (Codex P1 ×2). Two separate
    // acquisitions are not enough: between releasing the migration's lock and
    // taking the persist's, a confirmed first-variant creation can move the
    // just-materialized spool onto the promoted sibling and clear the parent,
    // after which pass 2 reloads an empty template, selects no spool, and
    // commits a 201 with spoolId: null and no debit — the exact bug this
    // change fixes, converted from deterministic into racy. So the caller
    // decides where this runs; it never acquires the key itself.
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
        // Somebody else got here first. Two distinct cases, and the SECOND is
        // easy to mistake for "nothing to do" (Codex P1 ×2):
        //
        //   (a) already migrated — `spools` non-empty. ADOPT the fresh
        //       document into both handles before returning. The transaction
        //       path reloads for itself, but the standalone fallback reuses
        //       these docs, so returning the stale empty-spool copy applied
        //       the job to a filament with no spools and wrote a SECOND
        //       spoolId: null history row with no debit.
        //
        //   (b) a confirmed first-variant promotion won the key: it moved the
        //       legacy weight to a sibling and CLEARED the parent, so this
        //       reads as `spools: []` + `totalWeight: null` — indistinguishable
        //       from harmless unless we ask. The parent is now a template, and
        //       recording the job against it would 201 with no debit instead
        //       of the refusal this route documents.
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
      // Matches POST /api/filaments, which nulls the legacy field the moment a
      // real spool exists. Leaving it would let every `spools.length === 0`
      // fallback resurrect the roll if this spool were later deleted.
      const legacyWeight = fresh.totalWeight as number;
      fresh.totalWeight = null;
      // `validateModifiedOnly` like every other persist path here (GH #905): a
      // full-document validate would reject a legacy record carrying a value
      // that predates current validators — refusing the slicer's job over a
      // field this request never touched, on exactly the old records this
      // change exists to serve.
      try {
        await fresh.save({ validateModifiedOnly: true });
      } catch (err) {
        // Another writer (a second deployment sharing the DB, the sync
        // service) touched this document between the in-lock read and this
        // save. The schema's optimistic concurrency turns that into a
        // VersionError, which is retryable — surface the route's established
        // 409 contract rather than letting it fall out as a 500 (Codex P2).
        if (err instanceof mongoose.Error.VersionError) {
          throw new JobPreconditionError(
            "Filament was modified by another request during this job. Please retry.",
            409,
          );
        }
        throw err;
      }
      // REPLACE the pass-1 document rather than mirroring the spool onto it:
      // the snapshot builder and the standalone fallback both reuse these
      // docs, and the pass-1 copy's `__v` is now one behind the save we just
      // made — its next `save()` would VersionError into the 409 retry
      // contract on every legacy job. Both handles have to move.
      filaments[index] = fresh;
      byId.set(String(fresh._id), fresh);
      // Report the exact spool THIS request created, plus the weight it
      // replaced, so a later failure can undo precisely this and nothing else.
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
    // step fails. That was tried and removed (Codex P1 ×2).
    //
    // The undo has to be conditional, because between migrating filament A
    // and failing on filament B this request holds no key on A and another
    // request can act on A's new spool. But "has anyone touched it?" is an
    // OPEN set: the weight and usageHistory are only the beginning — a peer
    // can rename the spool's label, move its location, retire it, log a dry
    // cycle, change its instanceId, or attach it to an AMS slot WITHOUT
    // writing to the filament at all. Every predicate added closes one hole
    // and leaves the next; the compensation can't be made safe by
    // enumeration.
    //
    // And what it protects is nearly nothing. The migration is a
    // REPRESENTATION change, not a semantic one: `{spools: [], totalWeight:
    // 1000}` and `{spools: [{totalWeight: 1000}], totalWeight: null}` are the
    // same roll with the same grams, both rendered identically by every
    // surface (see the legacy branches in src/lib/inventoryStats.ts), and the
    // second is the shape the app already asks users to migrate to. So a
    // migration left behind by a refused job costs the user nothing, while a
    // wrong rollback destroys a spool other requests can already see.
    //
    // The preflight above is what keeps the DETERMINISTIC case — an ordinary
    // legacy roll listed before a legacy template — from writing anything at
    // all. What remains is a promotion landing between the preflight and the
    // migrate pass, and there the migrated row is simply left in its new,
    // equivalent shape.

    // GH #224: snapshot every spool's pre-mutation state BEFORE pass 2
    // so the standalone-fallback path can roll back on a mid-loop
    // failure. Captures the real pre-debit totalWeight so the
    // `Math.max(0, ...)` clamp inside pass 2 can't make rollback
    // ambiguous. The transaction branch doesn't need this — Mongo
    // aborts the txn for us — but the fallback runs save() one at a
    // time and would otherwise leak a partial debit if save #2 throws
    // after save #1 committed.
    //
    // Rebuildable, because a legacy migration ADDS a spool and the rollback
    // `continue`s past any spool it has no entry for — skipping both the
    // weight restore and the usageHistory strip, i.e. leaving an unrefundable
    // orphan. On the single-filament path the migration now runs inside the
    // persist's lock hold, so the snapshot has to be (re)built there too.
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
        debitedGrams?: number;
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
          // GH #1074: record the grams ACTUALLY removed BEFORE the clamp.
          // The debit clamps at zero, so a job bigger than the spool's
          // remaining weight silently absorbs the shortfall — and the
          // DELETE refund used to restore the full requested `grams`,
          // leaving the spool with MORE weight than before the job existed
          // (unbounded when netFilamentWeight is null). The refund now pays
          // back `debitedGrams`; `grams` stays the requested/consumed
          // amount so analytics totals are unchanged. When totalWeight is
          // untracked (null) nothing is subtracted here, and recording the
          // full amount preserves the legacy refund behavior for that edge.
          // The outer Math.max(0, ...) guards a legacy negative totalWeight
          // that predates the route-level >= 0 validation.
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
            // "job" tags this as owned by a PrintHistory record. Analytics
            // filters these out of the per-spool fallback so totals aren't
            // double-counted against the aggregated PrintHistory pass.
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
    //
    // GH #605 round 12: the debit save is a SPOOL WRITE, so it must hold the
    // same per-filament mutex every promotion path holds — unserialized, a
    // debit landing between a promotion's snapshot read and its clearing
    // write was silently erased (the promoted copy is minted from the
    // pre-debit snapshot; completeParentPromotion then unconditionally
    // clears the parent's spools after this route already 201'd, so the
    // acknowledged debit + usageHistory entry exist on NEITHER document).
    // The lock closes the in-process window; the schema's OCC (VersionError
    // → 409 below) stays as the guard for out-of-process writers.
    //
    // Lock discipline (the established no-nested-locks rule — never hold two
    // filament keys at once):
    //   - SINGLE-filament jobs (every usage row addresses one filament — the
    //     common case): hold that one key across the WHOLE persist, txn
    //     commit included. A transactional save is invisible until commit,
    //     so an in-lock save alone would still let a promotion snapshot
    //     pre-commit state after the key was released and erase the debit
    //     right after it commits; spanning the commit closes that gap.
    //   - MULTI-filament jobs: a cross-filament transaction can't be
    //     protected one key at a time (its commit would need every touched
    //     key held simultaneously — exactly what the no-nested-locks rule
    //     forbids), so the job takes the sequential-saves path directly:
    //     each filament's save runs under its own key, acquired and released
    //     one at a time, and the explicit rollback below plays the role the
    //     transaction played (same 409 contract; each single-doc save is
    //     individually atomic). This mirrors the repo's other multi-filament
    //     spool writers (POST /api/spools/import, the CSV importer).
    let history;

    // The transactional persist, extracted so the single-filament path can
    // hold its lock across it (GH #949 reload-fresh-per-attempt semantics
    // unchanged — see the comment inside).
    const persistWithTransaction = async (): Promise<void> => {
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
    };

    // The sequential-saves persist — the standalone-mongod fallback, and the
    // multi-filament path (see the round-12 lock-discipline note above).
    // Returns the 409 response on a concurrent-edit conflict, null on
    // success; every other failure propagates to the route-level catch.
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
      // txn callback above never ran — connection.transaction() throws
      // before invoking it — so `filaments` is still pristine), then save
      // sequentially with explicit rollback on failure — without this, save
      // #2 throwing after save #1 committed would leak a partial debit
      // (spool weight gone, no PrintHistory row, no refund path).
      const { resolved: resolvedUsage, touchedSpools } = applyJobToFilaments(byId);
      const savedFilaments: typeof filaments = [];
      try {
        for (const f of filaments) {
          // GH #605 round 12: in-lock so this save can't land inside a
          // promotion's snapshot→clear window. The doc was loaded in pass 1
          // (pre-lock); staleness is covered by OCC — a promotion completing
          // between pass 1 and this hold bumped __v (the $inc in
          // completeParentPromotion), so the save VersionErrors into the
          // 409 retry contract below instead of writing anything.
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
        // Reset every already-persisted filament to its pre-call state.
        // Reload from DB to avoid version conflicts, then splice off any
        // usageHistory entries we'd pushed and restore the original
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
      // Single-filament job: one key held across the whole persist — the
      // txn attempt (commit included) and, on standalone mongod, the
      // sequential fallback. No other key is ever taken inside the hold.
      const conflict = await runExclusive(
        filamentLockKey(uniqueIds[0]),
        async (): Promise<NextResponse | null> => {
          // Inside the hold that spans the debit — see the note on
          // `migrateLegacyFilamentInLock`. Resolved by id rather than assuming
          // position 0: pass 1 guarantees one document per unique id, but the
          // lock is keyed on `uniqueIds[0]` and the two must name the same row.
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
            // GH #224: surface concurrent-edit conflicts (Mongoose
            // VersionError) as a 409 so the caller can re-fetch and retry
            // against the fresh state. In-process this can no longer fire
            // (the round-12 lock serializes every same-family spool
            // writer); it stays as the guard for out-of-process writers
            // (a second deployment sharing the DB, the sync service,
            // direct DB writes). The schema-level `optimisticConcurrency:
            // true` setting in src/models/Filament.ts makes this safe.
            if (err instanceof mongoose.Error.VersionError) {
              return errorResponse(
                "Filament was modified by another request during this job. Please retry.",
                409,
              );
            }
            if (!isTxnUnsupported) throw err;

            // Fallback path for non-replicated mongod (offline/test) —
            // already inside the single filament's lock hold.
            return await persistSequential(false);
          }
        },
      );
      if (conflict) return conflict;
    } else {
      // Multi-filament job: sequential per-filament locked saves — see the
      // round-12 lock-discipline note above for why the cross-filament
      // transaction cannot be used here. Each legacy migration takes its own
      // key, one at a time, exactly like the saves that follow; a continuous
      // hold is impossible here for the same reason the transaction is (it
      // would need every touched key at once), so this path keeps the
      // pre-existing window in which a concurrent promotion can move a spool
      // out from under a job — the same window an already-spooled filament
      // has always had on this path.
      //
      // PREFLIGHT every target before migrating any of them (Codex P2). This
      // route is all-or-nothing, and with a single pass an ordinary legacy
      // roll listed before a legacy TEMPLATE had already been rewritten
      // (spool created, `totalWeight` nulled) by the time the template's
      // refusal returned the 400 — no history row, but one filament silently
      // restructured by a request that failed. The check is read-only and
      // takes each key exactly as the migration will.
      for (let i = 0; i < filaments.length; i++) {
        const refusal = await runExclusive(filamentLockKey(filaments[i]._id), () =>
          checkLegacyMigrationAllowed(i),
        );
        if (refusal) return errorResponse(refusal, 400);
      }
      // ...then migrate. A target that turns into a template in the gap
      // between the two passes still refuses, and any migration already
      // applied is LEFT IN PLACE — see the note on the migration helper for
      // why undoing it is worse than keeping it.
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

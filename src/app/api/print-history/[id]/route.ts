import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import PrintHistory from "@/models/PrintHistory";
import Filament from "@/models/Filament";
import Printer from "@/models/Printer";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { errorResponseFromCaught, getErrorMessage, errorResponse, handleVersionError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { MAX_USAGE_GRAMS } from "@/lib/capUsageHistory";

/**
 * GET /api/print-history/{id} — fetch a single job by id, matching the list
 * endpoint's population. `_deletedAt: null` so a tombstoned job isn't
 * resurrected.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await dbConnect();
    const { id } = await params;
    if (!mongoose.isValidObjectId(id)) {
      return errorResponse("Invalid id", 400);
    }
    // Touch the Printer model so populate("printerId", ...) resolves even
    // after a mongoose model reset (tests/setup.ts caveat).
    void Printer.modelName;
    const entry = await PrintHistory.findOne({ _id: id, _deletedAt: null })
      .populate("printerId", "name")
      .populate("usage.filamentId", "name vendor type color")
      .lean();
    if (!entry) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(entry);
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to load print history entry");
  }
}

/**
 * PUT /api/print-history/{id} — edit a job's metadata fields (jobLabel,
 * notes, startedAt, source, printerId).
 *
 * `usage[]` changes are intentionally NOT accepted: adjusting gram counts
 * would require a refund-and-recharge dance against every referenced spool
 * with the same parent-lookup/clamp logic as DELETE. A request that includes
 * `usage` is rejected.
 */
const EDITABLE_FIELDS = ["jobLabel", "notes", "startedAt", "source", "printerId"] as const;
const VALID_SOURCES = new Set(["manual", "prusaslicer", "orcaslicer", "bambu", "other"]);

/**
 * GH #1004 F6: stamp this job's id onto the legacy (pre-jobId) usageHistory
 * entries it created, so a later DELETE refund resolves them by jobId
 * instead of by the now-stale (grams, startedAt) tuple — editing startedAt
 * leaves each legacy entry's `date` at its ORIGINAL value, so the tier-3
 * matcher would miss and the spool weight would silently never refund.
 *
 * One entry consumed per usage row, matched on the row's grams + the job's
 * OLD startedAt, restricted to print-driven ("job"/"slicer") entries with no
 * jobId — the exact candidate set the DELETE tier-3 matcher uses. Reloading
 * + saving per row means an already-stamped entry is skipped by `!h.jobId`,
 * so two rows against the same spool consume distinct entries.
 *
 * GH #1074: deliberately does NOT stamp `debitedGrams` — the actually
 * debited amount for a pre-#1074 row is unknowable after the fact; the
 * DELETE refund falls back to the full-`grams` refund for exactly these
 * rows.
 */
async function backfillLegacyUsageJobIds(
  jobId: string,
  usage: Array<{ filamentId?: unknown; spoolId?: unknown; grams?: unknown }>,
  oldStartedMs: number,
): Promise<void> {
  const jobObjectId = new mongoose.Types.ObjectId(jobId);
  for (const u of usage) {
    if (!u.filamentId || !u.spoolId || typeof u.grams !== "number") continue;
    // GH #605: the jobId stamp is a spool-subdocument write, so it runs
    // under the filament's key — unserialized, a stamp landing inside a
    // promotion's snapshot→clear window is silently erased. One key per row,
    // sequentially (no-nested-locks). A row whose spool a completed
    // promotion already MOVED simply misses here — no worse than before the
    // stamp existed.
    await runExclusive(filamentLockKey(String(u.filamentId)), async () => {
      const filament = await Filament.findOne({
        _id: u.filamentId as mongoose.Types.ObjectId,
        _deletedAt: null,
      });
      if (!filament) return;
      const spool = filament.spools.find((s) => String(s._id) === String(u.spoolId));
      if (!spool) return;
      const history = spool.usageHistory || [];
      const idx = history.findIndex(
        (h) =>
          !h.jobId &&
          (h.source === "job" || h.source === "slicer") &&
          h.grams === u.grams &&
          h.date instanceof Date &&
          h.date.getTime() === oldStartedMs,
      );
      if (idx === -1) return;
      history[idx].jobId = jobObjectId;
      // GH #905: validate modified paths only so a legacy out-of-range field
      // elsewhere can't block the backfill.
      await filament.save({ validateModifiedOnly: true });
    });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }
  if (!body || typeof body !== "object") {
    return errorResponse("Request body must be an object", 400);
  }
  if ("usage" in body) {
    return errorResponse(
      "Editing usage[] requires delete + recreate so spool weights stay reconciled. PUT only accepts metadata fields (jobLabel, notes, startedAt, source, printerId).",
      400,
    );
  }

  try {
    await dbConnect();
    const { id } = await params;
    if (!mongoose.isValidObjectId(id)) {
      return errorResponse("Invalid id", 400);
    }

    // Mirror POST /api/print-history's size caps (jobLabel 200 / notes 2000)
    // so a client can't bypass them by creating normally then PUT'ing a
    // multi-megabyte string.
    const update: Record<string, unknown> = {};
    if (typeof body.jobLabel === "string") {
      const trimmed = body.jobLabel.trim();
      if (!trimmed) return errorResponse("jobLabel cannot be empty", 400);
      update.jobLabel = trimmed.slice(0, 200);
    }
    if (typeof body.notes === "string") update.notes = body.notes.slice(0, 2000);
    if (typeof body.startedAt === "string" || body.startedAt instanceof Date) {
      const d = new Date(body.startedAt as string);
      if (Number.isNaN(d.getTime())) return errorResponse("startedAt is not a valid date", 400);
      update.startedAt = d;
    }
    if (typeof body.source === "string") {
      if (!VALID_SOURCES.has(body.source)) {
        return errorResponse(`source must be one of: ${[...VALID_SOURCES].join(", ")}`, 400);
      }
      update.source = body.source;
    }
    if ("printerId" in body) {
      if (body.printerId === null) {
        update.printerId = null;
      } else if (typeof body.printerId === "string" && mongoose.isValidObjectId(body.printerId)) {
        update.printerId = body.printerId;
      } else {
        return errorResponse("printerId must be a valid ObjectId or null", 400);
      }
    }

    // Refuse unknown fields rather than silently dropping them — a stray
    // `_purged: true` or `_deletedAt: null` in the body should not slip
    // through and surprise the caller.
    const unknownKeys = Object.keys(body).filter(
      (k) => !(EDITABLE_FIELDS as readonly string[]).includes(k),
    );
    if (unknownKeys.length > 0) {
      return errorResponse(
        `Unknown field(s): ${unknownKeys.join(", ")}. Editable: ${EDITABLE_FIELDS.join(", ")}.`,
        400,
      );
    }
    if (Object.keys(update).length === 0) {
      return errorResponse("Request body must include at least one editable field", 400);
    }

    // GH #1004 F6: when startedAt actually changes, immunise this job's
    // legacy usage entries against the date drift (see
    // backfillLegacyUsageJobIds).
    if (update.startedAt instanceof Date) {
      const existing = await PrintHistory.findOne({ _id: id, _deletedAt: null })
        .select("startedAt usage")
        .lean();
      if (!existing) {
        return errorResponse("Not found", 404);
      }
      const oldStartedMs =
        existing.startedAt instanceof Date ? existing.startedAt.getTime() : NaN;
      if (!Number.isNaN(oldStartedMs) && oldStartedMs !== update.startedAt.getTime()) {
        await backfillLegacyUsageJobIds(id, existing.usage ?? [], oldStartedMs);
      }
    }

    const updated = await PrintHistory.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      { $set: update },
      { returnDocument: "after", runValidators: true },
    ).lean();
    if (!updated) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(updated);
  } catch (err) {
    // A jobId backfill save() can race a concurrent slicer POST / DELETE on
    // the same filament — surface as 409 (retryable) like the DELETE handler,
    // not a generic 500.
    const conflict = handleVersionError(err);
    if (conflict) return conflict;
    return errorResponseFromCaught(err, "Failed to update print history entry");
  }
}

/**
 * DELETE /api/print-history/{id} — remove a print history entry and refund
 * the corresponding spool weight. The refund is best-effort: a since-deleted
 * spool still lets the history entry go.
 *
 * GH #621: each usage row's refund is conditioned on its matching
 * usageHistory entry actually being removed in this pass, so a retry after a
 * mid-loop failure (the 409 path) can't refund an already-refunded spool
 * again.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
    const { id } = await params;

    // GH #524.5: ?permanent=true sets the `_purged` tombstone. Gated on the
    // row ALREADY being soft-deleted so an accidental purge on an active
    // entry can't skip the refund + soft-delete step; idempotent (a second
    // purge 404s via `_purged: { $ne: true }`). No refund here — the spool
    // weight was already refunded on the soft delete.
    const permanent = request.nextUrl.searchParams.get("permanent") === "true";
    if (permanent) {
      const trashed = await PrintHistory.findOne({
        _id: id,
        _deletedAt: { $ne: null },
        _purged: { $ne: true },
      });
      if (!trashed) {
        return errorResponse(
          "Not found, or not in trash (permanent delete requires the entry to be soft-deleted first)",
          404,
        );
      }
      await PrintHistory.updateOne({ _id: id }, { $set: { _purged: true } });
      return NextResponse.json({ message: "Permanently deleted" });
    }

    // Filter on _deletedAt: null so a retry / double-click can't re-run the
    // refund loop on an already tombstoned entry and refund again.
    const entry = await PrintHistory.findOne({ _id: id, _deletedAt: null });
    if (!entry) {
      return errorResponse("Not found", 404);
    }

    // GH #605: each row's refund is a SPOOL WRITE, so the whole
    // load-mutate-save runs under the owning filament's key — unserialized,
    // a refund save landing between a promotion's snapshot read and its
    // clearing write is silently erased while the promoted copy still
    // carries the debit.
    //
    // The row's spool can also have MOVED before this loop runs: a completed
    // promotion remaps this row's `filamentId` onto the promoted variant
    // (remapExternalSpoolRefs), and the `entry` loaded above may predate
    // that. Inside each lock hold the row's CURRENT filamentId is re-read
    // and, on a mismatch, the refund chases the remap — at most one hop,
    // because a spool moves via promotion exactly once (the copy lands on a
    // VARIANT, and variants never promote). One row, one key at a time (the
    // no-nested-locks rule).
    for (let rowIdx = 0; rowIdx < entry.usage.length; rowIdx++) {
      const u = entry.usage[rowIdx];
      let targetId = String(u.filamentId);
      for (let hop = 0; hop < 2; hop++) {
        const remappedTo = await runExclusive(
          filamentLockKey(targetId),
          async (): Promise<string | null> => {
            const freshEntry = await PrintHistory.findById(entry._id)
              .select("usage")
              .lean();
            const freshRowId = freshEntry?.usage?.[rowIdx]?.filamentId;
            const currentId = freshRowId ? String(freshRowId) : targetId;
            if (filamentLockKey(currentId) !== filamentLockKey(targetId)) {
              // A promotion moved this row's spool — retry under the
              // promoted variant's key (the null-vs-id return is the
              // "chase" signal, not an error).
              return currentId;
            }

            const filament = await Filament.findOne({ _id: targetId, _deletedAt: null });
            if (!filament) return null;
            const spool = u.spoolId
              ? filament.spools.find((s) => String(s._id) === String(u.spoolId))
              : null;
            if (!spool) return null;

      // GH #621: locate the usageHistory entry this usage row pays back
      // BEFORE touching any weight, and refund only when an entry is
      // actually removed — the tombstone lands after the loop, so a
      // mid-loop failure (the 409 "Please retry") would otherwise leave
      // earlier filaments refunded and the advertised retry would refund
      // them AGAIN (unbounded when netFilamentWeight is null). Keying the
      // refund to entry removal makes each iteration idempotent.
      //
      // Match preference, exactly ONE entry consumed per usage row:
      //   1. jobId + grams — a job can carry multiple usage rows against
      //      the same spool, so each row must consume its own entry
      //      (sweeping every jobId match would skip later rows' refunds).
      //   2. jobId alone (grams drifted; jobId still unambiguous).
      //   3. Legacy (grams, startedAt) for pre-jobId entries — only with
      //      source "job"/"slicer", so a manual usage log sharing both
      //      fields isn't clobbered. First match only.
            const history = spool.usageHistory || [];
            const matchesJob = (h: (typeof history)[number]) =>
              Boolean(h.jobId) && String(h.jobId) === String(entry._id);
            let removeIdx = history.findIndex((h) => matchesJob(h) && h.grams === u.grams);
            if (removeIdx === -1) {
              removeIdx = history.findIndex((h) => matchesJob(h));
            }
            if (removeIdx === -1) {
              removeIdx = history.findIndex(
                (h) =>
                  !h.jobId &&
                  (h.source === "job" || h.source === "slicer") &&
                  h.grams === u.grams &&
                  h.date.getTime() === entry.startedAt.getTime(),
              );
            }
            // No matching entry → nothing to undo (a prior partial pass
            // already removed + refunded it, or the spool never carried it)
            // — refunding here is exactly the double-refund #621 describes.
            if (removeIdx === -1) return null;

            // The refund is computed from the MATCHED LEDGER ENTRY, not the
            // PrintHistory row — see the refundGrams comment below.
            const removedEntry = history[removeIdx];
            spool.usageHistory = history.filter((_, idx) => idx !== removeIdx);

      // Refund weight. GH #228: clamp at the spool's **gross** full-weight
      // ceiling — `spool.totalWeight` is what the user reads off the scale
      // (filament + empty spool), so the cap must be spoolWeight (tare) +
      // netFilamentWeight. Clamping at netFilamentWeight alone under-refunds
      // by the tare, locking those grams out forever.
      //
      // Both fields inherit from the parent on variants (resolveFilament's
      // INHERITABLE_FIELDS) — resolve via a one-shot parent lookup when
      // either is null.
            if (typeof spool.totalWeight === "number") {
              let tareWeight: number | null = filament.spoolWeight ?? null;
              let netCapacity: number | null = filament.netFilamentWeight ?? null;
              if (filament.parentId && (tareWeight == null || netCapacity == null)) {
                const parent = await Filament.findOne({
                  _id: filament.parentId,
                  _deletedAt: null,
                })
                  .select("spoolWeight netFilamentWeight")
                  .lean();
                if (parent) {
                  if (tareWeight == null) tareWeight = (parent.spoolWeight as number | null) ?? null;
                  if (netCapacity == null) netCapacity = (parent.netFilamentWeight as number | null) ?? null;
                }
              }
              // GH #1074: refund what was ACTUALLY debited, not what the
              // job requested — the POST clamps the debit at zero and
              // records the pre-clamp amount as `debitedGrams`, so a job
              // that ran a 50g spool "dry" with a 100g estimate refunds 50g,
              // not 100g of phantom inventory. Legacy pre-#1074 rows carry
              // null and fall back to the full-`grams` refund (ACCEPTED
              // RESIDUAL — the actual debit is unknowable).
              //
              // The refund reads the MATCHED LEDGER ENTRY (`removedEntry`),
              // never the PrintHistory row: two rows against one spool can
              // share `grams` but differ in actual debit, and after a
              // partial delete a retry's matcher can pair the remaining
              // entry with the wrong row — undoing exactly what the removed
              // entry recorded keeps total refund = total debit regardless
              // of pairing. A genuine clamped debit can never EXCEED the
              // entry's grams, so a corrupt debitedGrams (sync/restore — no
              // schema bound) falls back to the entry's full-`grams` refund.
              // The entry's own `grams` can ALSO be corrupt (the ledger
              // schema only enforces min: 0), and it is both the
              // debitedGrams upper bound and the legacy fallback — validate
              // it against MAX_USAGE_GRAMS (#1030) and fall back to the
              // PrintHistory row's requested grams (which passed the POST
              // cap) when invalid.
              const entryGrams =
                typeof removedEntry.grams === "number" &&
                Number.isFinite(removedEntry.grams) &&
                removedEntry.grams >= 0 &&
                removedEntry.grams <= MAX_USAGE_GRAMS
                  ? removedEntry.grams
                  : u.grams;
              const refundGrams =
                typeof removedEntry.debitedGrams === "number" &&
                Number.isFinite(removedEntry.debitedGrams) &&
                removedEntry.debitedGrams >= 0 &&
                removedEntry.debitedGrams <= entryGrams
                  ? removedEntry.debitedGrams
                  : entryGrams;
              const refunded = spool.totalWeight + refundGrams;
              // Only clamp with a real net-capacity ceiling — the tare alone
              // isn't one (known tare + unknown filament capacity can't
              // bound the refund); null falls through to no-clamp.
              if (typeof netCapacity === "number" && netCapacity > 0) {
                const grossCapacity = netCapacity + (tareWeight ?? 0);
                spool.totalWeight = Math.min(refunded, grossCapacity);
              } else {
                spool.totalWeight = refunded;
              }
            }
            // GH #905: validate modified paths only so a legacy out-of-range
            // field elsewhere can't block the refund.
            await filament.save({ validateModifiedOnly: true });
            return null;
          },
        );
        if (remappedTo == null) break;
        targetId = remappedTo;
      }
    }

    // Soft-delete by setting _deletedAt — a hard `deleteOne` would let a
    // peer sync resurrect the row (syncCollection treats "missing on one
    // side" as pull/push and only propagates deletes via the tombstone).
    await PrintHistory.updateOne(
      { _id: id },
      { $set: { _deletedAt: new Date() } },
    );
    return NextResponse.json({ message: "Deleted and refunded" });
  } catch (err) {
    // GH #504: the refund's filament.save() can race a slicer POST or
    // another DELETE — surface as 409 (retryable), not a generic 500.
    const conflict = handleVersionError(err);
    if (conflict) return conflict;
    return errorResponse("Failed to delete print history", 500, getErrorMessage(err));
  }
}

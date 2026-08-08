import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import PrintHistory from "@/models/PrintHistory";
import Filament from "@/models/Filament";
import Printer from "@/models/Printer";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { errorResponseFromCaught, getErrorMessage, errorResponse, handleVersionError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * GH #340: GET /api/print-history/{id} — fetch a single job by id,
 * matching the list endpoint's population (printer name + filament
 * name/vendor/type/color per usage row). Every other resource in the
 * app supports GET-by-id; this closes the consistency gap.
 *
 * `_deletedAt: null` filter so a tombstoned job isn't resurrected.
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
    // when this is the first route to hit it after mongoose model reset
    // (see tests/setup.ts caveat).
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
 * GH #340: PUT /api/print-history/{id} — edit a job's metadata fields
 * (jobLabel, notes, startedAt, source, printerId). Without this the
 * only way to correct a typo in a label is delete + recreate, which
 * refunds and re-charges spool weight twice — exactly the bookkeeping
 * the DELETE handler below is at pains to keep balanced.
 *
 * We intentionally do NOT accept changes to `usage[]` here. Adjusting
 * gram counts would require a refund-and-recharge dance against every
 * spool referenced by both the old and new usage lists, with the same
 * parent-lookup/clamp logic as DELETE — that's tracked separately so
 * this fix can land without touching the inventory math. A request that
 * includes `usage` is rejected with a clear message.
 */
const EDITABLE_FIELDS = ["jobLabel", "notes", "startedAt", "source", "printerId"] as const;
const VALID_SOURCES = new Set(["manual", "prusaslicer", "orcaslicer", "bambu", "other"]);

/**
 * GH #1004 F6: stamp this job's id onto the legacy (pre-jobId) usageHistory
 * entries it created, so a later DELETE refund resolves them by jobId
 * (matcher tiers 1–2) instead of by the now-stale (grams, startedAt) tuple.
 *
 * The DELETE tier-3 legacy matcher pairs a usage row to its spool entry on
 * `(grams, date)` where `date === job.startedAt`. Editing startedAt leaves
 * each legacy entry's `date` at its ORIGINAL value, so that matcher would
 * later miss — the spool weight silently never refunds even though the job is
 * tombstoned "Deleted and refunded". Stamping jobId now makes those entries
 * immune to the date drift.
 *
 * One entry consumed per usage row, matched on the row's grams + the job's
 * OLD startedAt, restricted to print-driven ("job"/"slicer") entries that
 * don't already carry a jobId — the exact candidate set the DELETE tier-3
 * matcher uses. Reloading the filament per row and saving after each stamp
 * means an already-stamped entry (now carrying a jobId) is skipped by the
 * `!h.jobId` predicate on the next row, so two rows against the same spool
 * consume distinct entries.
 *
 * GH #1074 note: this backfill deliberately does NOT stamp `debitedGrams`
 * onto the legacy entries it adopts — the actually-debited amount for a
 * pre-#1074 row is unknowable after the fact, and the DELETE refund reads
 * `debitedGrams` from the PrintHistory usage row (also null on legacy jobs),
 * falling back to the full-`grams` refund for exactly these rows. Rows
 * created after #1074 always carry a jobId, so this matcher never touches
 * them. The matching tiers themselves key on `grams` (the requested amount,
 * unchanged by #1074), so the new field doesn't perturb any tier.
 */
async function backfillLegacyUsageJobIds(
  jobId: string,
  usage: Array<{ filamentId?: unknown; spoolId?: unknown; grams?: unknown }>,
  oldStartedMs: number,
): Promise<void> {
  const jobObjectId = new mongoose.Types.ObjectId(jobId);
  for (const u of usage) {
    if (!u.filamentId || !u.spoolId || typeof u.grams !== "number") continue;
    // GH #605 round 12: the jobId stamp is a spool-subdocument write, so the
    // row's load-mutate-save runs under the filament's key — unserialized, a
    // just-saved stamp landing inside a promotion's snapshot→clear window
    // was silently erased (the promoted copy was minted from the pre-stamp
    // snapshot), quietly resurrecting the #1004 F6 refund miss this backfill
    // exists to prevent. One key per row, sequentially (no-nested-locks). A
    // row whose spool a completed promotion has already MOVED simply misses
    // here (the parent no longer carries it) — the pre-existing legacy-entry
    // posture, no worse than before the stamp existed.
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
      // A jobId stamp only touches this subdoc — validate modified paths only
      // so a legacy out-of-range field elsewhere can't block the backfill
      // (mirrors the DELETE refund's save, GH #905).
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

    // GH #340 / Codex P2: mirror POST /api/print-history's size caps so a
    // client can't bypass them by creating a normal entry and then PUT'ing
    // a multi-megabyte string. POST caps jobLabel at 200, notes at 2000;
    // without the same caps here the document can balloon and eventually
    // trip MongoDB's 16 MiB doc limit as a 500 instead of a clean 400.
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
    // legacy usage entries against the DELETE refund matcher losing them to
    // the date drift (see backfillLegacyUsageJobIds). Only the startedAt edit
    // path needs the extra read + walk.
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
 * the corresponding spool weight so the ledger stays balanced.
 *
 * This handles the "print failed, undo this entry" case from issue #92. The
 * refund is best-effort: if a spool has since been deleted we log the refund
 * loss but still remove the history entry.
 *
 * GH #621: each usage row's refund is conditioned on its matching
 * usageHistory entry actually being removed in this pass, so a retry after a
 * mid-loop failure (the 409 path) can't refund an already-refunded spool a
 * second time. See the comment block inside the refund loop.
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

    // GH #524.5: ?permanent=true sets the `_purged` tombstone, mirroring
    // the Filament permanent-delete path. Gated on the row ALREADY being
    // soft-deleted (`_deletedAt != null`) so an accidental
    // DELETE?permanent=true on an active entry can't skip the refund +
    // soft-delete step. Idempotent — a second purge on an already-purged
    // row returns 404 (filtered on `_purged: { $ne: true }`). No refund
    // here: the spool weight was already refunded on the soft delete.
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

    // Filter on _deletedAt: null so a retry / double-click / client-retry
    // after a timeout doesn't re-run the refund loop on an already
    // tombstoned entry. Without this, each repeat call would refund the
    // spool weight again and inflate inventory totals.
    const entry = await PrintHistory.findOne({ _id: id, _deletedAt: null });
    if (!entry) {
      return errorResponse("Not found", 404);
    }

    // GH #605 round 12: each row's refund is a SPOOL WRITE, so the whole
    // load-mutate-save runs under the owning filament's key — the same
    // per-filament mutex every promotion path holds. Unserialized, a refund
    // save landing between a promotion's snapshot read and its clearing
    // write was silently erased (weight refunded + entry removed on the
    // parent, promoted copy minted from the PRE-refund snapshot, parent
    // cleared — the 200 "Deleted and refunded" then described a refund that
    // exists nowhere while the copy still carries the debit).
    //
    // The row's spool can also have MOVED before this loop runs: a completed
    // promotion remaps this row's `filamentId` onto the promoted variant in
    // the DB (remapExternalSpoolRefs), but the `entry` loaded above may
    // predate that. So inside each lock hold the row's CURRENT filamentId is
    // re-read and, on a mismatch, the refund chases the remap — at most one
    // hop, because a spool moves via promotion exactly once (the copy lands
    // on a VARIANT, and variants never promote). Holding the current owner's
    // key pins the row: a parent-side promotion serializes behind the hold,
    // and a row already remapped onto a variant can't move again.
    //
    // One row, one key at a time (the no-nested-locks rule); the
    // variant-parent spec lookup inside is a plain read, never a second key.
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
      // actually removed. The refund used to be unconditional and the
      // tombstone only lands after the loop — so a mid-loop failure (e.g.
      // a VersionError mapped to the 409 "Please retry" below) left
      // earlier filaments refunded with their entries removed while the
      // job stayed `_deletedAt: null`, and the advertised retry refunded
      // them AGAIN (unbounded when netFilamentWeight is null, since the
      // gross clamp only applies when capacity is known). Keying the
      // refund to entry removal makes each iteration idempotent: on
      // retry the entry is already gone → nothing removed → no second
      // refund.
      //
      // Match preference, exactly ONE entry consumed per usage row:
      //   1. jobId + grams. A job can carry multiple usage rows against
      //      the same spool (POST pushes one usageHistory entry per row,
      //      all sharing this jobId), so each row must consume its own
      //      entry — sweeping every jobId match at once would leave the
      //      later rows with nothing to remove and skip their refunds.
      //   2. jobId alone (grams drifted; jobId is still unambiguous).
      //   3. Legacy (grams, startedAt) for entries written before the
      //      v1.12.x audit that don't carry a jobId — but only when the
      //      entry has source "job" or "slicer", which restricts the
      //      candidate set to print-history-driven rows and avoids
      //      accidentally clobbering a manual usage log that happens to
      //      share both fields. First match only, as before.
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
            // No matching entry → this row's debit is no longer (or was never)
            // represented on the spool: either a prior partial pass already
            // removed it and refunded the weight, or the spool never carried
            // it. Either way there is nothing to undo — refunding here is
            // exactly the double-refund #621 describes.
            if (removeIdx === -1) return null;

            // Codex P2 round 2 on PR #1092: the refund is computed from the
            // MATCHED LEDGER ENTRY, not the PrintHistory row — see the
            // refundGrams comment below.
            const removedEntry = history[removeIdx];
            spool.usageHistory = history.filter((_, idx) => idx !== removeIdx);

      // Refund weight. GH #228 + Codex P1 review on PR #229: clamp at
      // the spool's **gross** full-weight ceiling. `spool.totalWeight`
      // is what the user reads off the scale — filament + empty spool —
      // so the cap must be in the same unit. That's
      //   spoolWeight (empty-spool tare) + netFilamentWeight (filament).
      // The pre-Codex shape clamped at `netFilamentWeight` alone, which
      // for any filament with a non-zero spool tare would under-refund
      // the empty-spool grams (e.g. a 1200g gross / 200g-tare spool got
      // capped to 1000g, locking 200g of legitimate weight out of the
      // refund forever).
      //
      // `spoolWeight` and `netFilamentWeight` both inherit from the
      // parent on variants (see src/lib/resolveFilament.ts
      // INHERITABLE_FIELDS), so resolve them via a one-shot parent
      // lookup when either is null on the variant.
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
              // GH #1074: refund what was ACTUALLY debited, not what the job
              // requested. The POST clamps the debit at zero and records the
              // pre-clamp `min(totalWeight, grams)` as `debitedGrams` — so a
              // job that ran a 50g spool "dry" with a 100g estimate refunds
              // 50g, not 100g of phantom inventory. Legacy rows created
              // before the field existed carry null and fall back to the old
              // full-`grams` refund — an ACCEPTED RESIDUAL: for those rows
              // the actually-debited amount is unknowable, and the gross-
              // capacity clamp below still bounds the damage when
              // netFilamentWeight is known. The finiteness/sign guard covers
              // values that arrived through paths bypassing the POST route
              // (hybrid sync, snapshot restore).
              // Codex P2s on PR #1092 (two rounds): the refund reads the
              // MATCHED LEDGER ENTRY (`removedEntry`), never the PrintHistory
              // row. Round 2's scenario: two rows against one spool with
              // identical `grams` but different actual debits (150g spool,
              // two 100g rows → debits of 100 and 50). If the delete
              // partially completes (one entry removed + refunded, then a
              // save failure leaves the job active), the retry's matcher
              // can't tell the remaining entry apart and would associate it
              // with the FIRST row again — refunding the row's 100 instead
              // of the entry's 50 and minting phantom weight. Undoing
              // exactly what the removed entry recorded makes the total
              // refund equal the total debit regardless of which row a
              // retry pairs it with. Round 1's guard stays: a genuine
              // clamped debit can never EXCEED the entry's requested grams,
              // so a corrupt debitedGrams (sync/restore — the field has no
              // schema bound) falls back to the entry's full-`grams` refund
              // (also the legacy pre-#1074 path for entries without the
              // field).
              const refundGrams =
                typeof removedEntry.debitedGrams === "number" &&
                Number.isFinite(removedEntry.debitedGrams) &&
                removedEntry.debitedGrams >= 0 &&
                removedEntry.debitedGrams <= removedEntry.grams
                  ? removedEntry.debitedGrams
                  : removedEntry.grams;
              const refunded = spool.totalWeight + refundGrams;
              // Only clamp when we have a real net-capacity ceiling. The empty-
              // spool tare alone isn't a ceiling — a value of "spoolWeight: 200,
              // netFilamentWeight: null" means we know the tare but not the
              // filament capacity, so we can't bound the refund. Leaving
              // `netCapacity` null falls through to the legacy no-clamp behaviour.
              if (typeof netCapacity === "number" && netCapacity > 0) {
                const grossCapacity = netCapacity + (tareWeight ?? 0);
                spool.totalWeight = Math.min(refunded, grossCapacity);
              } else {
                spool.totalWeight = refunded;
              }
            }
            // GH #905: a refund only mutates spool weight — validate modified paths
            // only so a legacy out-of-range field elsewhere can't block the refund.
            await filament.save({ validateModifiedOnly: true });
            return null;
          },
        );
        if (remappedTo == null) break;
        targetId = remappedTo;
      }
    }

    // Soft-delete by setting _deletedAt. Hard `deleteOne` would let a peer
    // sync resurrect the row from the other DB on the next cycle —
    // syncCollection treats "missing on one side" as pull/push, not delete,
    // and only propagates deletes via the _deletedAt tombstone. Same model
    // the rest of the synced collections already use.
    await PrintHistory.updateOne(
      { _id: id },
      { $set: { _deletedAt: new Date() } },
    );
    return NextResponse.json({ message: "Deleted and refunded" });
  } catch (err) {
    // GH #504: same concurrent-edit pattern. DELETE refunds spool weight
    // via filament.save(); if that races a slicer POST or another DELETE
    // on the same filament, surface as 409 so the caller can retry
    // instead of seeing a generic 500 toast.
    const conflict = handleVersionError(err);
    if (conflict) return conflict;
    return errorResponse("Failed to delete print history", 500, getErrorMessage(err));
  }
}

import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import PrintHistory from "@/models/PrintHistory";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * DELETE /api/print-history/{id} — remove a print history entry and refund
 * the corresponding spool weight so the ledger stays balanced.
 *
 * This handles the "print failed, undo this entry" case from issue #92. The
 * refund is best-effort: if a spool has since been deleted we log the refund
 * loss but still remove the history entry.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const entry = await PrintHistory.findById(id);
    if (!entry) {
      return errorResponse("Not found", 404);
    }

    for (const u of entry.usage) {
      const filament = await Filament.findOne({ _id: u.filamentId, _deletedAt: null });
      if (!filament) continue;
      const spool = u.spoolId
        ? filament.spools.find((s) => String(s._id) === String(u.spoolId))
        : null;
      if (!spool) continue;
      // Refund weight
      if (typeof spool.totalWeight === "number") {
        spool.totalWeight = spool.totalWeight + u.grams;
      }
      // Remove the matching usageHistory entry by jobId. Older entries
      // written before the v1.12.x audit don't carry a jobId; for those
      // we fall back to the legacy (grams, startedAt) match — but only
      // when the entry has source "job" or "slicer", which restricts
      // the candidate set to print-history-driven rows and avoids
      // accidentally clobbering a manual usage log that happens to
      // share both fields.
      spool.usageHistory = (spool.usageHistory || []).filter(
        (h, idx, arr) => {
          // New world: jobId match is unambiguous.
          if (h.jobId && String(h.jobId) === String(entry._id)) return false;

          // Legacy fallback (entries created before jobId existed).
          if (h.jobId) return true;
          if (h.source !== "job" && h.source !== "slicer") return true;
          if (h.grams !== u.grams) return true;
          if (h.date.getTime() !== entry.startedAt.getTime()) return true;
          // Remove only the first matching legacy entry per usage row.
          const firstMatch = arr.findIndex(
            (x) =>
              !x.jobId &&
              (x.source === "job" || x.source === "slicer") &&
              x.grams === u.grams &&
              x.date.getTime() === entry.startedAt.getTime(),
          );
          return idx !== firstMatch;
        },
      );
      await filament.save();
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
    return errorResponse("Failed to delete print history", 500, getErrorMessage(err));
  }
}

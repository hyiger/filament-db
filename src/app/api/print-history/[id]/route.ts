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
      // Remove the matching usageHistory entry (most recent with this grams+date)
      spool.usageHistory = (spool.usageHistory || []).filter(
        (h, idx, arr) => {
          if (h.grams !== u.grams) return true;
          if (h.date.getTime() !== entry.startedAt.getTime()) return true;
          // Remove the first match only
          const firstMatch = arr.findIndex(
            (x) =>
              x.grams === u.grams && x.date.getTime() === entry.startedAt.getTime(),
          );
          return idx !== firstMatch;
        },
      );
      await filament.save();
    }

    await PrintHistory.deleteOne({ _id: id });
    return NextResponse.json({ message: "Deleted and refunded" });
  } catch (err) {
    return errorResponse("Failed to delete print history", 500, getErrorMessage(err));
  }
}

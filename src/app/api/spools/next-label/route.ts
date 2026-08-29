import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { computeNextSpoolLabel } from "@/lib/nextSpoolLabel";
import { errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * GET /api/spools/next-label — the "Next #" roll-number suggestion
 * (GH #1060). Returns `{ next, max }`. Suggestion-only: nothing is
 * reserved, and two concurrent readers can receive the same value
 * (accepted — single-admin reality, and the human edits the field anyway).
 *
 * THE QUERY DELIBERATELY FILTERS NOTHING — no `_deletedAt`, `_purged`, or
 * `retired`, the opposite of every other spool read. Roll numbers are
 * physical and permanent: a number on a trashed filament's spool must
 * never be handed out again (restore would collide), and a retired spool's
 * written number is still on the shelf. Skipping past numbers the user
 * might think are free is the safe direction.
 *
 * Label-only projection (GH #1005 posture — never stream photo blobs).
 * Read-only GET, so no assertSameOriginRequest (GH #360).
 */
export async function GET() {
  try {
    await dbConnect();
    const docs = await Filament.find({}, { "spools.label": 1 }).lean();
    const labels: (string | null | undefined)[] = [];
    for (const doc of docs) {
      for (const spool of doc.spools ?? []) {
        labels.push(spool?.label);
      }
    }
    return NextResponse.json(computeNextSpoolLabel(labels));
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to compute the next spool label");
  }
}

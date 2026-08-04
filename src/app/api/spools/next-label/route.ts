import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { computeNextSpoolLabel } from "@/lib/nextSpoolLabel";
import { errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * GET /api/spools/next-label — the "Next #" roll-number suggestion (GH #1060).
 *
 * Returns `{ next, max }`: the highest numeric spool label across the WHOLE
 * database plus one, and the max itself (null when no label parses as a
 * number). Suggestion-only semantics — the client pre-fills an editable
 * field; nothing is reserved or assigned, and two concurrent readers can
 * receive the same value (accepted by the issue: single-admin reality, and
 * the human edits the field anyway).
 *
 * THE QUERY DELIBERATELY FILTERS NOTHING. No `_deletedAt`, no `_purged`, no
 * `retired` — the opposite of every other spool read in this app. Roll
 * numbers are physical and permanent (the reporter's are hand-written on
 * the spools): a number on a trashed filament's spool must never be handed
 * out again, because restoring that filament would collide; a retired
 * spool's written number is still on the shelf. Skipping past numbers the
 * user might think are free is the safe direction.
 *
 * Label-only projection per the GH #1005 posture — this must never stream
 * photo blobs or usage history. Read-only GET, so no assertSameOriginRequest
 * (repo posture: the guard covers mutating verbs, GH #360); the optional
 * FILAMENTDB_API_KEY bearer gate in src/proxy.ts applies automatically.
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

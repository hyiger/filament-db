import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import {
  renumberOptTags,
  scanUnverifiedOptTags,
  readDroppedLegacyTags,
  type MinimalRenumberDb,
} from "@/lib/optTagRenumber";

/**
 * GET /api/opt-tag-review  (GH #1227)
 *
 * Data health: every filament whose stored `optTags` the startup renumbering
 * pass could not place in a numbering (ids valid under BOTH the pre-#1227 app
 * table and the OpenPrintTag spec, with nothing outside the array to decide),
 * with both readings pre-computed, plus the legacy tags the pass had to drop
 * from the rows it DID convert.
 *
 * Runs the (idempotent, per-row) pass first, so a decisive row that arrived
 * after startup — a share import, a row synced down from a peer — is settled
 * here rather than listed as pending until the next restart. This is the same
 * pass `dbConnect` runs; it writes only marker bits and provable translations.
 *
 * Sibling of `/api/name-conflicts` and `/api/abrasive-nozzles`: no
 * `assertSameOriginRequest` on a GET (the #360 sweep covers mutating verbs);
 * the optional bearer gate in `src/proxy.ts` still applies. Covers the
 * database this server talks to — in hybrid mode the sync service runs the
 * same pass on the remote, and a resolution made here syncs across.
 */
export async function GET() {
  try {
    await dbConnect();
    const db = mongoose.connection.db;
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }
    const handle = db as unknown as MinimalRenumberDb;
    await renumberOptTags(handle);
    const [pending, dropped] = await Promise.all([
      scanUnverifiedOptTags(handle),
      readDroppedLegacyTags(handle),
    ]);
    return NextResponse.json({ pending, dropped });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to scan for tags awaiting review", detail: message },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { scanTrimConflicts, type MinimalTrimDb } from "@/lib/trimEntityNames";
import { countEntityDependents } from "@/lib/entityDependents";

/**
 * GET /api/name-conflicts  (GH #1149)
 *
 * Every row the #1116 name-trim migration REFUSED to repair, classified by
 * the SAME shared decision the migration uses (`scanTrimConflicts` —
 * read-only), enriched with the dependent counts that gate the safe
 * resolutions (zero dependents → trash is safe; dependents → rename frees
 * the canonical spelling without touching a reference).
 *
 * Only ACTIVE conflicts are returned — a tombstoned/purged row's name is
 * unresolvable and invisible.
 *
 * RAW driver on purpose: these rows are unreachable through Mongoose by
 * name (the trim setter casts query values — the GH #1116 mechanism
 * itself). Resolution then happens by `_id` through the guarded routes.
 *
 * Read-only GET → no `assertSameOriginRequest` (the #360 sweep covers
 * mutating verbs). In HYBRID mode this covers only the local database;
 * remote-side conflicts are visible only to the desktop sync service.
 */
export async function GET() {
  try {
    await dbConnect();
    const db = mongoose.connection.db;
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }
    const all = await scanTrimConflicts(db as unknown as MinimalTrimDb);
    const active = all.filter((c) => c.active);
    const conflicts = await Promise.all(
      active.map(async (c) => ({
        ...c,
        dependents: await countEntityDependents(c.collection, c.id, c.name),
      })),
    );
    return NextResponse.json({ conflicts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to scan for name conflicts", detail: message },
      { status: 500 },
    );
  }
}

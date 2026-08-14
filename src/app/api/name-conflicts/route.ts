import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { scanTrimConflicts, type MinimalTrimDb } from "@/lib/trimEntityNames";
import { countEntityDependents } from "@/lib/entityDependents";

/**
 * GET /api/name-conflicts  (GH #1149)
 *
 * The trim-collision surface: every row the #1116 name-trim migration REFUSED
 * to repair (a stored `"X "` whose trim would collide with an active `"X"`,
 * or a whitespace-only name), classified by the exact same shared decision
 * the migration uses (`scanTrimConflicts` — read-only, no index build, no
 * writes), and enriched with the per-collection dependent counts that gate
 * the safe resolutions:
 *
 *   - zero dependents → the row is a plain duplicate of the row that already
 *     won the name; "Move to trash" via the existing id-addressed DELETE is
 *     safe and reversible.
 *   - dependents      → "Rename" (e.g. to `"X (2)"`) via the existing
 *     id-addressed PUT frees the canonical spelling without touching a
 *     single reference.
 *
 * Only ACTIVE conflicts are returned — a tombstoned/purged row's name is
 * unresolvable and invisible, exactly why the migration doesn't gate on it.
 *
 * RAW driver on purpose: these rows are unreachable through Mongoose by name
 * (the schema's trim setter casts query values — the GH #1116 mechanism
 * itself), while the raw driver reads them fine. Resolution then happens by
 * `_id` through the ordinary guarded routes.
 *
 * Read-only GET → no `assertSameOriginRequest` (the #360 sweep covers
 * mutating verbs); the optional bearer gate applies via `src/proxy.ts`.
 *
 * In HYBRID mode this covers the database the server talks to (the local
 * one). Remote-side conflicts are only visible to the desktop sync service —
 * a follow-up (see the issue) will surface those through SyncStatus.
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

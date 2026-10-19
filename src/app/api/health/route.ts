import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import {
  dbUnavailableResponse,
  errorResponse,
  getErrorMessage,
} from "@/lib/apiErrorHandler";
import { toDbUnavailableError } from "@/lib/dbErrorText";

// Never prerendered or cached: the whole point is the live answer.
export const dynamic = "force-dynamic";

/**
 * GET /api/health  (GH #1231)
 *
 * Can this server reach its database right now? 200 `{ok: true}` when a
 * ping round-trips; otherwise the same 503 `db_unavailable` body every route
 * returns for an unreachable database, with the classified `kind` the UI
 * translates.
 *
 * Two consumers in the app:
 *  - the web header pill, which used to say "Connected" from
 *    `navigator.onLine` while every API call was failing;
 *  - the shared load-error panel, which asks here when a page's own request
 *    failed without saying why (most read routes still answer a generic 500).
 *
 * The ping matters: `dbConnect` returns a cached connection, which can
 * outlive the database's reachability. A ping that fails on a live handle is
 * classified the same way a failed connect is. Any OTHER dbConnect failure
 * (a startup migration that rethrew) happened on a reachable database, so
 * it is a plain 500, never "unavailable": that would send the user to check
 * their connection or Atlas for a problem that isn't there.
 *
 * Deliberately NOT the Docker HEALTHCHECK target. That probe answers "is the
 * process alive"; pointing it here would make an orchestrator restart-loop a
 * container whose only problem is an Atlas IP Access List entry.
 *
 * Read-only GET, so no `assertSameOriginRequest` (the #360 sweep covers
 * mutating verbs). The optional FILAMENTDB_API_KEY gate in src/proxy.ts
 * applies as it does to every /api route.
 */
export async function GET() {
  try {
    await dbConnect();
  } catch (err) {
    // A failed connect arrives already classified (and logged).
    return (
      dbUnavailableResponse(err) ??
      errorResponse("Database check failed", 500, getErrorMessage(err))
    );
  }
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("no database handle on the mongoose connection");
    await db.command({ ping: 1 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // The connection was up a moment ago: classify why it stopped answering.
    const { error, logLine } = toDbUnavailableError(err, process.env.MONGODB_URI ?? "");
    console.error(logLine);
    return dbUnavailableResponse(error)!;
  }
}

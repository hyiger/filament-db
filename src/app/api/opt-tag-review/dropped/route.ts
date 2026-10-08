import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { dismissDroppedLegacyTags, type MinimalRenumberDb } from "@/lib/optTagRenumber";

/**
 * DELETE /api/opt-tag-review/dropped  (GH #1227)
 *
 * Dismiss the Data health notice listing the legacy tags (FLEXIBLE, FOOD_SAFE,
 * … — concepts with no OpenPrintTag equivalent) the renumbering pass removed
 * while converting rows. The notice exists so the removal is never silent;
 * once read, it is cleared here. Nothing on any filament changes.
 *
 * Body (optional JSON): `{ "filamentIds": string[] }` — the records the page
 * displayed. Only those are removed, so a record appended between the page
 * load and the click (its row is already marked; no later pass could recreate
 * the notice) survives to be shown next time (Codex P2 r7 on PR #1228). With
 * no body, everything recorded is cleared.
 *
 * Mutating → `assertSameOriginRequest` (the #360 sweep).
 */
export async function DELETE(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  let filamentIds: string[] | undefined;
  const raw = await request.text();
  if (raw.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const ids = (body as { filamentIds?: unknown } | null)?.filamentIds;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id !== "")) {
      return NextResponse.json({ error: "filamentIds must be an array of ids" }, { status: 400 });
    }
    filamentIds = ids as string[];
  }

  try {
    await dbConnect();
    const db = mongoose.connection.db;
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }
    await dismissDroppedLegacyTags(db as unknown as MinimalRenumberDb, filamentIds);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to dismiss the removed-tags notice", detail: message },
      { status: 500 },
    );
  }
}

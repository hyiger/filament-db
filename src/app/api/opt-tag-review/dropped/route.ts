import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import {
  dismissDroppedLegacyTags,
  type DroppedLegacyTagsRef,
  type MinimalRenumberDb,
} from "@/lib/optTagRenumber";

/**
 * DELETE /api/opt-tag-review/dropped  (GH #1227)
 *
 * Dismiss the Data health notice listing the legacy tags (FLEXIBLE, FOOD_SAFE,
 * … — concepts with no OpenPrintTag equivalent) the renumbering pass removed
 * while converting rows. The notice exists so the removal is never silent;
 * once read, it is cleared here. Nothing on any filament changes.
 *
 * Body (optional JSON): `{ "records": [{ "filamentId": string, "at": string }] }`
 * — the records the page displayed, each named by its row AND its `at`
 * timestamp (the version shown). Only those exact records are removed: one
 * appended between the page load and the click survives (Codex P2 r7 on PR
 * #1228), and so does a REPLACEMENT notice for the same row written by a later
 * conversion (a snapshot restore or a newer unverified hybrid revision can
 * make a row reviewable again) — keyed on the id alone, the dismissal pulled a
 * notice the user never saw (Codex P2 r16). With no body, everything recorded
 * is cleared.
 *
 * Mutating → `assertSameOriginRequest` (the #360 sweep).
 */
export async function DELETE(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  let records: DroppedLegacyTagsRef[] | undefined;
  const raw = await request.text();
  if (raw.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const list = (body as { records?: unknown } | null)?.records;
    if (!Array.isArray(list)) {
      return NextResponse.json({ error: "records must be an array of { filamentId, at }" }, { status: 400 });
    }
    records = [];
    for (const entry of list) {
      const filamentId = (entry as { filamentId?: unknown } | null)?.filamentId;
      const at = (entry as { at?: unknown } | null)?.at;
      const parsedAt = typeof at === "string" || typeof at === "number" ? new Date(at) : null;
      if (typeof filamentId !== "string" || filamentId === "" || !parsedAt || Number.isNaN(parsedAt.getTime())) {
        return NextResponse.json({ error: "records must be an array of { filamentId, at }" }, { status: 400 });
      }
      records.push({ filamentId, at: parsedAt });
    }
  }

  try {
    await dbConnect();
    const db = mongoose.connection.db;
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }
    await dismissDroppedLegacyTags(db as unknown as MinimalRenumberDb, records);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to dismiss the removed-tags notice", detail: message },
      { status: 500 },
    );
  }
}

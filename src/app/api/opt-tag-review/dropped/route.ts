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
 * Mutating → `assertSameOriginRequest` (the #360 sweep).
 */
export async function DELETE(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;
  try {
    await dbConnect();
    const db = mongoose.connection.db;
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }
    await dismissDroppedLegacyTags(db as unknown as MinimalRenumberDb);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to dismiss the removed-tags notice", detail: message },
      { status: 500 },
    );
  }
}

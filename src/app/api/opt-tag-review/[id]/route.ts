import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { isEncodableOptTag } from "@/lib/openprinttag";
import {
  resolveOptTagNumbering,
  type MinimalRenumberDb,
  type OptTagResolveAction,
} from "@/lib/optTagRenumber";

/**
 * POST /api/opt-tag-review/{id}  (GH #1227)
 *
 * The user's answer for one filament Data health listed as awaiting numbering
 * review. Body: `{ action: "convert" | "keep", expectedTags: number[] }`.
 *
 *  - `convert` — the tags were entered in this app (or imported from the OPT
 *    database) → translate from the pre-#1227 numbering to the spec's.
 *  - `keep`    — the tags were read from a vendor's NFC tag → already spec
 *    ids, mark them verified as they are.
 *
 * `expectedTags` is the array the page showed. The write is conditioned on the
 * row still holding exactly that array (and still being unverified); anything
 * else is 409 `tags_changed` and the page re-scans — a tag edit in another tab
 * must not be overwritten by a decision made against the old list.
 *
 * Mutating → `assertSameOriginRequest` (the #360 sweep).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  const { id } = await params;
  if (!mongoose.isValidObjectId(id)) {
    return NextResponse.json({ error: "Invalid filament id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = (body as { action?: unknown } | null)?.action;
  if (action !== "convert" && action !== "keep") {
    return NextResponse.json(
      { error: 'action must be "convert" or "keep"' },
      { status: 400 },
    );
  }
  const expected = (body as { expectedTags?: unknown }).expectedTags;
  if (!Array.isArray(expected) || !expected.every(isEncodableOptTag)) {
    return NextResponse.json(
      { error: "expectedTags must be an array of non-negative integer tag ids" },
      { status: 400 },
    );
  }

  try {
    await dbConnect();
    const db = mongoose.connection.db;
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }
    const result = await resolveOptTagNumbering(
      db as unknown as MinimalRenumberDb,
      new mongoose.Types.ObjectId(id),
      action as OptTagResolveAction,
      expected as number[],
    );
    switch (result.outcome) {
      case "not_found":
        return NextResponse.json({ error: "Filament not found" }, { status: 404 });
      case "changed":
        return NextResponse.json(
          {
            error: "tags_changed",
            message:
              "This filament's tags changed since the scan, or are already verified. Re-scan and review again.",
          },
          { status: 409 },
        );
      default:
        return NextResponse.json(result);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to resolve tag numbering", detail: message },
      { status: 500 },
    );
  }
}

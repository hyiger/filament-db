import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import {
  fetchOpenPrintTagDatabase,
  mapToFilamentPayload,
} from "@/lib/openprinttagBrowser";
import { buildOptLinkUpdate } from "@/lib/optResync";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * POST /api/filaments/{id}/openprinttag/link  (Issue #753, approach C)
 *
 * Links an EXISTING filament to an OpenPrintTag material so it can use the
 * re-sync ("Check for updates") loop. Body: `{ slug: string }` — the OPT
 * material slug.
 *
 * This writes ONLY the linkage (`settings.openprinttag_slug` / `_uuid`) and the
 * provenance snapshot (`openprinttagSnapshot`) — it never touches a field
 * value. So linking can't clobber a user-set or (for a variant) an inherited
 * value: a variant that inherits a field equal to OPT's offer simply won't be
 * offered that field on the next check (the check route diffs the variant's
 * EFFECTIVE values), and a field the user diverged on classifies as a
 * `conflict` (user decides) rather than auto-reverting.
 *
 * Responses:
 *   { error: ... } 400/404                 — bad body / filament not found
 *   { linked: false, found: false, slug }  — slug no longer in the OPT db
 *   { linked: true, slug, filament }       — link established + fresh doc
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    const { id } = await params;
    // Reject a non-ObjectId id up front (400) instead of letting Mongoose's
    // CastError fall to the generic 500, matching the sibling routes. (#818)
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid filament id" }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const slug = (body as { slug?: unknown }).slug;
    if (typeof slug !== "string" || slug.trim() === "") {
      return NextResponse.json(
        { error: "Request body must include a non-empty 'slug' string" },
        { status: 400 },
      );
    }

    await dbConnect();

    const filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
    if (!filament) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const db = await fetchOpenPrintTagDatabase();
    const material = db.materials.find((m) => m.slug === slug);
    if (!material) {
      // The slug isn't (or is no longer) in the OPT database — surface that
      // rather than recording a dangling link.
      return NextResponse.json({ linked: false, found: false, slug }, { status: 404 });
    }

    const payload = mapToFilamentPayload(material);
    const $set = buildOptLinkUpdate(payload);

    // Re-filter `_deletedAt: null` on the write so a concurrent soft-delete
    // between the findOne above and this update doesn't mutate a tombstoned
    // row (mirrors the sync route, GH #629). runValidators is harmless here —
    // we only $set the linkage + snapshot, no schema-validated field values.
    const updated = await Filament.findOneAndUpdate(
      { _id: filament._id, _deletedAt: null },
      { $set },
      { returnDocument: "after", runValidators: true, context: "query" },
    ).lean();
    if (!updated) {
      return NextResponse.json(
        { error: "Filament was deleted before the link could complete" },
        { status: 404 },
      );
    }

    return NextResponse.json({ linked: true, slug, filament: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to link OpenPrintTag material", detail: message },
      { status: 500 },
    );
  }
}

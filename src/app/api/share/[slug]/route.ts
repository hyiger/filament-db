import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import SharedCatalog from "@/models/SharedCatalog";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * GET /api/share/{slug} — fetch a public shared catalog by its slug.
 *
 * Returns the denormalised payload captured at publish time. Increments
 * viewCount as a lightweight popularity signal. Respects expiresAt.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    await dbConnect();
    const { slug } = await params;

    // GH #272: increment viewCount only for a valid, non-expired hit.
    // The pre-fix handler `$inc`'d on every GET *before* the expiry
    // check, so expired catalogs kept accruing views.
    //
    // A single atomic findOneAndUpdate carries the validity predicates
    // (_deletedAt + non-expired) into the WRITE itself — so a catalog
    // that expires or is unpublished between read and write is not
    // incremented (Codex review) — and `returnDocument: "after"` gives
    // back the freshly-incremented count, accurate under concurrent
    // viewers (no read-modify-write skew).
    const now = new Date();
    const catalog = await SharedCatalog.findOneAndUpdate(
      {
        slug,
        _deletedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      },
      { $inc: { viewCount: 1 } },
      { returnDocument: "after" },
    );

    if (!catalog) {
      // No valid hit. Distinguish an expired catalog (410) from a
      // genuinely missing/unpublished one (404) with a read-only
      // lookup — this path does NOT increment anything. The expiry
      // test is `<= now` to match the increment query's `$gt: now`
      // exactly: a catalog whose expiresAt is precisely `now` is
      // excluded from the valid-hit query, so it must report 410 here
      // (Codex review — consistent boundary semantics).
      const existing = await SharedCatalog.findOne({ slug, _deletedAt: null })
        .select("expiresAt")
        .lean();
      if (existing && existing.expiresAt && existing.expiresAt <= now) {
        return errorResponse("Shared catalog has expired", 410);
      }
      return errorResponse("Shared catalog not found", 404);
    }

    return NextResponse.json({
      slug: catalog.slug,
      title: catalog.title,
      description: catalog.description,
      createdAt: catalog.createdAt,
      expiresAt: catalog.expiresAt,
      viewCount: catalog.viewCount,
      payload: catalog.payload,
    });
  } catch (err) {
    return errorResponse("Failed to fetch shared catalog", 500, getErrorMessage(err));
  }
}

/**
 * DELETE /api/share/{slug} — unpublish a shared catalog.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
    const { slug } = await params;

    // GH #524.5: ?permanent=true sets the `_purged` tombstone, mirroring
    // Filament. Gated on the catalog ALREADY being unpublished
    // (`_deletedAt != null`) so a permanent delete can't skip the
    // unpublish step. Idempotent — a second purge returns 404.
    const permanent = request.nextUrl.searchParams.get("permanent") === "true";
    if (permanent) {
      const res = await SharedCatalog.updateOne(
        { slug, _deletedAt: { $ne: null }, _purged: { $ne: true } },
        { $set: { _purged: true } },
      );
      if (res.matchedCount === 0) {
        return errorResponse(
          "Not found, or not unpublished (permanent delete requires the catalog to be unpublished first)",
          404,
        );
      }
      return NextResponse.json({ message: "Permanently deleted" });
    }

    // Soft-delete instead of hard `deleteOne` so the unpublish actually
    // sticks across peers. syncCollection treats a missing row as
    // "pull/push back" rather than "propagate the delete" — without a
    // _deletedAt tombstone the next sync from the other peer would
    // resurrect the catalog and re-expose the link the user took down.
    const res = await SharedCatalog.updateOne(
      { slug, _deletedAt: null },
      { $set: { _deletedAt: new Date() } },
    );
    if (res.matchedCount === 0) {
      return errorResponse("Shared catalog not found", 404);
    }
    return NextResponse.json({ message: "Unpublished" });
  } catch (err) {
    return errorResponse("Failed to unpublish shared catalog", 500, getErrorMessage(err));
  }
}

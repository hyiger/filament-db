import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import SharedCatalog from "@/models/SharedCatalog";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

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

    const catalog = await SharedCatalog.findOne({ slug });
    if (!catalog) {
      return errorResponse("Shared catalog not found", 404);
    }
    if (catalog.expiresAt && catalog.expiresAt < new Date()) {
      return errorResponse("Shared catalog has expired", 410);
    }

    // Increment view count (best-effort, not blocking on error)
    catalog.viewCount = (catalog.viewCount || 0) + 1;
    await catalog.save().catch(() => {});

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
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    await dbConnect();
    const { slug } = await params;
    const res = await SharedCatalog.deleteOne({ slug });
    if (res.deletedCount === 0) {
      return errorResponse("Shared catalog not found", 404);
    }
    return NextResponse.json({ message: "Unpublished" });
  } catch (err) {
    return errorResponse("Failed to unpublish shared catalog", 500, getErrorMessage(err));
  }
}

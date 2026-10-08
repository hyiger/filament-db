import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { IFilament } from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
import { effectiveOptTagsAwaitReview, type OptTagReviewRow } from "@/lib/optTagLegacy";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { MAX_COMPARE_FILAMENTS } from "@/lib/compareSelection";

/**
 * GET /api/filaments/compare?ids=a,b,c — fetch multiple filaments for the
 * comparison view in one round trip. Variants are resolved against their
 * parent (GH #184) so inheritable columns — including the spoolWeight the
 * on-hand math reads — render inherited values, matching the detail page,
 * list, and exports. Calibration refs come back populated.
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();
    const idsParam = request.nextUrl.searchParams.get("ids");
    if (!idsParam) {
      return errorResponse("ids query parameter is required", 400);
    }
    // GH #1109: dedupe before counting — `?ids=a,a,b` is a 2-filament
    // comparison (duplicates emitted repeated React keys client-side).
    const ids = Array.from(
      new Set(
        idsParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
    if (ids.length === 0) {
      return errorResponse("ids must contain at least one filament id", 400);
    }
    if (ids.length > MAX_COMPARE_FILAMENTS) {
      return errorResponse(
        `Comparing more than ${MAX_COMPARE_FILAMENTS} filaments at once is not supported`,
        400,
      );
    }

    const filaments = await Filament.find({ _id: { $in: ids }, _deletedAt: null })
      .populate("compatibleNozzles")
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .populate("calibrations.bedType")
      .lean();

    // One batched parent query for all variants; the common case (no
    // variants) hits zero extra queries.
    const parentIds = Array.from(
      new Set(
        filaments
          .map((f) => f.parentId && String(f.parentId))
          .filter((id): id is string => !!id),
      ),
    );
    const parents = parentIds.length
      ? ((await Filament.find({ _id: { $in: parentIds }, _deletedAt: null })
          .populate("compatibleNozzles")
          .populate("calibrations.nozzle")
          .populate("calibrations.printer")
          .populate("calibrations.bedType")
          .lean()) as IFilament[])
      : [];
    const parentById = new Map(parents.map((p) => [String(p._id), p]));

    // GH #1227 (Codex P2 r11): the Compare swatch derives finish + arrangement
    // from the EFFECTIVE `optTags` (the parent's when the own array is empty),
    // so the review flag is computed from the row that supplies the array —
    // the resolved doc carries the variant's OWN marker beside possibly
    // inherited tags, which is the wrong pairing. Response-only.
    const resolved = filaments.map((f) => {
      const parent = f.parentId ? parentById.get(String(f.parentId)) : undefined;
      const _optTagsAwaitReview = effectiveOptTagsAwaitReview(
        f as unknown as OptTagReviewRow,
        (parent ?? null) as unknown as OptTagReviewRow | null,
      );
      const doc = parent ? resolveFilament(f, parent) : f;
      (doc as unknown as Record<string, unknown>)._optTagsAwaitReview = _optTagsAwaitReview;
      return doc;
    });

    // Return in the same order the caller requested so the UI's columns
    // match the incoming list.
    const byId = new Map(resolved.map((f) => [String(f._id), f]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

    return NextResponse.json(ordered);
  } catch (err) {
    // GH #267: a malformed id in `ids` makes Mongoose throw a CastError
    // when casting `{ _id: { $in: ids } }`. errorResponseFromCaught maps
    // CastError → 400 instead of a generic 500.
    return errorResponseFromCaught(err, "Failed to fetch filaments for comparison");
  }
}

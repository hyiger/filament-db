import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { hasVariants } from "@/lib/resolveFilament";
import { parentPromotionState, performParentPromotion } from "@/lib/promoteParent";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * POST /api/filaments/{id}/promote  (GH #605, Phase 2b)
 *
 * "Convert to template": moves a legacy parent's own color/colorName/spools/
 * weight trio onto a NEW variant (named `<parent> — <colorName|Original>`),
 * then clears them on the parent — the same copy-first/clear-last promotion
 * the first-variant create path runs, at the user's explicit initiative
 * (decision 4 on #605: enforce forward only, no bulk migration).
 *
 * Only a filament that ALREADY has ≥1 live variant qualifies — a standalone
 * becomes a template implicitly via its first variant's creation (which runs
 * this same promotion behind the `promoteParent: true` opt-in).
 *
 * Responses:
 *   400 `not_a_template`     — no live variants (or the target is a variant)
 *   400 `nothing_to_convert` — the parent is already colorless + spool-free
 *   200 `{ variant, parent }` — the created variant + the cleared parent
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    const { id } = await params;
    if (!mongoose.isValidObjectId(id)) {
      return errorResponse("Invalid filament id", 400);
    }

    await dbConnect();

    const filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }

    // Variants can't be templates (no nested inheritance), and a standalone
    // isn't one yet — both fail the same derived-template test.
    if (filament.parentId || !(await hasVariants(Filament, id))) {
      return NextResponse.json(
        {
          error: "not_a_template",
          message:
            "Only a filament that already has color variants can be converted — a standalone becomes a template when its first variant is created.",
        },
        { status: 400 },
      );
    }

    const state = parentPromotionState(filament);
    if (!state.needed) {
      return NextResponse.json(
        {
          error: "nothing_to_convert",
          message: "This template already carries no color and no spools.",
        },
        { status: 400 },
      );
    }

    const variant = await performParentPromotion(Filament, filament);
    const parent = await Filament.findOne({ _id: id, _deletedAt: null }).lean();

    return NextResponse.json({ variant, parent });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to convert to template");
  }
}

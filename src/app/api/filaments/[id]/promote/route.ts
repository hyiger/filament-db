import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import PrintHistory from "@/models/PrintHistory";
import Printer from "@/models/Printer";
import { hasVariantsIncludingTrashed } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import {
  parentPromotionState,
  performParentPromotion,
  clearStalePromotionMarker,
} from "@/lib/promoteParent";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * POST /api/filaments/{id}/promote  (GH #605)
 *
 * "Convert to template": moves a legacy parent's own
 * color/colorName/spools/totalWeight (plus the lowStockThreshold that
 * alarms on that inventory) onto a NEW variant
 * (`<parent> — <colorName|Original>`), then clears them on the parent —
 * the same copy-first/clear-last promotion the first-variant create path
 * runs, at the user's explicit initiative (enforce forward only, no bulk
 * migration). The spoolWeight/netFilamentWeight SPEC pair stays on the
 * parent, where variants inherit it (GH #1048).
 *
 * Only a filament that ALREADY has variants qualifies — a standalone
 * becomes a template implicitly via its first variant's creation.
 *
 * Responses:
 *   400 `not_a_template`     — no variants (or the target is a variant)
 *   400 `nothing_to_convert` — the parent carries nothing that moves
 *   200 `{ variant, parent, resumed }`
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

    // Claim the parent BEFORE reading it: the whole read→guards→promote
    // sequence is serialized per filament id (same key as the
    // first-variant create and the PUT), with the snapshot fetched INSIDE
    // the lock. Two overlapping /promote calls run one after the other —
    // the second sees the cleared parent and takes the `nothing_to_convert`
    // exit instead of minting a duplicate "(2)" promotion copy.
    return await runExclusive(filamentLockKey(id), async () => {
      const filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
      if (!filament) {
        return errorResponse("Not found", 404);
      }

      // Variants can't be templates (no nested inheritance), and a filament
      // that never had a variant isn't one yet — both fail the same test.
      //
      // GH #1103: TRASHED variants count here, unlike everywhere else that
      // asks "is this a template". They have to: restore refuses a gated
      // family and points the user at this action, so requiring a LIVE
      // variant would make that advice unactionable and the family
      // unrestorable. Converting here IS the same decision the confirmation
      // used to bury inside a bulk restore — chosen with context, once.
      if (filament.parentId || !(await hasVariantsIncludingTrashed(Filament, id))) {
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
        // A promotion marker on a NON-carrying template is stale by
        // construction (completion clears it atomically with the moved
        // fields) — drop it lazily; nothing to resume or convert.
        if (filament.promotionInFlight != null) {
          await clearStalePromotionMarker(Filament, filament._id);
        }
        return NextResponse.json(
          {
            error: "nothing_to_convert",
            message:
              "This template already carries nothing that belongs on a variant — no color, no color name, no spools, no inventory weight.",
          },
          { status: 400 },
        );
      }

      // The external-ref models let the promotion remap persisted
      // (filamentId, spoolId) references onto the carrying variant —
      // history rows and AMS slots follow the moved spools. `resumed: true`
      // reports that this call ADOPTED the partial copy an interrupted
      // earlier promotion left behind (this route is the documented
      // recovery path); the end state is identical.
      //
      // GH #1103: reserve the names of this parent's TRASHED children.
      // `resolvePromotionVariantName` resolves against the partial unique
      // index (live rows only), so a tombstoned `Parent — Green` reads as
      // free and the promotion copy would take that exact name — restoring
      // the original child then fails the active-name conflict check, and
      // the "convert once and the whole family comes back" promise (the
      // ONLY route out of a gated restore since #1103) quietly doesn't
      // hold. Scoped to this parent's own non-purged children and passed
      // only from THIS route — the general "soft-deleted names are free"
      // rule is unchanged.
      const trashedChildren = await Filament.find({
        parentId: id,
        _deletedAt: { $ne: null },
        _purged: { $ne: true },
      })
        .select("name")
        .lean();
      const { variant, resumed } = await performParentPromotion(Filament, filament, {
        alsoTakenNames: new Set(
          trashedChildren.map((c: { name: string }) => c.name),
        ),
        externalRefs: { printHistory: PrintHistory, printer: Printer },
      });
      const parent = await Filament.findOne({ _id: id, _deletedAt: null }).lean();

      return NextResponse.json({ variant, parent, resumed });
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to convert to template");
  }
}

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
 * POST /api/filaments/{id}/promote  (GH #605, Phase 2b)
 *
 * "Convert to template": moves a legacy parent's own color/colorName/spools/
 * inventory totalWeight (plus the lowStockThreshold that alarms on that
 * inventory) onto a NEW variant (named
 * `<parent> — <colorName|Original>`), then clears them on the parent — the
 * same copy-first/clear-last promotion the first-variant create path runs,
 * at the user's explicit initiative (decision 4 on #605: enforce forward
 * only, no bulk migration). The spoolWeight/netFilamentWeight SPEC pair
 * stays on the parent, where variants inherit it (GH #1048).
 *
 * Only a filament that ALREADY has ≥1 live variant qualifies — a standalone
 * becomes a template implicitly via its first variant's creation (which runs
 * this same promotion behind the `promoteParent: true` opt-in).
 *
 * Responses:
 *   400 `not_a_template`     — no live variants (or the target is a variant)
 *   400 `nothing_to_convert` — the parent carries nothing that moves (no
 *                              color/colorName/spools/totalWeight; spec
 *                              fields alone are not "carrying")
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

    // Review P1-b: claim the parent BEFORE reading it. The whole
    // read→guards→promote sequence is serialized per filament id
    // (runExclusive — the same key the first-variant create and the
    // totalWeight PUT lock), and the snapshot is fetched INSIDE the lock.
    // Two overlapping /promote calls thus run one after the other: the
    // second sees the already-cleared parent and takes the existing 400
    // `nothing_to_convert` exit instead of minting a duplicate "(2)"
    // promotion copy. A /promote overlapping a first-variant POST
    // serializes the same way (both key on this id).
    return await runExclusive(filamentLockKey(id), async () => {
      const filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
      if (!filament) {
        return errorResponse("Not found", 404);
      }

      // Variants can't be templates (no nested inheritance), and a filament
      // that never had a variant isn't one yet — both fail the same test.
      //
      // GH #1103: TRASHED variants count here, unlike everywhere else that
      // asks "is this a template". They have to: when a legacy carrying
      // parent and all of its variants sit in the trash together, restoring
      // the first variant hits the #605 gate, and restore now refuses and
      // points the user at this action. If this route kept requiring a LIVE
      // variant, that advice would be unactionable and the family would be
      // unrestorable — the two checks have to agree on what a template is,
      // and restore's gate is about to become one.
      //
      // Converting here is not a workaround for the refusal, it IS the same
      // decision the confirmation used to bury inside a bulk restore: the
      // user sees the parent, its color and its spools, and chooses. What
      // changes is only that they choose with context, once, instead of
      // per-variant in a modal.
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
        // Round 10: a promotion marker on a NON-carrying template is stale
        // by construction (completion clears it atomically with the moved
        // fields) — drop it lazily; there is nothing to resume or convert.
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
      // (filamentId, spoolId) references onto the carrying variant (codex
      // round 4, F1) — history rows and AMS slots follow the moved spools.
      // Round 8 F2: `resumed: true` reports that this call ADOPTED the
      // partial copy an interrupted earlier promotion left behind (this
      // route is the documented recovery path for exactly that state) —
      // surfaced in the response so clients can tell recovery from a fresh
      // conversion; the end state is identical.
      const { variant, resumed } = await performParentPromotion(Filament, filament, {
        externalRefs: { printHistory: PrintHistory, printer: Printer },
      });
      const parent = await Filament.findOne({ _id: id, _deletedAt: null }).lean();

      return NextResponse.json({ variant, parent, resumed });
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to convert to template");
  }
}

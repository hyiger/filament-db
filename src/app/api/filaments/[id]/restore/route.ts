import { NextRequest, NextResponse } from "next/server";
import {
  findSurvivorId,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import {
  gateFirstVariantAdoption,
  restoreBlockedByTemplateBody,
} from "@/lib/createVariantGated";

/**
 * POST /api/filaments/{id}/restore — un-soft-delete a filament.
 *
 * The partial unique index on `name` only covers non-deleted documents, so
 * while a filament sat in the trash a new active one may have taken its
 * name — detected up front and refused with a clear 409 rather than a raw
 * duplicate-key error.
 *
 * GH #605: restoring a trashed VARIANT can mint its parent's first live
 * variant — and the parent may have re-acquired carrying state while it sat
 * variant-less — so the restore runs the same adoption gate as create/PUT.
 *
 * GH #1103 — but restore REFUSES rather than offering to promote. Create /
 * re-parent ask the user to build something new, so trading a confirmation
 * for a restructure is fair there; restore is the user asking for data
 * BACK, exactly as it was, and a per-variant "yes rewrites the family / no
 * leaves it unrestorable" modal on "Restore all" is neither. Silently
 * allowing it is worse: `_deletedAt` is the entire tombstone (no durable
 * record of the old family shape), and the relaxation would let a parent
 * that legitimately re-acquired a color become a carrying template with
 * live variants — the ambiguous shape #605 exists to prevent — with that
 * color then permanently unclearable (the form hides the editor but still
 * resubmits the seeded value; templateStrip only lets an explicit null
 * through). The restructure stays mandatory and stays the user's decision:
 * "Convert to template" on the parent, once for the whole family —
 * `POST /api/filaments/{id}/promote` accepts a parent whose variants are
 * all trashed precisely so that advice is actionable.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
    const { id } = await params;

    // Match the same filter the trash listing uses — a `_purged` row is a
    // "delete forever" tombstone and shouldn't be revivable from the API.
    const trashed = await Filament.findOne({
      _id: id,
      _deletedAt: { $ne: null },
      _purged: { $ne: true },
    });
    if (!trashed) {
      return errorResponse("Filament not in trash", 404);
    }

    // Name collision check — see the docblock. GH #1116: a MISSED collision
    // fails in the dangerous direction: `name` casts, so restoring a trashed
    // `"X"` while an unresolved active `"X "` survives finds nothing and
    // yields two ACTIVE rows rendering identically. The survivor lookup
    // compares TRIMMED forms, the question this guard is actually asking.
    // name-lookup-ok: survivor lookup below covers the cast case
    let conflict: { _id: unknown } | null = await Filament.findOne({
      name: trashed.name,
      _deletedAt: null,
      _id: { $ne: trashed._id },
    })
      .select("_id")
      .lean();
    if (!conflict) {
      const survivorId = await findSurvivorId(
        Filament.collection as unknown as MinimalNameCollection,
        String(trashed.name ?? ""),
        { _deletedAt: null, _id: { $ne: trashed._id } },
      );
      if (survivorId) conflict = { _id: survivorId };
    }
    if (conflict) {
      return errorResponse(
        `Cannot restore: another active filament named "${trashed.name}" already exists. Rename one of them first.`,
        409,
      );
    }

    if (trashed.parentId) {
      // GH #223: refuse to restore a variant whose parent is still in the
      // trash — every read path filters parents by `_deletedAt: null`, so
      // the variant would render with no inheritance and no obvious cause.
      // Surface the dependency: restore the parent first.
      const parent = await Filament.findOne({
        _id: trashed.parentId,
        _deletedAt: null,
      })
        .select("_id name")
        .lean();
      if (!parent) {
        return errorResponse(
          `Cannot restore: this variant's parent is still in the trash. Restore the parent first.`,
          409,
        );
      }

      // GH #605: the adoption gate — see the route docblock. The un-delete
      // save runs via `onReady`, INSIDE the parent's lock hold, so no
      // window exists between the gate's decision and the revive: a
      // concurrent write handing the parent carrying state serializes on
      // the same key and lands either before the gate (409s) or after the
      // restore (the PUT's template strip catches it).
      const adoption = await gateFirstVariantAdoption(Filament, trashed.parentId, {
        // GH #1103: never. Restore does not restructure a family — a
        // `promoteParent` in the body is IGNORED; the caller converts the
        // parent first.
        promoteParent: false,
        // The promotion copy must never squat on the reviving doc's name.
        adoptedName: trashed.name,
        onReady: async () => {
          trashed._deletedAt = null;
          // Same validateModifiedOnly rationale as the standalone path below.
          await trashed.save({ validateModifiedOnly: true });
        },
      });
      if (adoption.outcome === "parent_not_found") {
        // The parent was active above but vanished before the gate's in-lock
        // re-fetch — same dependency 409 as the pre-check.
        return errorResponse(
          `Cannot restore: this variant's parent is still in the trash. Restore the parent first.`,
          409,
        );
      }
      if (adoption.outcome === "parent_is_variant") {
        // The parent got re-parented while this variant sat in the trash (a
        // trashed variant doesn't count toward the PUT's has-children
        // guard), so reviving would nest inheritance — same no-nesting 400.
        return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
      }
      if (adoption.outcome === "promotion_required") {
        return NextResponse.json(restoreBlockedByTemplateBody(adoption), {
          status: 409,
        });
      }

      return NextResponse.json({ message: "Restored", _id: String(trashed._id) });
    }

    trashed._deletedAt = null;
    // GH #905: validate ONLY the modified path — a full-document save()
    // would run the numeric validators against every field, and a legacy
    // out-of-range value would 400 and permanently strand the doc in the
    // trash (the PUT filters `_deletedAt: null`, so the user can't edit it
    // back into range).
    await trashed.save({ validateModifiedOnly: true });

    return NextResponse.json({ message: "Restored", _id: String(trashed._id) });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to restore filament");
  }
}

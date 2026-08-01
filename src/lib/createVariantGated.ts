/**
 * GH #605 — the shared, race-hardened variant-creation gate (codex round 3,
 * Finding A).
 *
 * Creating the FIRST variant of a parent that still carries variant state (a
 * real color, a color name, its own spools, or a legacy inventory
 * totalWeight — see parentPromotionState) restructures a SECOND document:
 * the parent is promoted to a template and that state moves onto a new
 * sibling variant. The gate makes that side effect explicit and safe:
 *
 *   - without `promoteParent`, the caller gets a structured
 *     `promotion_required` outcome (the routes map it to the 409
 *     `parent_promotion_required` payload built by
 *     `promotionRequired409Body`) describing exactly what a confirmation
 *     would do — promotion is NEVER silent (owner decision);
 *   - with the flag, the request is dry-run validated BEFORE the promotion
 *     (no error responses after an irreversible side effect), the parent is
 *     promoted copy-first/clear-last, and the requested variant is created.
 *
 * The whole sequence — in-lock parent re-fetch, gate decision, promotion,
 * create — runs inside the per-parent keyed mutex (`runExclusive` on
 * `filamentLockKey(parentId)`), the same key the spool-POST and PUT routes
 * lock, so a spool accepted before this section is visible to the promotion
 * snapshot (and moves with the inventory), and one queued behind it hits the
 * spool route's template guard. See src/lib/filamentMutex.ts for why the
 * process-local lock is sufficient (single-process server) and which
 * compensating guards remain for out-of-process writers.
 *
 * Extracted from POST /api/filaments so every route that creates a variant
 * (the filament create route AND the OpenPrintTag variant import, GH #753)
 * enforces identical semantics — a secondary entry point must never mint the
 * first variant of a carrying parent without the confirmation round-trip.
 */

import { hasVariants } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import {
  parentPromotionState,
  promotionVariantBaseName,
  resolvePromotionVariantName,
  performParentPromotion,
} from "@/lib/promoteParent";

// Mirrors the loose doc typing the other model-level helpers use
// (see src/lib/promoteParent.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentDoc = Record<string, any>;

/** Everything a `parent_promotion_required` 409 needs to render the
 *  confirmation dialog (and to be replayed with `promoteParent: true`). */
export interface PromotionRequiredInfo {
  parentName: string;
  parentColor: string | null;
  spoolCount: number;
  variantName: string;
}

export type GatedVariantCreateResult =
  /** The parent vanished (soft-deleted) between the caller's own pre-lock
   *  validation and the in-lock re-fetch. Callers respond 400. */
  | { outcome: "parent_not_found" }
  /** First variant of a carrying parent and the caller didn't confirm —
   *  respond 409 with `promotionRequired409Body(info)`. Nothing written. */
  | ({ outcome: "promotion_required" } & PromotionRequiredInfo)
  /** Confirmed promotion, but the requested variant's name is already
   *  taken — failing BEFORE the promotion mutates anything (the create
   *  would E11000 with the parent already promoted). Respond 409. */
  | { outcome: "name_taken"; name: string }
  /** The variant was created (with the promotion first when one was due). */
  | { outcome: "created"; filament: FilamentDoc };

/**
 * The exact JSON body every route returns with the 409 — shared so the
 * primary create route and the OPT variant import stay byte-identical and
 * a client (the ConfirmDialog flow) can handle both the same way.
 */
export function promotionRequired409Body(
  info: PromotionRequiredInfo,
): Record<string, unknown> {
  return {
    error: "parent_promotion_required",
    message:
      `Creating the first variant makes "${info.parentName}" a template: ` +
      `its color and ${info.spoolCount} spool(s) move to a new variant ` +
      `named "${info.variantName}". Repeat the request with promoteParent: true to confirm.`,
    parentName: info.parentName,
    parentColor: info.parentColor,
    spoolCount: info.spoolCount,
    variantName: info.variantName,
  };
}

/**
 * Create `body` as a variant of `parentId`, running the full #605 promotion
 * gate inside the per-parent mutex.
 *
 * `body` must already be fully prepared (stripped/validated by the calling
 * route) and must carry `parentId`. The caller is expected to have done its
 * own pre-lock validation (parent exists, parent is not itself a variant);
 * this function re-fetches the parent FRESH inside the lock and re-decides
 * from that snapshot — never from anything the caller loaded earlier.
 *
 * Errors from the dry-run `validate()` and from the final `create()`
 * propagate unchanged (the routes' catch blocks map ValidationError → 400
 * and E11000 → 409 exactly as their non-variant paths do). The dry-run
 * guarantees a validation failure surfaces BEFORE the promotion, with the
 * parent completely untouched.
 */
export async function createVariantGated(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parentId: unknown,
  body: Record<string, unknown>,
  promoteParent: boolean,
  // Injected for unit tests, like pushSpoolWithTemplateGuard's check.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkHasVariants: (FilamentModel: any, id: string) => Promise<boolean> = hasVariants,
): Promise<GatedVariantCreateResult> {
  const parentKey = filamentLockKey(parentId);
  return runExclusive(parentKey, async (): Promise<GatedVariantCreateResult> => {
    const parent = await FilamentModel.findOne({
      _id: parentKey,
      _deletedAt: null,
    }).lean();
    if (!parent) {
      return { outcome: "parent_not_found" };
    }

    const promoState = parentPromotionState(parent);
    if (promoState.needed && !(await checkHasVariants(FilamentModel, parentKey))) {
      // The requested variant's own name is treated as taken when resolving
      // the promoted copy's name — the copy must never squat on the name
      // this request is about to create.
      const alsoTaken =
        typeof body.name === "string" ? new Set([body.name]) : undefined;
      if (!promoteParent) {
        const variantName = await resolvePromotionVariantName(
          FilamentModel,
          promotionVariantBaseName(parent.name, parent.colorName),
          alsoTaken,
        );
        return {
          outcome: "promotion_required",
          parentName: parent.name,
          parentColor: promoState.parentColor,
          spoolCount: promoState.spoolCount,
          variantName,
        };
      }
      // Confirmed. Fail a doomed duplicate-named request BEFORE mutating —
      // it would otherwise E11000 with the parent already promoted. No
      // transactions available (standalone mongod), so the residual risk
      // window is the name race between this pre-check and the create; the
      // promotion itself is copy-first/clear-last and self-consistent.
      if (
        typeof body.name === "string" &&
        (await FilamentModel.exists({ name: body.name, _deletedAt: null }))
      ) {
        return { outcome: "name_taken", name: body.name };
      }
      // Same principle for a schema-invalid request (bad color hex, negative
      // cost, …): the route-level guards don't run Mongoose validation, so
      // without this dry run the promotion would permanently restructure the
      // parent and THEN the create below would fail — an error response
      // after an irreversible side effect. Validate the exact payload the
      // create will use; a ValidationError propagates to the caller with
      // the parent completely untouched.
      await new FilamentModel(body).validate();
      await performParentPromotion(FilamentModel, parent, alsoTaken);
    }

    const filament = await FilamentModel.create(body);
    return { outcome: "created", filament };
  });
}

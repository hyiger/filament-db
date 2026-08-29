/**
 * GH #605 — the shared, race-hardened variant-creation gate. Creating the
 * FIRST variant of a carrying parent restructures a SECOND document (the
 * parent is promoted to a template), so it is NEVER silent: without
 * `promoteParent` the caller gets `promotion_required` (mapped to the 409
 * built by `promotionRequired409Body`); with the flag the request is dry-run
 * validated BEFORE the promotion (no error responses after an irreversible
 * side effect), then promoted copy-first/clear-last, then created.
 *
 * The whole sequence runs inside the per-parent keyed mutex (`runExclusive`
 * on `filamentLockKey(parentId)`) — the same key as the spool-POST and PUT
 * routes, the atlas import's template guard, the OPT sync's offered-set +
 * write section, and the restore adoption gate — so a spool accepted before
 * this section is visible to the promotion snapshot, and one queued behind
 * it hits the spool route's template guard. See src/lib/filamentMutex.ts for
 * why the process-local lock is sufficient.
 *
 * Shared by every route that creates a variant (the filament create route
 * AND the OpenPrintTag variant import, GH #753) — a secondary entry point
 * must never mint the first variant of a carrying parent without the
 * confirmation round-trip.
 */

import { hasVariants } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import {
  parentPromotionState,
  promotionVariantBaseName,
  resolvePromotionVariantName,
  performParentPromotion,
  resumePartialParentPromotion,
  clearStalePromotionMarker,
  orphansThresholdOnFirstVariant,
  clearOrphanedParentThreshold,
} from "@/lib/promoteParent";
// This module is server-only (imported by API routes exclusively), so it can
// carry the model imports that promoteParent.ts — imported by client
// components for parentPromotionState — must not. Every promotion routed
// through here passes them as the external (filamentId, spoolId) reference
// models the remap updates.
import PrintHistory from "@/models/PrintHistory";
import Printer from "@/models/Printer";

/** The real external-reference models every route-facing promotion remaps —
 *  see PromotionExternalRefModels. */
const EXTERNAL_REFS = { printHistory: PrintHistory, printer: Printer };

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
  /** GH #1103: the other two things that make a promotion due, so a message
   *  can name the one that is actually blocking rather than asserting a color
   *  the parent may not have. Optional so a caller constructing this shape
   *  without them still type-checks. */
  hasColorName?: boolean;
  hasInventoryWeight?: boolean;
}

export type GatedVariantCreateResult =
  /** The parent vanished (soft-deleted) between the caller's own pre-lock
   *  validation and the in-lock re-fetch. Callers respond 400. */
  | { outcome: "parent_not_found" }
  /** The parent became a VARIANT (a concurrent PUT re-parented it) between
   *  the caller's pre-lock no-nesting validation and the in-lock re-fetch —
   *  creating under it would mint a grandchild. Callers respond with the
   *  same no-nesting 400 their pre-lock check produces. */
  | { outcome: "parent_is_variant" }
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
 * The 409 body RESTORE returns instead (GH #1103). Same gate, different
 * verb, so a different answer: restore is the user asking for data BACK
 * exactly as it was, so it refuses and names the one action that unblocks
 * the whole family at once ("Convert to template" on the parent) rather
 * than prompting per variant mid-bulk-restore. Deliberately NOT the
 * `parent_promotion_required` code: that code means "repeat with
 * promoteParent: true", and on this route repeating changes nothing — a
 * client matching on it would loop.
 */
export function restoreBlockedByTemplateBody(
  info: PromotionRequiredInfo,
): Record<string, unknown> {
  // Name what is ACTUALLY blocking — a fixed "its own color and N spool(s)"
  // reads as plainly false to a user whose parent carries only a weight.
  const held: string[] = [];
  if (info.parentColor) held.push("its own color");
  if (info.hasColorName && !info.parentColor) held.push("its own color name");
  if (info.spoolCount > 0) {
    held.push(`${info.spoolCount} spool${info.spoolCount === 1 ? "" : "s"}`);
  }
  if (info.hasInventoryWeight) held.push("an inventory weight");
  const heldPhrase =
    held.length === 0
      ? "per-roll details"
      : held.length === 1
        ? held[0]
        : `${held.slice(0, -1).join(", ")} and ${held[held.length - 1]}`;

  // Deliberately does NOT predict the variant the conversion will create:
  // the gate resolves that name against ACTIVE rows while /promote also
  // reserves this parent's TRASHED children, so the two can legitimately
  // disagree (`Parent — Green` vs `Parent — Green (2)`).
  return {
    error: "parent_must_be_template_first",
    message:
      `Restoring this variant would make "${info.parentName}" a template, ` +
      `but it still holds ${heldPhrase}. ` +
      `Open "${info.parentName}" and use "Convert to template" — that moves them ` +
      `onto a variant of their own — then restore. ` +
      `Doing it there converts the whole family once, with the parent in front of you.`,
    parentName: info.parentName,
    parentColor: info.parentColor,
    spoolCount: info.spoolCount,
  };
}

/**
 * The gate+promote core, shared by CREATION (createVariantGated) and
 * ADOPTION (gateFirstVariantAdoption). MUST be called while holding
 * `runExclusive(filamentLockKey(parent._id))`, with a `parent` snapshot
 * fetched INSIDE that hold.
 *
 * `beforePromote` runs after the gate decides a CONFIRMED promotion is due,
 * immediately before the promotion itself — the fail-fast checks that must
 * surface BEFORE the irreversible restructuring of the parent (creation:
 * duplicate-name pre-check, dry-run validation; adoption: the target-liveness
 * re-check). Returning a result aborts with the parent untouched; a throw
 * propagates the same way. Generic over the abort payload so each caller
 * keeps its own outcome shape.
 */
async function gateAndPromoteInLock<TAbort>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parent: FilamentDoc,
  promoteParent: boolean,
  alsoTaken: ReadonlySet<string> | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkHasVariants: (FilamentModel: any, id: string) => Promise<boolean>,
  beforePromote?: () => Promise<TAbort | null>,
): Promise<
  | { kind: "parent_is_variant" }
  | ({ kind: "required" } & PromotionRequiredInfo)
  | { kind: "aborted"; abort: TAbort }
  | { kind: "ready"; clearOrphanedThreshold: boolean }
> {
  // Re-assert ROOTNESS from the in-lock snapshot, not just existence. The
  // callers' pre-lock validation rejects a parent that is itself a variant
  // (no nested inheritance), but a concurrent PUT can re-parent the doc
  // between that check and this lock — the gate would then mint a GRANDCHILD
  // (and a confirmed promotion would even hang a promotion copy off a
  // variant). The in-lock re-fetch owns the final answer.
  if (parent.parentId != null) {
    return { kind: "parent_is_variant" };
  }

  const promoState = parentPromotionState(parent);
  // A marker on a parent whose promotion state does NOT gate is STALE by
  // construction (completion clears the marker atomically with the fields,
  // so this shape only arises when a crashed run's carried state was later
  // cleared by hand) — drop it lazily and never resume off it.
  if (!promoState.needed && parent.promotionInFlight != null) {
    await clearStalePromotionMarker(FilamentModel, parent._id);
  }
  // A threshold-ONLY parent (threshold set, nothing that gates) still needs
  // the first-variant check — not to gate (no confirmation for a promotion
  // that moves nothing) but to flag the threshold as orphaned so the caller
  // clears it AFTER its variant write.
  const orphansThreshold = orphansThresholdOnFirstVariant(parent);
  if (promoState.needed || orphansThreshold) {
    if (await checkHasVariants(FilamentModel, String(parent._id))) {
      // NON-first variant, nothing gates — but a template should never be
      // CARRYING. A RETRY of a confirmed create/adopt whose promotion was
      // interrupted lands here (hasVariants is true because of the partial
      // copy) and would otherwise succeed while the parent still holds the
      // moved inventory. Probe for the marker-proven partial copy and resume
      // it BEFORE proceeding; without the proof (the genuine pre-#605 legacy
      // shape, or a lookalike child) the parent stays byte-for-byte
      // untouched — enforce-forward, "Convert to template" is the recovery.
      if (promoState.needed) {
        await resumePartialParentPromotion(FilamentModel, parent, EXTERNAL_REFS);
      }
      return { kind: "ready", clearOrphanedThreshold: false };
    }
    if (!promoState.needed) {
      // Ungated first-variant creation on a threshold-only parent: proceed
      // without any promotion, but tell the caller the parent's threshold
      // becomes dead config the moment its variant exists. The clear itself
      // is the CALLER's last step — parent state change last, consistent
      // with the crash posture.
      return { kind: "ready", clearOrphanedThreshold: true };
    }
    if (!promoteParent) {
      const variantName = await resolvePromotionVariantName(
        FilamentModel,
        promotionVariantBaseName(parent.name, parent.colorName),
        alsoTaken,
      );
      return {
        kind: "required",
        parentName: parent.name,
        parentColor: promoState.parentColor,
        spoolCount: promoState.spoolCount,
        hasColorName: promoState.hasColorName,
        hasInventoryWeight: promoState.hasInventoryWeight,
        variantName,
      };
    }
    if (beforePromote) {
      const abort = await beforePromote();
      if (abort) {
        return { kind: "aborted", abort };
      }
    }
    // A CARRYING promotion moves the threshold WITH the inventory
    // (performParentPromotion) — nothing is orphaned on this path.
    await performParentPromotion(FilamentModel, parent, {
      alsoTakenNames: alsoTaken,
      externalRefs: EXTERNAL_REFS,
    });
  }
  return { kind: "ready", clearOrphanedThreshold: false };
}

/**
 * Create `body` as a variant of `parentId`, running the full #605 promotion
 * gate inside the per-parent mutex.
 *
 * `body` must already be fully prepared (stripped/validated by the calling
 * route) and must carry `parentId`. The caller is expected to have done its
 * own pre-lock validation (parent exists, parent is not itself a variant);
 * this function re-fetches the parent FRESH inside the lock and re-decides
 * from that snapshot — never from anything the caller loaded earlier. Both
 * pre-lock facts are re-asserted in-lock: a vanished parent returns
 * `parent_not_found`, a re-parented one `parent_is_variant`.
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

    // The requested variant's own name is treated as taken when resolving
    // the promoted copy's name — the copy must never squat on the name
    // this request is about to create.
    const alsoTaken =
      typeof body.name === "string" ? new Set([body.name]) : undefined;
    const gate = await gateAndPromoteInLock(
      FilamentModel,
      parent,
      promoteParent,
      alsoTaken,
      checkHasVariants,
      async () => {
        // Confirmed. Fail a doomed duplicate-named request BEFORE mutating —
        // it would otherwise E11000 with the parent already promoted. The
        // residual risk window (no transactions) is the name race between
        // this pre-check and the create.
        if (
          typeof body.name === "string" &&
          (await FilamentModel.exists({ name: body.name, _deletedAt: null }))
        ) {
          // `as const` so the inferred TAbort keeps the literal outcome —
          // gateAndPromoteInLock is generic over the abort payload.
          return { outcome: "name_taken" as const, name: body.name };
        }
        // Same principle for a schema-invalid request: the route-level
        // guards don't run Mongoose validation, so without this dry run the
        // promotion would permanently restructure the parent and THEN the
        // create would fail — an error response after an irreversible side
        // effect. A ValidationError propagates with the parent untouched.
        await new FilamentModel(body).validate();
        return null;
      },
    );
    if (gate.kind === "parent_is_variant") {
      return { outcome: "parent_is_variant" };
    }
    if (gate.kind === "required") {
      return {
        outcome: "promotion_required",
        parentName: gate.parentName,
        parentColor: gate.parentColor,
        spoolCount: gate.spoolCount,
        hasColorName: gate.hasColorName,
        hasInventoryWeight: gate.hasInventoryWeight,
        variantName: gate.variantName,
      };
    }
    if (gate.kind === "aborted") {
      return gate.abort;
    }

    const filament = await FilamentModel.create(body);
    // The ungated first variant of a threshold-only parent just came alive —
    // clear the now-dead threshold AFTER the create (parent state change
    // last: a crash before this leaves a harmless legacy value, never a
    // variant-less parent without its alarm).
    if (gate.clearOrphanedThreshold) {
      await clearOrphanedParentThreshold(FilamentModel, parent._id);
    }
    return { outcome: "created", filament };
  });
}

export type FirstVariantAdoptionResult =
  /** The parent vanished (soft-deleted) between the caller's own pre-lock
   *  validation and the in-lock re-fetch. */
  | { outcome: "parent_not_found" }
  /** `opts.targetId` was supplied and the ADOPTED document vanished
   *  (soft-deleted) between the caller's own pre-lock validation and the
   *  last-responsible-moment in-lock re-check — caught BEFORE the confirmed
   *  promotion ran, so nothing was restructured. Callers respond with the
   *  same 404 their own write would produce. */
  | { outcome: "target_not_found" }
  /** The parent became a VARIANT (a concurrent PUT re-parented it) before
   *  the in-lock re-fetch — adopting under it would nest inheritance.
   *  Callers respond with the no-nesting 400. */
  | { outcome: "parent_is_variant" }
  /** Adopting this document would mint the FIRST live variant of a carrying
   *  parent and the caller didn't confirm — respond 409 with
   *  `promotionRequired409Body(info)`. Nothing written. */
  | ({ outcome: "promotion_required" } & PromotionRequiredInfo)
  /** Safe to proceed (no promotion was due, or the confirmed promotion ran).
   *  When `onReady` was supplied it has already executed, in-lock.
   *
   *  `clearOrphanedThreshold`: the adoption mints the first variant of a
   *  threshold-ONLY parent, and the gate could NOT clear the now-dead
   *  threshold itself because the adoption write is the CALLER's (no
   *  `onReady`). The caller MUST call `clearOrphanedParentThreshold` after
   *  its own write succeeds — and skip it when that write fails or is rolled
   *  back (parent state change last). Always `false` when `onReady` was
   *  supplied: the gate then clears in-lock right after it. */
  | { outcome: "ready"; clearOrphanedThreshold: boolean };

/**
 * ADOPTION gate: an EXISTING document is about to become `parentId`'s first
 * live variant — a PUT that introduces/changes the `parentId`, or a restore
 * that revives a trashed variant under a parent that re-acquired carrying
 * state while it was variant-less. Same contract as creation: 409
 * (`parent_promotion_required`) until the caller confirms with
 * `promoteParent: true`, then the parent is promoted copy-first/clear-last
 * before the adoption proceeds. No secondary entry point may mint a carrying
 * parent's first live variant without this round-trip.
 *
 * Owns its own `runExclusive` hold on the PARENT's key and re-fetches the
 * parent fresh inside it — callers must NOT already hold that key (the
 * chain would deadlock behind itself).
 *
 * `opts.onReady` runs while the parent's lock is STILL HELD, after the gate
 * clears — for adoption writes that can safely live under the parent's key
 * (the restore's un-delete save). The PUT deliberately does NOT use it: its
 * write section locks the TARGET id, and holding parent+target locks
 * simultaneously in caller-dependent order would risk an AB/BA deadlock, so
 * there the two locks are strictly sequential (residual window documented
 * at the call site). `opts.adoptedName` reserves the adopted document's
 * name when naming the promotion copy (the copy must never squat on it).
 *
 * `opts.targetId`: the id of the EXISTING document being adopted, when its
 * own write runs OUTSIDE this lock (the PUT path). The target-existence
 * precondition runs pre-lock, so a soft-DELETE of the target landing between
 * it and a CONFIRMED promotion would leave a completed promotion with no
 * adoption. Supplying the id re-checks the target is still alive INSIDE the
 * parent's lock, at the last responsible moment — immediately before
 * performParentPromotion — and aborts with `target_not_found` (nothing
 * restructured) when it is gone. The residual gap between this lock's
 * release and the target-lock write is deliberately NOT closed (it would
 * take a two-key lock order — the AB/BA deadlock above); the write-side
 * re-check documents that posture at the call site. The restore path doesn't
 * need this: its adoption write runs in-lock via `onReady`.
 */
export async function gateFirstVariantAdoption(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parentId: unknown,
  opts: {
    promoteParent: boolean;
    adoptedName?: unknown;
    targetId?: unknown;
    onReady?: () => Promise<void>;
    // Injected for unit tests, like createVariantGated's check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    checkHasVariants?: (FilamentModel: any, id: string) => Promise<boolean>;
  },
): Promise<FirstVariantAdoptionResult> {
  const parentKey = filamentLockKey(parentId);
  return runExclusive(parentKey, async (): Promise<FirstVariantAdoptionResult> => {
    const parent = await FilamentModel.findOne({
      _id: parentKey,
      _deletedAt: null,
    }).lean();
    if (!parent) {
      return { outcome: "parent_not_found" };
    }

    const alsoTaken =
      typeof opts.adoptedName === "string" ? new Set([opts.adoptedName]) : undefined;
    const gate = await gateAndPromoteInLock(
      FilamentModel,
      parent,
      opts.promoteParent,
      alsoTaken,
      opts.checkHasVariants ?? hasVariants,
      // beforePromote: when the adopted document's own write runs outside
      // this lock (targetId supplied — the PUT path), re-check it is still
      // alive immediately before a CONFIRMED promotion restructures the
      // parent. Adoption introduces no new document/name, so this is its
      // only fail-fast concern.
      opts.targetId !== undefined
        ? async () =>
            (await FilamentModel.exists({ _id: opts.targetId, _deletedAt: null }))
              ? null
              : ({ outcome: "target_not_found" } as const)
        : undefined,
    );
    if (gate.kind === "parent_is_variant") {
      return { outcome: "parent_is_variant" };
    }
    if (gate.kind === "required") {
      return {
        outcome: "promotion_required",
        parentName: gate.parentName,
        parentColor: gate.parentColor,
        spoolCount: gate.spoolCount,
        hasColorName: gate.hasColorName,
        hasInventoryWeight: gate.hasInventoryWeight,
        variantName: gate.variantName,
      };
    }
    if (gate.kind === "aborted") {
      return gate.abort;
    }
    if (opts.onReady) {
      await opts.onReady();
      // The adoption write just ran (in-lock), so the first variant of a
      // threshold-only parent now exists — clear the parent's dead threshold
      // last, same posture as the create path.
      if (gate.kind === "ready" && gate.clearOrphanedThreshold) {
        await clearOrphanedParentThreshold(FilamentModel, parentKey);
      }
      return { outcome: "ready", clearOrphanedThreshold: false };
    }
    return {
      outcome: "ready",
      clearOrphanedThreshold: gate.kind === "ready" && gate.clearOrphanedThreshold,
    };
  });
}

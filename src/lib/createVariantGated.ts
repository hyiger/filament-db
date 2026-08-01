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
 * lock (and, since codex round 4, the atlas import's template guard, the
 * OPT sync's offered-set+write section, and the restore adoption gate), so
 * a spool accepted before this section is visible to the promotion
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
  resumePartialParentPromotion,
  clearStalePromotionMarker,
  orphansThresholdOnFirstVariant,
  clearOrphanedParentThreshold,
} from "@/lib/promoteParent";
// This module is server-only (imported by API routes exclusively), so it can
// carry the model imports that promoteParent.ts — imported by client
// components for parentPromotionState — must not. Every promotion routed
// through here passes them as the external (filamentId, spoolId) reference
// models the F1 remap updates.
import PrintHistory from "@/models/PrintHistory";
import Printer from "@/models/Printer";

/** The real external-reference models every route-facing promotion remaps
 *  (codex round 4, F1) — see PromotionExternalRefModels. */
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
}

export type GatedVariantCreateResult =
  /** The parent vanished (soft-deleted) between the caller's own pre-lock
   *  validation and the in-lock re-fetch. Callers respond 400. */
  | { outcome: "parent_not_found" }
  /** The parent became a VARIANT (a concurrent PUT re-parented it) between
   *  the caller's pre-lock no-nesting validation and the in-lock re-fetch —
   *  creating under it would mint a grandchild (round 8 F1). Callers respond
   *  with the same no-nesting 400 their pre-lock check produces. */
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
 * The gate+promote core, shared by CREATION (createVariantGated) and
 * ADOPTION (gateFirstVariantAdoption — codex round 4, F2/F6). MUST be called
 * while holding `runExclusive(filamentLockKey(parent._id))`, with a `parent`
 * snapshot fetched INSIDE that hold.
 *
 * `beforePromote` runs after the gate decides a CONFIRMED promotion is due,
 * immediately before the promotion itself — the fail-fast checks that must
 * surface BEFORE the irreversible restructuring of the parent (creation:
 * duplicate-name pre-check, dry-run validation; adoption: the round-11
 * target-liveness re-check). Returning a result aborts with the parent
 * untouched; a throw propagates the same way. Generic over the abort
 * payload so each caller keeps its own outcome shape.
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
  // Round 8 F1: re-assert ROOTNESS from the in-lock snapshot, not just
  // existence. The callers' pre-lock validation rejects a parent that is
  // itself a variant (no nested inheritance), but a concurrent PUT can
  // re-parent the doc between that check and this lock — the gate would
  // then mint a GRANDCHILD (and a confirmed promotion would even hang a
  // promotion copy off a variant). Same posture as the parent_not_found
  // re-check: the in-lock re-fetch owns the final answer.
  if (parent.parentId != null) {
    return { kind: "parent_is_variant" };
  }

  const promoState = parentPromotionState(parent);
  // Round 10: a marker on a parent whose promotion state does NOT gate is
  // STALE by construction (completion clears the marker atomically with the
  // fields, so this shape only arises when a crashed run's carried state
  // was later cleared by hand) — drop it lazily and never resume off it.
  // Non-destructive housekeeping, safe on every gate pass.
  if (!promoState.needed && parent.promotionInFlight != null) {
    await clearStalePromotionMarker(FilamentModel, parent._id);
  }
  // Round 7 P2: a threshold-ONLY parent (threshold set, nothing that gates)
  // still needs the first-variant check — not to gate (owner decision: no
  // confirmation for a promotion that moves nothing) but to flag the
  // threshold as orphaned so the caller clears it AFTER its variant write.
  const orphansThreshold = orphansThresholdOnFirstVariant(parent);
  if (promoState.needed || orphansThreshold) {
    if (await checkHasVariants(FilamentModel, String(parent._id))) {
      // The parent already has live variants, so this is a NON-first variant
      // and nothing gates. But a template should never be CARRYING — when it
      // is, one cause is an INTERRUPTED promotion (round 8 F2's crash
      // window: copy created, remap/clear failed), and the round-8 detector
      // inside performParentPromotion is unreachable from here: a RETRY of
      // the original confirmed create/adopt request lands in this branch
      // (hasVariants is true because of the partial copy) and would succeed
      // while the parent still holds the moved inventory and every external
      // ref still points at it (round 9 F1). Probe for the partial copy and
      // resume it — remaps + clear only — BEFORE proceeding with the
      // requested create/adoption. Round 10: the probe is marker-driven
      // ONLY (parent.promotionInFlight paired with a live promotedByToken
      // variant — see findPartialPromotionVariant); resuming under that
      // proof completes an ALREADY-confirmed promotion and moves nothing
      // new. A carrying template WITHOUT the marker proof — the genuine
      // pre-#605 legacy shape, or a legitimate lookalike child that merely
      // coincides on name/values — makes resumePartialParentPromotion
      // return null and leaves the parent byte-for-byte untouched
      // (enforce-forward; "Convert to template" remains the recovery
      // affordance).
      if (promoState.needed) {
        await resumePartialParentPromotion(FilamentModel, parent, EXTERNAL_REFS);
      }
      return { kind: "ready", clearOrphanedThreshold: false };
    }
    if (!promoState.needed) {
      // Ungated first-variant creation on a threshold-only parent: proceed
      // without any promotion, but tell the caller the parent's threshold
      // becomes dead config the moment its variant exists (the form hides
      // it, the PUT strips it, the dashboard could evaluate it against a
      // template). The clear itself is the CALLER's last step — parent
      // state change last, consistent with the crash posture.
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
 * `parent_not_found`, a re-parented one `parent_is_variant` (round 8 F1).
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
        // it would otherwise E11000 with the parent already promoted. No
        // transactions available (standalone mongod), so the residual risk
        // window is the name race between this pre-check and the create; the
        // promotion itself is copy-first/clear-last and self-consistent.
        if (
          typeof body.name === "string" &&
          (await FilamentModel.exists({ name: body.name, _deletedAt: null }))
        ) {
          // `as const` so the inferred TAbort keeps the literal outcome —
          // gateAndPromoteInLock is generic over the abort payload.
          return { outcome: "name_taken" as const, name: body.name };
        }
        // Same principle for a schema-invalid request (bad color hex, negative
        // cost, …): the route-level guards don't run Mongoose validation, so
        // without this dry run the promotion would permanently restructure the
        // parent and THEN the create below would fail — an error response
        // after an irreversible side effect. Validate the exact payload the
        // create will use; a ValidationError propagates to the caller with
        // the parent completely untouched.
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
        variantName: gate.variantName,
      };
    }
    if (gate.kind === "aborted") {
      return gate.abort;
    }

    const filament = await FilamentModel.create(body);
    // Round 7 P2: the ungated first variant of a threshold-only parent just
    // came alive — the parent's threshold is now dead config; clear it AFTER
    // the create (parent state change last: a crash before this leaves a
    // harmless legacy value, never a variant-less parent without its alarm).
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
  /** Round 11 F2a: `opts.targetId` was supplied and the ADOPTED document
   *  vanished (soft-deleted) between the caller's own pre-lock validation
   *  and the last-responsible-moment in-lock re-check — caught BEFORE the
   *  confirmed promotion ran, so nothing was restructured. Callers respond
   *  with the same 404 their own write would produce. */
  | { outcome: "target_not_found" }
  /** The parent became a VARIANT (a concurrent PUT re-parented it) before
   *  the in-lock re-fetch — adopting under it would nest inheritance
   *  (round 8 F1). Callers respond with the no-nesting 400. */
  | { outcome: "parent_is_variant" }
  /** Adopting this document would mint the FIRST live variant of a carrying
   *  parent and the caller didn't confirm — respond 409 with
   *  `promotionRequired409Body(info)`. Nothing written. */
  | ({ outcome: "promotion_required" } & PromotionRequiredInfo)
  /** Safe to proceed (no promotion was due, or the confirmed promotion ran).
   *  When `onReady` was supplied it has already executed, in-lock.
   *
   *  Round 7 P2 — `clearOrphanedThreshold`: the adoption mints the first
   *  variant of a threshold-ONLY parent, and the gate could NOT clear the
   *  now-dead threshold itself because the adoption write is the CALLER's
   *  (no `onReady`). The caller MUST call `clearOrphanedParentThreshold`
   *  after its own write succeeds — and skip it when that write fails or is
   *  rolled back (parent state change last). Always `false` when `onReady`
   *  was supplied: the gate then clears in-lock right after it. */
  | { outcome: "ready"; clearOrphanedThreshold: boolean };

/**
 * ADOPTION gate (codex round 4, F2/F6): an EXISTING document is about to
 * become `parentId`'s first live variant — a PUT that introduces/changes the
 * `parentId`, or a restore that revives a trashed variant under a parent
 * that re-acquired carrying state while it was variant-less. Same contract
 * as creation: 409 (`parent_promotion_required`) until the caller confirms
 * with `promoteParent: true`, then the parent is promoted copy-first/
 * clear-last before the adoption proceeds. No secondary entry point may
 * mint a carrying parent's first live variant without this round-trip.
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
 * `opts.targetId` (round 11 F2a): the id of the EXISTING document being
 * adopted, when its own write runs OUTSIDE this lock (the PUT path). The
 * round-4 target-existence precondition runs pre-lock, so a soft-DELETE of
 * the target landing between it and a CONFIRMED promotion would leave a
 * completed promotion with no adoption. Supplying the id re-checks the
 * target is still alive INSIDE the parent's lock, at the last responsible
 * moment — immediately before performParentPromotion — and aborts with
 * `target_not_found` (nothing restructured) when it is gone. The residual
 * gap between this lock's release and the target-lock write is deliberately
 * NOT closed (it would take a two-key lock order — the AB/BA deadlock
 * above); the write-side re-check documents that posture at the call site.
 * The restore path doesn't need this: its adoption write runs in-lock via
 * `onReady`.
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
      // beforePromote (round 11 F2a): when the adopted document's own write
      // runs outside this lock (targetId supplied — the PUT path), re-check
      // it is still alive immediately before a CONFIRMED promotion
      // restructures the parent. Adoption introduces no new document/name,
      // so this is its only fail-fast concern.
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
        variantName: gate.variantName,
      };
    }
    if (gate.kind === "aborted") {
      return gate.abort;
    }
    if (opts.onReady) {
      await opts.onReady();
      // Round 7 P2: the adoption write just ran (in-lock), so the first
      // variant of a threshold-only parent now exists — clear the parent's
      // dead threshold last, same posture as the create path.
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

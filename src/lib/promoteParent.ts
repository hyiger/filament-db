import {
  survivorNameConflict,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
/**
 * GH #605 — parent promotion. A filament becomes a TEMPLATE the moment it
 * gains its first variant (template-ness is derived — never a schema flag).
 * Templates are colorless and hold no inventory, so a carrying parent's
 * color / colorName / spools / totalWeight / lowStockThreshold are MOVED
 * onto a new sibling variant; the SPEC pair (`spoolWeight` /
 * `netFilamentWeight`) deliberately stays on the template, where every
 * variant inherits it (GH #1048).
 *
 * No transactions on standalone mongod, so the protocol is
 * marker → copy → remap → complete, copy FIRST / clear LAST: a crash between
 * steps leaves a parent that still carries its legacy state (recoverable via
 * "Convert to template") rather than data loss. Resume detection is
 * DURABLE-MARKER-DRIVEN, never inferred: step 0 stamps
 * `promotionInFlight: { token, at }` on the parent (non-destructive), step 1
 * creates the copy carrying `promotedByToken: token`, step 2 remaps external
 * refs, step 3 clears the moved fields AND the marker in one write. A resume
 * requires the marker pair as PROOF. Value-equality heuristics were rejected
 * — value equality is not record identity, and a lookalike child could be
 * adopted and the parent's fields cleared without creating the sibling that
 * should have received them, losing an inventory record; the marker pair is
 * server-owned and stripped from every client body, so it is unforgeable.
 *
 * Entry points: POST /api/filaments (the FIRST variant of a carrying parent
 * 409s `parent_promotion_required` until the client confirms with
 * `promoteParent: true`) and POST /api/filaments/{id}/promote ("Convert to
 * template" — enforcement is forward only; legacy parents are never
 * bulk-migrated).
 */

// Mirrors the loose doc typing the other model-level helpers use
// (see src/lib/resolveFilament.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentDoc = Record<string, any>;

export interface ParentPromotionState {
  /** True when promoting this parent must move state onto a variant. */
  needed: boolean;
  /** The parent's own primary color, or null when it carries none. */
  parentColor: string | null;
  /** Number of spools the parent itself carries. */
  spoolCount: number;
  /** GH #1103: surfaced so a refusal can name what is ACTUALLY blocking it —
   *  `needed` is a disjunction of four things, and a message that always says
   *  "its own color and N spool(s)" is simply false for a colorName-only or
   *  totalWeight-only parent. */
  hasColorName: boolean;
  hasInventoryWeight: boolean;
}

/**
 * Does this (would-be) parent still carry state that belongs on a variant?
 * "Real color" is any non-empty stored hex — including the historical
 * #808080 gray default, which the pre-#605 form stamped on every filament;
 * it renders as the filament's color, so it moves like any other. A
 * non-empty `colorName` and a non-null `totalWeight` gate too. The SPEC pair
 * does NOT gate (spec alone is not "carrying"), nor does `lowStockThreshold`
 * alone — a threshold with no inventory to protect moves nothing worth
 * confirming, though it still MOVES when a promotion runs for the fields
 * that DO gate.
 */
export function parentPromotionState(parent: FilamentDoc): ParentPromotionState {
  const parentColor =
    typeof parent.color === "string" && parent.color !== "" ? parent.color : null;
  const hasColorName =
    typeof parent.colorName === "string" && parent.colorName.trim() !== "";
  const spoolCount = Array.isArray(parent.spools) ? parent.spools.length : 0;
  return {
    needed:
      parentColor != null || hasColorName || spoolCount > 0 || parent.totalWeight != null,
    parentColor,
    spoolCount,
    hasColorName,
    hasInventoryWeight: parent.totalWeight != null,
  };
}

/**
 * Does creating this parent's FIRST variant leave a dead `lowStockThreshold`
 * behind? True only for a threshold-ONLY parent — nothing gates, so no
 * promotion runs, but the moment the variant exists the form hides the field
 * and the PUT strips non-null writes of it: dead config with a live alarm.
 * A CARRYING parent deliberately returns false — its promotion MOVES the
 * threshold with the inventory, and clearing early would lose it. Same for
 * a parent that already has variants (the enforce-forward legacy shape).
 */
export function orphansThresholdOnFirstVariant(parent: FilamentDoc): boolean {
  return parent.lowStockThreshold != null && !parentPromotionState(parent).needed;
}

/**
 * Clear the orphaned threshold `orphansThresholdOnFirstVariant` diagnosed.
 * Callers MUST invoke this AFTER the first variant exists — parent state
 * change last, the same crash posture as performParentPromotion. Idempotent;
 * the `_deletedAt: null` re-filter keeps a concurrent soft-delete from being
 * turned into a mutated tombstone.
 */
export async function clearOrphanedParentThreshold(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parentId: unknown,
): Promise<void> {
  await FilamentModel.updateOne(
    { _id: parentId, _deletedAt: null },
    { $set: { lowStockThreshold: null } },
  );
}

/**
 * Base name for the variant that receives the parent's color/spools:
 * `<parent name> — <colorName>` when the parent has a color name, else
 * `<parent name> — Original`. (A stored name, not a UI string — deliberately
 * not translated so the record reads the same in every locale.)
 */
export function promotionVariantBaseName(
  parentName: string,
  colorName?: string | null,
): string {
  const suffix =
    typeof colorName === "string" && colorName.trim() !== ""
      ? colorName.trim()
      : "Original";
  return `${parentName} — ${suffix}`;
}

/**
 * Resolve the base name against the unique-name constraint (names are unique
 * among non-deleted docs — src/models/Filament.ts partial index): first free
 * of `base`, `base (2)`, `base (3)`, …
 *
 * `alsoTaken` — extra names to treat as occupied even though they aren't in
 * the DB yet. The variant-creation path passes the REQUESTED variant's name
 * so the promoted copy can never squat on it (the request is created right
 * after the promotion and would otherwise E11000 with the parent already
 * promoted).
 */
export async function resolvePromotionVariantName(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  baseName: string,
  alsoTaken?: ReadonlySet<string>,
): Promise<string> {
  let candidate = baseName;
  for (let n = 2; ; n++) {
    const taken =
      alsoTaken?.has(candidate) ||
      // name-lookup-ok: the survivor check below covers the cast case
      (await FilamentModel.exists({ name: candidate, _deletedAt: null })) ||
      // GH #1116: the GENERATED name needs the survivor check too — `exists`
      // casts, so against an active survivor stored as `"PLA — Red "` it
      // picks `"PLA — Red"`, the unique index compares the two raw strings
      // and permits it, and the promotion lands two active filaments that
      // render identically. Guarded on `.collection` because unit tests pass
      // MOCK models with no raw collection (see PromotionExternalRefModels
      // for why this module is model-agnostic); every real model has one.
      (typeof FilamentModel?.collection?.findOne === "function" &&
        (await survivorNameConflict(
          FilamentModel.collection as unknown as MinimalNameCollection,
          candidate,
        )) !== null);
    if (!taken) return candidate;
    candidate = `${baseName} (${n})`;
  }
}

/**
 * External collections that address spools by the `(filamentId, spoolId)`
 * pair. Injected (never imported) so this module stays model-free — it is
 * imported by client components for `parentPromotionState`, and a static
 * model import would drag Mongoose into the client bundle. Every server
 * caller passes the real `PrintHistory` + `Printer` models; `null` skips the
 * remap and is ONLY for unit tests that pin the FilamentModel-side contract
 * with mock models (a real promotion must always remap).
 */
export interface PromotionExternalRefModels {
  /** The PrintHistory model — `usage[].{filamentId,spoolId}` entries. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  printHistory: any;
  /** The Printer model — `amsSlots[].{filamentId,spoolId}` entries. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  printer: any;
}

export interface PerformParentPromotionOptions {
  /** Extra names to treat as occupied when naming the promotion copy —
   *  see resolvePromotionVariantName. */
  alsoTakenNames?: ReadonlySet<string>;
  /** Models holding external `(filamentId, spoolId)` references that must
   *  follow the moved spools — or `null` in unit tests
   *  that use mock models. */
  externalRefs: PromotionExternalRefModels | null;
}

/** `resumed: true` means an INTERRUPTED earlier run's partial copy was
 *  detected and adopted — the create was skipped and only the (idempotent)
 *  remap + clear were re-run. The end state is identical either way. */
export interface ParentPromotionOutcome {
  /** The carrying variant — freshly created, or the adopted partial copy. */
  variant: FilamentDoc;
  resumed: boolean;
}

/**
 * Remap external `(filamentId, spoolId)` references from the parent to the
 * promoted variant. Spool subdocument `_id`s are PRESERVED on the promoted
 * copy (they only need uniqueness within their parent document, and the
 * parent's copies are cleared in the same operation), so the spoolId half of
 * every persisted reference stays valid — only the filamentId half has to
 * move. `updateMany` + `arrayFilters` remaps every matching entry of a
 * multi-entry document in one write.
 *
 * Printer AMS slots ALSO support a filament-only "Any spool" assignment
 * (`filamentId` set, `spoolId: null`) that the moved-set remap can't see.
 * Those slots follow the promotion too — an AMS slot is a FORWARD-looking
 * assignment, and after promotion the template will never hold inventory
 * again, so "any spool of the parent" is permanently unsatisfiable there.
 * PrintHistory rows with `spoolId: null` deliberately do NOT get the same
 * treatment — history is a BACKWARD-looking record of what was consumed
 * under that name at the time, so those rows stay on the parent.
 */
async function remapExternalSpoolRefs(
  refs: PromotionExternalRefModels,
  parentId: unknown,
  variantId: unknown,
  movedSpoolIds: unknown[],
): Promise<void> {
  if (movedSpoolIds.length > 0) {
    await refs.printHistory.updateMany(
      { usage: { $elemMatch: { filamentId: parentId, spoolId: { $in: movedSpoolIds } } } },
      { $set: { "usage.$[u].filamentId": variantId } },
      { arrayFilters: [{ "u.filamentId": parentId, "u.spoolId": { $in: movedSpoolIds } }] },
    );
    await refs.printer.updateMany(
      { amsSlots: { $elemMatch: { filamentId: parentId, spoolId: { $in: movedSpoolIds } } } },
      { $set: { "amsSlots.$[s].filamentId": variantId } },
      { arrayFilters: [{ "s.filamentId": parentId, "s.spoolId": { $in: movedSpoolIds } }] },
    );
  }
  // Outside the moved-set guard: a color-only parent promotes with zero
  // spools, and its Any-spool slots would otherwise dangle forever.
  // `spoolId: null` in the $elemMatch and arrayFilter also matches a missing
  // field (Mongo null semantics), equivalent under the schema's default.
  await refs.printer.updateMany(
    { amsSlots: { $elemMatch: { filamentId: parentId, spoolId: null } } },
    { $set: { "amsSlots.$[a].filamentId": variantId } },
    { arrayFilters: [{ "a.filamentId": parentId, "a.spoolId": null }] },
  );
}

/** The parent's in-flight promotion token, or null. A malformed marker —
 *  no usable token string — is treated as absent: nothing can match it, so
 *  it can never prove a resume. */
function promotionMarkerToken(parent: FilamentDoc): string | null {
  const token = parent?.promotionInFlight?.token;
  return typeof token === "string" && token !== "" ? token : null;
}

/** Fresh random promotion token. `globalThis.crypto` (Node ≥ 20 and every
 *  browser) rather than an imported node:crypto — this module is imported by
 *  client components for parentPromotionState and must stay bundle-safe. */
function newPromotionToken(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Detect the partial copy an INTERRUPTED promotion left behind (the crash
 * window is create-succeeded-then-remap/clear-threw), so a retry resumes
 * instead of minting a second copy. Marker-driven ONLY: the parent's
 * `promotionInFlight.token` paired with a LIVE variant whose
 * `promotedByToken` equals it — a pair only steps 0+1 of this module's
 * protocol can produce, so a hit is PROOF, never a guess. No marker (or no
 * matching variant) means no resume, full stop: a lookalike child is just
 * another variant.
 */
async function findPartialPromotionVariant(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parent: FilamentDoc,
): Promise<FilamentDoc | null> {
  const token = promotionMarkerToken(parent);
  if (token == null) return null;
  return await FilamentModel.findOne({
    parentId: parent._id,
    _deletedAt: null,
    promotedByToken: token,
  });
}

/**
 * Lazily drop a STALE promotion marker — one still set on a parent whose
 * promotion state no longer gates (the caller's responsibility to have
 * checked). A marker lingering after COMPLETION is impossible by
 * construction (the step-3 write clears it atomically with the moved
 * fields), so this means a run crashed mid-protocol and the carried state
 * was later cleared by hand — nothing left to move, so the next gate /
 * promote pass clears the marker and does NOT resume. A copy-side
 * `promotedByToken` stays: harmless residue, and a future promotion mints a
 * fresh token.
 */
export async function clearStalePromotionMarker(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parentId: unknown,
): Promise<void> {
  await FilamentModel.updateOne(
    { _id: parentId, _deletedAt: null },
    { $set: { promotionInFlight: null } },
  );
}

/**
 * Step 3, shared by the fresh and resumed paths: clear the moved fields on
 * the parent AND drop the `promotionInFlight` marker in the SAME write, so
 * a parent can never end up cleared-but-marked or
 * unmarked-but-still-carrying. `_deletedAt: null` re-filter so a concurrent
 * soft-delete can't be resurrected into a mutated tombstone.
 *
 * `$inc __v` (verified by repro): overwriting the spools array via save()
 * would bump the version key, so this raw updateOne must too — otherwise a
 * HYDRATED doc loaded before the promotion that modified a spool
 * positionally (the print-history debit/refund saves, the spool usage
 * route, a CSV import's update-only bucket) still matches its `__v` in
 * save()'s version filter and re-materializes a phantom spool fragment onto
 * the freshly-cleared template. With the bump, every such stale save fails
 * as a VersionError, which those callers already map to their designed
 * 409-retry / failed-bucket paths.
 */
async function completeParentPromotion(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parentId: unknown,
): Promise<void> {
  await FilamentModel.updateOne(
    { _id: parentId, _deletedAt: null },
    {
      $set: {
        color: null,
        colorName: null,
        spools: [],
        totalWeight: null,
        lowStockThreshold: null,
        promotionInFlight: null,
      },
      $inc: { __v: 1 },
    },
  );
}

/**
 * The RESUME half of performParentPromotion, callable on its own: probes for
 * an interrupted run's partial copy and, on a hit, re-runs the idempotent
 * remaps and the completing clear WITHOUT creating anything. Returns the
 * adopted copy, or null when the marker/token proof is absent — the caller
 * must then leave the carried state exactly as-is; only a CONFIRMED
 * promotion may proceed. Exists because after a partial promotion the parent
 * already HAS a live variant, so a retried create/adopt request skips the
 * gate — and with it the detector inside performParentPromotion — entirely;
 * the gate probes this directly instead (see gateAndPromoteInLock). Callers
 * MUST hold the parent's mutex, with `parent` fetched inside that hold. No
 * confirmation gating here by design: the marker proves an already-confirmed
 * promotion started, and resuming moves nothing new.
 */
export async function resumePartialParentPromotion(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parent: FilamentDoc,
  externalRefs: PromotionExternalRefModels | null,
): Promise<FilamentDoc | null> {
  const partial = await findPartialPromotionVariant(FilamentModel, parent);
  if (!partial) return null;
  const movedSpools: FilamentDoc[] = Array.isArray(parent.spools) ? parent.spools : [];
  if (externalRefs) {
    await remapExternalSpoolRefs(
      externalRefs,
      parent._id,
      partial._id,
      movedSpools.map((s) => s._id),
    );
  }
  await completeParentPromotion(FilamentModel, parent._id);
  return partial;
}

/**
 * Perform the promotion (marker → copy → remap → complete; crash posture in
 * the module header). A crash after the copy but before the remap/complete
 * leaves the spools present on BOTH documents momentarily, but every
 * external reference still resolves against the parent — recoverable via
 * "Convert to template" or the gate's retry resume, so no reference is ever
 * left dangling and no data is lost.
 *
 * The variant body is built explicitly (never spread from the parent) so
 * server-owned identity never leaks across documents: the variant gets its
 * OWN top-level `instanceId` (pre-save hook) and its OWN `syncId`, and
 * `diameter` is pinned null so the schema's 1.75 default can't override a
 * non-1.75 parent (the GH #106 inherit rule); every other inheritable field
 * is simply omitted and inherits live via resolveFilament. Spool subdocs
 * move VERBATIM — `_id` AND `instanceId` both preserved (see
 * remapExternalSpoolRefs for why `_id` reuse is safe; `instanceId` is what
 * labels/QR/NFC reference and stays unique among live spools).
 */
export async function performParentPromotion(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parent: FilamentDoc,
  opts: PerformParentPromotionOptions,
): Promise<ParentPromotionOutcome> {
  const movedSpools: FilamentDoc[] = Array.isArray(parent.spools) ? parent.spools : [];

  // An interrupted earlier run left its marker + token-stamped copy behind —
  // RESUME it instead of creating a second one.
  const partial = await resumePartialParentPromotion(
    FilamentModel,
    parent,
    opts.externalRefs,
  );
  if (partial) {
    return { variant: partial, resumed: true };
  }

  // Step 0: stamp the durable marker BEFORE anything else. A marker may
  // already be present from a run that crashed between its own steps 0 and
  // 1 — REUSE that token rather than stacking a second marker, so whichever
  // create eventually lands is provably paired.
  let token = promotionMarkerToken(parent);
  if (token == null) {
    token = newPromotionToken();
    await FilamentModel.updateOne(
      { _id: parent._id, _deletedAt: null },
      { $set: { promotionInFlight: { token, at: new Date() } } },
    );
  }

  const name = await resolvePromotionVariantName(
    FilamentModel,
    promotionVariantBaseName(parent.name, parent.colorName),
    opts.alsoTakenNames,
  );

  // spoolWeight / netFilamentWeight are deliberately NOT copied — SPEC, not
  // inventory (GH #1048); the variant inherits them via resolveFilament.
  const variant = await FilamentModel.create({
    name,
    vendor: parent.vendor,
    type: parent.type,
    parentId: parent._id,
    diameter: null,
    color: parent.color ?? null,
    colorName: parent.colorName ?? null,
    totalWeight: parent.totalWeight ?? null,
    lowStockThreshold: parent.lowStockThreshold ?? null,
    spools: movedSpools,
    // Step 1: the copy-side half of the durable marker.
    promotedByToken: token,
  });

  // Step 2: persisted (filamentId, spoolId) consumers follow the spools
  // BEFORE the parent's copies are cleared. Runs even when NO spools moved —
  // the filament-only "Any spool" AMS assignments must still carry over.
  if (opts.externalRefs) {
    await remapExternalSpoolRefs(
      opts.externalRefs,
      parent._id,
      variant._id,
      movedSpools.map((s) => s._id),
    );
  }

  // Step 3: complete LAST — one atomic parent write clearing the moved
  // fields and the marker together (see completeParentPromotion).
  await completeParentPromotion(FilamentModel, parent._id);

  return { variant, resumed: false };
}

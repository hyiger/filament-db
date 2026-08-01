/**
 * GH #605 — parent/variant template model, Phase 2b: parent promotion.
 *
 * A filament becomes a TEMPLATE the moment it gains its first variant
 * (template-ness is derived — never a schema flag). Templates are colorless
 * and hold no inventory, so a parent that still carries variant state — a
 * real primary color, a color name, its own spools, or a legacy inventory
 * `totalWeight` — has that state MOVED onto a new sibling variant when it
 * is promoted:
 *
 *   1. copy color / colorName / spools / totalWeight onto a freshly created
 *      variant (spool subdoc `_id`s preserved), THEN
 *   2. remap external `(filamentId, spoolId)` references (PrintHistory
 *      usage entries, Printer AMS slots) onto the variant, THEN
 *   3. clear those fields on the parent.
 *
 * `lowStockThreshold` MOVES WITH the inventory (review P2): it alarms on the
 * remaining weight of the spools/totalWeight being moved, so leaving it on a
 * now-inventoryless template would fire "low stock" forever against an empty
 * parent while the variant that actually holds the rolls has no threshold.
 * It does NOT gate promotion, though — a threshold with no inventory to
 * protect is not "carrying" (see parentPromotionState).
 *
 * `spoolWeight` and `netFilamentWeight` deliberately do NOT move (GH #1048):
 * they are SPEC — the product line's tare and nominal net weight — not
 * inventory, and they STAY on the parent template where every variant
 * inherits them (resolveFilament lists both in INHERITABLE_FIELDS; the
 * promoted variant leaves its own fields blank so inheritance resolves
 * them). Only `totalWeight` is inventory and moves.
 *
 * Copy FIRST, clear LAST — there are no transactions available (standalone
 * mongod), so a crash between the steps leaves a parent that still carries
 * its legacy state (recoverable via the "Convert to template" action) rather
 * than data loss. Since round 8 (F2) that recovery is IDEMPOTENT: a retried
 * promotion detects the interrupted run's partial copy (see
 * findPartialPromotionVariant) and resumes — re-running only the remap and
 * clear — instead of minting a second " (N)" copy of the inventory.
 *
 * Two entry points share this module:
 *   - POST /api/filaments (variant creation): the FIRST variant of a
 *     carrying parent 409s (`parent_promotion_required`) until the client
 *     confirms with `promoteParent: true`.
 *   - POST /api/filaments/{id}/promote: the explicit "Convert to template"
 *     action on a legacy parent that predates the guards (decision 4 —
 *     enforce forward only, no bulk migration).
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
}

/**
 * Does this (would-be) parent still carry state that belongs on a variant?
 * "Real color" is any non-empty stored hex — including the historical
 * #808080 gray default, which the pre-#605 form stamped on every filament;
 * it renders as the filament's color, so it moves like any other. A
 * non-empty `colorName` gates too (it names THIS roll's color, exactly the
 * per-variant identity templates must not carry), as does a non-null
 * inventory `totalWeight`. The SPEC pair (`spoolWeight` /
 * `netFilamentWeight`) does NOT gate — spec alone is not "carrying": it
 * belongs on the template, where variants inherit it (GH #1048). Nor does
 * `lowStockThreshold` alone — a threshold with no inventory to protect
 * moves nothing worth confirming (it still MOVES when a promotion runs for
 * the fields that DO gate; see performParentPromotion).
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
  };
}

/**
 * Round 7 P2: does creating this parent's FIRST variant leave a dead
 * `lowStockThreshold` behind? True only for a threshold-ONLY parent — one
 * whose promotion state does NOT gate (no color, no colorName, no spools, no
 * totalWeight — nothing to move, so no promotion runs and none is offered)
 * but which still stores a threshold. The moment the first variant exists
 * the parent is a template: the form hides the field, the PUT strips any
 * non-null write of it, and the dashboard could otherwise evaluate the
 * leftover value against a template — dead config with a live alarm.
 *
 * A CARRYING parent deliberately returns false: its promotion (confirmed
 * now, or later via "Convert to template") MOVES the threshold with the
 * inventory (performParentPromotion), and clearing early would lose it.
 * Same for a parent that already has variants — the documented
 * enforce-forward legacy shape stays untouched.
 */
export function orphansThresholdOnFirstVariant(parent: FilamentDoc): boolean {
  return parent.lowStockThreshold != null && !parentPromotionState(parent).needed;
}

/**
 * Clear the orphaned threshold `orphansThresholdOnFirstVariant` diagnosed.
 * Callers MUST invoke this AFTER the first variant exists — parent state
 * change last, the same crash posture as performParentPromotion: a crash
 * before this step leaves harmless legacy config on a still-variant-less
 * parent, never a parent stripped of its alarm with nothing created.
 * Idempotent (`$set: null`); the `_deletedAt: null` re-filter keeps a
 * concurrent soft-delete from being turned into a mutated tombstone.
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
      (await FilamentModel.exists({ name: candidate, _deletedAt: null }));
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
   *  follow the moved spools (codex round 4, F1) — or `null` in unit tests
   *  that use mock models. */
  externalRefs: PromotionExternalRefModels | null;
}

/** What performParentPromotion did (round 8 F2): `resumed: false` is a fresh
 *  copy-remap-clear run; `resumed: true` means an INTERRUPTED earlier run's
 *  partial copy was detected and adopted — the create was skipped and only
 *  the (idempotent) remap + clear were re-run. Callers may log/report the
 *  distinction; the end state is identical either way. */
export interface ParentPromotionOutcome {
  /** The carrying variant — freshly created, or the adopted partial copy. */
  variant: FilamentDoc;
  resumed: boolean;
}

/**
 * Codex round 4, F1: remap external `(filamentId, spoolId)` references from
 * the parent to the promoted variant. Spool subdocument `_id`s are PRESERVED
 * on the promoted copy (they only need uniqueness within their parent
 * document, and the parent's copies are cleared in the same operation), so
 * the spoolId half of every persisted reference stays valid — only the
 * filamentId half has to move. `updateMany` + `arrayFilters` so multi-entry
 * documents (a multi-material job, a multi-slot AMS) remap every matching
 * entry in one write; entries whose spoolId is NOT in the moved set (or
 * whose filamentId isn't the parent) are untouched.
 *
 * Codex round 6, F2: Printer AMS slots ALSO support a filament-only "Any
 * spool" assignment (`filamentId` set, `spoolId: null`) that the moved-set
 * remap above can't see. Those slots follow the promotion too — an AMS slot
 * is a FORWARD-looking assignment ("load some spool of this filament next"),
 * and after promotion the template will never hold inventory again, so "any
 * spool of the parent" is permanently unsatisfiable there; the promoted
 * variant is where the spools now live. PrintHistory rows with
 * `spoolId: null` deliberately do NOT get the same treatment — history is a
 * BACKWARD-looking record of what was consumed under that name at the time,
 * so those rows stay on the parent (the round-4 posture, unchanged).
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
  // Round 6 F2: filament-only ("Any spool") AMS assignments follow the
  // promotion regardless of whether any spools moved — a color-only parent
  // can be promoted with zero spools, and its Any-spool slots would
  // otherwise dangle on the inventory-less template forever. `spoolId: null`
  // in both the $elemMatch and the arrayFilter also matches a missing field
  // (Mongo null semantics), which the schema's `default: null` makes
  // equivalent anyway.
  await refs.printer.updateMany(
    { amsSlots: { $elemMatch: { filamentId: parentId, spoolId: null } } },
    { $set: { "amsSlots.$[a].filamentId": variantId } },
    { arrayFilters: [{ "a.filamentId": parentId, "a.spoolId": null }] },
  );
}

/**
 * Round 8 F2: detect the partial copy an INTERRUPTED earlier promotion left
 * behind, so a retry resumes instead of minting a second copy. The crash
 * window is create-succeeded-then-remap/clear-threw: the variant exists,
 * the parent still carries. Without this, a retry's create would land a
 * `<base> (2)` duplicate holding a SECOND copy of the spools.
 *
 * Detection, against the parent's CURRENT in-lock state:
 *
 *  (a) spools case — a LIVE variant of this parent holding ANY of the
 *      parent's current spool subdoc `_id`s IS the partial promotion.
 *      Unambiguous: subdoc ids are copied verbatim and cleared from the
 *      parent only in the final step, so parent/variant overlap can only
 *      mean an interrupted run (no other write path copies spool subdocs
 *      across documents — a completed promotion leaves the parent with no
 *      spools, and any re-acquired spools get fresh ids).
 *
 *  (b) no-spools case — a LIVE variant of this parent whose name matches
 *      the deterministic promotionVariantBaseName (or its " (N)" suffixes)
 *      AND whose stored carried set — color, colorName, totalWeight,
 *      lowStockThreshold — equals the parent's. A genuine partial copy
 *      satisfies every one of those (they were copied verbatim from this
 *      same parent, whose carried fields a template's write paths won't
 *      have changed since: non-null writes are stripped). Residual
 *      ambiguity, documented honestly: a USER-created variant could
 *      coincide on the whole set. We cannot tell those apart — but full
 *      equality of the carried set makes the resume WRITE-EQUIVALENT to a
 *      fresh promotion: the variant already holds exactly the values the
 *      promotion would move, and the parent is cleared of the same values,
 *      so adopting the lookalike loses nothing either way. A parent that
 *      re-acquired a DIFFERENT carried set after a completed promotion
 *      fails the equality and gets its fresh copy (suffixed name) as
 *      before; the only cost of a near-miss is the pre-round-8 behavior (a
 *      fresh " (N)" copy), never data loss.
 */
async function findPartialPromotionVariant(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parent: FilamentDoc,
  movedSpools: FilamentDoc[],
): Promise<FilamentDoc | null> {
  if (movedSpools.length > 0) {
    return await FilamentModel.findOne({
      parentId: parent._id,
      _deletedAt: null,
      "spools._id": { $in: movedSpools.map((s) => s._id) },
    });
  }
  const base = promotionVariantBaseName(parent.name, parent.colorName);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return await FilamentModel.findOne({
    parentId: parent._id,
    _deletedAt: null,
    name: new RegExp(`^${escaped}( \\(\\d+\\))?$`),
    // The full carried set (null matches null-or-missing) — see (b) above.
    color: parent.color ?? null,
    colorName: parent.colorName ?? null,
    totalWeight: parent.totalWeight ?? null,
    lowStockThreshold: parent.lowStockThreshold ?? null,
  });
}

/**
 * Clear the moved fields on the parent — the promotion's LAST step (see the
 * module header's crash posture), shared by the fresh and resumed paths.
 * Clears ONLY the moved fields; the SPEC pair stays. `_deletedAt: null`
 * re-filter so a concurrent soft-delete can't be resurrected into a mutated
 * tombstone.
 *
 * `$inc __v` (codex round 3 sweep, verified by repro): overwriting the
 * spools array via save() would bump the version key (VERSION_INC), so
 * this raw updateOne must too — otherwise a HYDRATED doc loaded before
 * the promotion that modified a spool positionally (`spools.0.totalWeight`
 * — the print-history debit/refund saves, the spool usage route, a CSV
 * import's update-only bucket) still matches its `__v` in save()'s
 * VERSION_WHERE filter and re-materializes a phantom spool fragment onto
 * the freshly-cleared template. With the bump, every such stale save
 * fails as a VersionError, which those callers already map to their
 * designed 409-retry / failed-bucket paths.
 */
async function clearPromotedParentFields(
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
      },
      $inc: { __v: 1 },
    },
  );
}

/**
 * Perform the promotion: create the carrying variant, remap external spool
 * references onto it, then clear the moved fields on the parent. Returns the
 * created variant document plus whether the run RESUMED an interrupted
 * promotion (round 8 F2 — see findPartialPromotionVariant).
 *
 * The variant body is built explicitly (never spread from the parent) so
 * server-owned identity never leaks across documents: the variant gets its
 * OWN top-level `instanceId` (pre-save hook) and its OWN `syncId` — the
 * parent's cleared doc and the new variant sync as separate documents.
 * `diameter` is pinned null so the schema's 1.75 default can't override a
 * non-1.75 parent (the GH #106 inherit rule); every other inheritable field
 * is simply omitted and inherits live via resolveFilament.
 *
 * Spool subdocuments move VERBATIM — subdoc `_id` AND `instanceId` both
 * preserved (codex round 4, F1). The `_id` only needs uniqueness within its
 * parent document and the parent's copy is cleared in the same operation, so
 * reuse is safe — and it keeps every persisted `(filamentId, spoolId)`
 * consumer's spoolId half stable; `remapExternalSpoolRefs` then moves the
 * filamentId half. `instanceId` identifies the physical roll (labels/QR/NFC
 * reference it) and stays unique among live spools for the same reason.
 *
 * Ordering + crash posture (no transactions on standalone mongod):
 * copy → remap → clear. A crash after the copy but before the remap/clear
 * leaves the spools present on BOTH documents momentarily, but every
 * external reference still resolves against the parent (its spools are
 * still there) — recoverable via "Convert to template", no reference is
 * ever left dangling and no data is lost.
 */
export async function performParentPromotion(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parent: FilamentDoc,
  opts: PerformParentPromotionOptions,
): Promise<ParentPromotionOutcome> {
  const movedSpools: FilamentDoc[] = Array.isArray(parent.spools) ? parent.spools : [];

  // Round 8 F2: an interrupted earlier run (create succeeded, remap or clear
  // threw) left its partial copy behind — RESUME it instead of creating a
  // second one. Skip the create; re-run the remaps (idempotent — updateMany
  // with filters scoped to refs still pointing at the parent) and the clear
  // against the adopted copy.
  const partial = await findPartialPromotionVariant(FilamentModel, parent, movedSpools);
  if (partial) {
    if (opts.externalRefs) {
      await remapExternalSpoolRefs(
        opts.externalRefs,
        parent._id,
        partial._id,
        movedSpools.map((s) => s._id),
      );
    }
    await clearPromotedParentFields(FilamentModel, parent._id);
    return { variant: partial, resumed: true };
  }

  const name = await resolvePromotionVariantName(
    FilamentModel,
    promotionVariantBaseName(parent.name, parent.colorName),
    opts.alsoTakenNames,
  );

  // spoolWeight / netFilamentWeight are deliberately NOT copied — they are
  // SPEC, not inventory, and stay on the parent template; the variant's own
  // fields are left blank so resolveFilament inherits them (GH #1048).
  const variant = await FilamentModel.create({
    name,
    vendor: parent.vendor,
    type: parent.type,
    parentId: parent._id,
    diameter: null,
    color: parent.color ?? null,
    colorName: parent.colorName ?? null,
    totalWeight: parent.totalWeight ?? null,
    // The low-stock alarm follows the inventory it watches (review P2) —
    // same copy-first/clear-last write set as totalWeight.
    lowStockThreshold: parent.lowStockThreshold ?? null,
    spools: movedSpools,
  });

  // Codex round 4, F1: persisted (filamentId, spoolId) consumers follow the
  // spools BEFORE the parent's copies are cleared — see remapExternalSpoolRefs
  // and the crash-posture note in the docblock. Every spool subdoc from a
  // Mongoose document carries an `_id`, so no filtering is needed here.
  // Round 6 F2: the remap runs even when NO spools moved — a color-only
  // promotion still has to carry the parent's filament-only ("Any spool")
  // AMS assignments over to the variant; the spool-set remaps inside are
  // self-gated on a non-empty moved set.
  if (opts.externalRefs) {
    await remapExternalSpoolRefs(
      opts.externalRefs,
      parent._id,
      variant._id,
      movedSpools.map((s) => s._id),
    );
  }

  // Clear LAST (see module header and clearPromotedParentFields).
  await clearPromotedParentFields(FilamentModel, parent._id);

  return { variant, resumed: false };
}

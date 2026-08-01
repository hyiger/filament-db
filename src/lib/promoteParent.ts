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
 * than data loss.
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
 */
async function remapExternalSpoolRefs(
  refs: PromotionExternalRefModels,
  parentId: unknown,
  variantId: unknown,
  movedSpoolIds: unknown[],
): Promise<void> {
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

/**
 * Perform the promotion: create the carrying variant, remap external spool
 * references onto it, then clear the moved fields on the parent. Returns the
 * created variant document.
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
): Promise<FilamentDoc> {
  const name = await resolvePromotionVariantName(
    FilamentModel,
    promotionVariantBaseName(parent.name, parent.colorName),
    opts.alsoTakenNames,
  );

  const movedSpools: FilamentDoc[] = Array.isArray(parent.spools) ? parent.spools : [];

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
  if (opts.externalRefs && movedSpools.length > 0) {
    await remapExternalSpoolRefs(
      opts.externalRefs,
      parent._id,
      variant._id,
      movedSpools.map((s) => s._id),
    );
  }

  // Clear LAST (see module header) — and clear ONLY the moved fields; the
  // SPEC pair stays on the parent. `_deletedAt: null` re-filter so a
  // concurrent soft-delete can't be resurrected into a mutated tombstone.
  //
  // `$inc __v` (codex round 3 sweep, verified by repro): overwriting the
  // spools array via save() would bump the version key (VERSION_INC), so
  // this raw updateOne must too — otherwise a HYDRATED doc loaded before
  // the promotion that modified a spool positionally (`spools.0.totalWeight`
  // — the print-history debit/refund saves, the spool usage route, a CSV
  // import's update-only bucket) still matches its `__v` in save()'s
  // VERSION_WHERE filter and re-materializes a phantom spool fragment onto
  // the freshly-cleared template. With the bump, every such stale save
  // fails as a VersionError, which those callers already map to their
  // designed 409-retry / failed-bucket paths.
  await FilamentModel.updateOne(
    { _id: parent._id, _deletedAt: null },
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

  return variant;
}

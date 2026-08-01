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
 *      variant, THEN
 *   2. clear those fields on the parent.
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

/** A moved spool: same data, fresh subdoc `_id` (Mongoose assigns it when
 *  none is supplied). `instanceId` is PRESERVED — it identifies the physical
 *  roll (labels/QR/NFC already reference it) and the parent's copy is
 *  cleared right after, so it stays unique among live spools. */
function spoolForMove(spool: FilamentDoc): FilamentDoc {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, ...rest } = spool;
  return rest;
}

/**
 * Perform the promotion: create the carrying variant, then clear the moved
 * fields on the parent. Returns the created variant document.
 *
 * The variant body is built explicitly (never spread from the parent) so
 * server-owned identity never leaks across documents: the variant gets its
 * OWN top-level `instanceId` (pre-save hook) and its OWN `syncId` — the
 * parent's cleared doc and the new variant sync as separate documents.
 * `diameter` is pinned null so the schema's 1.75 default can't override a
 * non-1.75 parent (the GH #106 inherit rule); every other inheritable field
 * is simply omitted and inherits live via resolveFilament.
 */
export async function performParentPromotion(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parent: FilamentDoc,
  alsoTakenNames?: ReadonlySet<string>,
): Promise<FilamentDoc> {
  const name = await resolvePromotionVariantName(
    FilamentModel,
    promotionVariantBaseName(parent.name, parent.colorName),
    alsoTakenNames,
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
    spools: Array.isArray(parent.spools) ? parent.spools.map(spoolForMove) : [],
  });

  // Clear LAST (see module header) — and clear ONLY the moved fields; the
  // SPEC pair stays on the parent. `_deletedAt: null` re-filter so a
  // concurrent soft-delete can't be resurrected into a mutated tombstone.
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
    },
  );

  return variant;
}

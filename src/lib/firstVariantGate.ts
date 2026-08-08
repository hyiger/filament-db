/**
 * GH #605 / GH #1073 — the shared BULK-IMPORT first-variant adoption gate.
 *
 * Reason a bulk-import row/section must be skipped because its write would
 * surface the FIRST live variant of a parent that still holds its own
 * INVENTORY (spools / a legacy totalWeight). The interactive routes resolve
 * this with the 409-confirm-promote round-trip, but a bulk import has no way
 * to confirm a per-parent promotion — and promotion is NEVER silent (owner
 * decision) — so the row rejects with a per-row error instead. Once the user
 * promotes the parent ("Convert to template" on its detail page), a re-import
 * of the same row sails through.
 *
 * Extracted from `src/lib/importFilaments.ts` (GH #1073) because the CSV/XLSX
 * importer was the only bulk path enforcing it: the INI bulk phase-2 resurrect
 * (`src/lib/iniImportApply.ts`) and the Bambu bulk phase-2 resurrect
 * (`POST /api/filaments/bambustudio`) could each revive a TRASHED VARIANT by
 * name — and with the variant trashed, `hasVariants` reads false, so its
 * parent may legitimately have re-acquired spools as a standalone. Reviving
 * the variant would strand that inventory on a template with no confirmation,
 * exactly the state #605 forbids. All three bulk paths now share this one
 * decision.
 *
 * The Filament model is INJECTED (the `createVariantGated.ts` /
 * `pushSpoolWithTemplateGuard` posture) — this module carries no model import
 * of its own, so it can sit alongside the other #605 lib helpers without
 * coupling every importer to one mongoose registration.
 *
 * DELIBERATELY NARROWER than parentPromotionState: only the inventory fields
 * gate here, NOT color/colorName. The Filament schema defaults `color` to
 * #808080, so every parent a CSV batch just created from a row without a
 * Color cell "carries" a color it never really had — gating on it would
 * reject the variant rows of every in-batch parent+variant round-trip (the
 * GH #379/#951 export→reimport flows the CSV importer exists for), and a
 * colorless template can't even round-trip (an empty Color cell re-imports as
 * the gray default). A color-carrying parent gaining variants is exactly the
 * legacy pre-#605 shape the app tolerates enforce-forward and surfaces with
 * the "Convert to template" banner; stranded INVENTORY is the state #605
 * forbids, and spools / totalWeight never enter through the bulk importers,
 * so a true positive here is always pre-existing DB inventory worth stopping
 * for.
 *
 * Returns a null `reason` when the write is fine: parent missing (dangling
 * ref — the pre-existing posture writes the doc as-is), parent holds no
 * inventory, or parent already a template (≥1 live variant — nothing left to
 * gate).
 *
 * Call INSIDE `runExclusive(filamentLockKey(parentId))` together with the
 * write it protects, so the decision and the create/resurrect serialize with
 * the interactive promotion gate and the spool routes on the same key.
 *
 * Round 7 P2 — `orphanedThreshold`: true when the row's write mints the first
 * variant of a threshold-ONLY parent (`lowStockThreshold` set, nothing that
 * would gate a promotion — see orphansThresholdOnFirstVariant). The row
 * proceeds (nothing to confirm), but the caller must clear the parent's now
 * dead threshold AFTER the write surfaces a live variant — re-checking
 * `hasVariants` rather than trusting the pre-write snapshot, so a write that
 * missed its filter (or created a standalone instead) leaves the threshold
 * alone. A COLOR-carrying parent reports false on purpose: it stays the
 * enforce-forward legacy shape whose later "Convert to template" promotion
 * MOVES the threshold with the rest — clearing here would lose it.
 */

import { hasVariants } from "@/lib/resolveFilament";
import { orphansThresholdOnFirstVariant } from "@/lib/promoteParent";

export interface FirstVariantGateInfo {
  /** Human-readable per-row rejection, or null when the write may proceed. */
  reason: string | null;
  /** See the module docblock — clear the parent's dead threshold after the
   *  write surfaces a live variant. Mutually exclusive with `reason`. */
  orphanedThreshold: boolean;
}

export async function firstVariantGateInfo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parentId: unknown,
): Promise<FirstVariantGateInfo> {
  const parent = await FilamentModel.findOne({ _id: parentId, _deletedAt: null })
    // Only what the inventory + threshold checks read — spools projected to
    // bare _ids (the count is what matters; photoDataUrl can be MBs).
    .select("name color colorName totalWeight lowStockThreshold spools._id")
    .lean();
  if (!parent) return { reason: null, orphanedThreshold: false };
  const spoolCount = Array.isArray(parent.spools) ? parent.spools.length : 0;
  const carriesInventory = spoolCount > 0 || parent.totalWeight != null;
  const orphansThreshold = orphansThresholdOnFirstVariant(parent);
  if (!carriesInventory && !orphansThreshold) {
    return { reason: null, orphanedThreshold: false };
  }
  if (await hasVariants(FilamentModel, String(parentId))) {
    return { reason: null, orphanedThreshold: false };
  }
  if (!carriesInventory) {
    return { reason: null, orphanedThreshold: true };
  }
  const inventory =
    spoolCount > 0 ? `${spoolCount} spool(s)` : "a tracked total weight";
  return {
    reason:
      `Parent "${parent.name}" still holds its own inventory (${inventory}), which would be ` +
      `stranded on a template by its first variant. Promote the parent first ("Convert to ` +
      `template" on its detail page) or create the variant in the app to confirm the ` +
      `promotion, then re-import this row`,
    orphanedThreshold: false,
  };
}

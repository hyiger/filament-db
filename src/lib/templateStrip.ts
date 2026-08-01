/**
 * GH #605 — the per-variant fields a TEMPLATE (a filament with ≥1 live
 * variant) must not (re-)acquire: inventory (`totalWeight`, the
 * `lowStockThreshold` that alarms on it) plus color identity (`color`,
 * `colorName`). Inventory and color live on the variants; template-ness is
 * derived (hasVariants), never a schema flag.
 *
 * Shared by every writer that can $set these fields onto an EXISTING
 * filament:
 *   - PUT  /api/filaments/[id]                    (the regular edit)
 *   - POST /api/filaments/[id]                    (PrusaSlicer sync-back)
 *   - POST /api/filaments/[id]/orcaslicer         (OrcaSlicer sync-back)
 *   - POST /api/filaments/[id]/bambustudio        (Bambu per-id sync)
 *   - POST /api/filaments/bambustudio             (Bambu bulk import, update phases)
 *   - upsertIniFilament                           (both INI bulk importers)
 *   - upsertImportRows                            (CSV/XLSX importer, existing-row updates)
 *   - POST /api/openprinttag/import               (conditional-defaults backfill onto
 *     an existing row — a legacy template still carrying the '#808080' sentinel)
 *   - POST /api/filaments/import-atlas            (its own inline mirror — it
 *     also guards `spools` and builds per-field human-readable notes)
 *
 * Strip semantics (identical everywhere — the PUT defined them):
 *   - STRIP, don't reject, a NON-NULL write of any listed field: a slicer
 *     preset (like a stale edit form) echoes the promoted-away color back
 *     verbatim, and a 4xx would break the whole sync for a value the user
 *     never re-entered.
 *   - An EXPLICIT NULL passes through: clearing a legacy carrying parent's
 *     leftover value is legitimate cleanup, and blocking it would freeze
 *     exactly the pre-#605 state the model migrates away from.
 *   - The strip is reported (never silent): `_strippedTemplateFields` on
 *     per-id responses, a per-row note on bulk importers.
 */

/** Loosely-typed model handle — same posture as hasVariants / promoteParent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentModelLike = any;

import { hasVariants } from "@/lib/resolveFilament";

export const TEMPLATE_STRIP_FIELDS = [
  "totalWeight",
  "color",
  "colorName",
  "lowStockThreshold",
] as const;

export type TemplateStripField = (typeof TEMPLATE_STRIP_FIELDS)[number];

/**
 * Apply the template strip to an update's `$set` body IN PLACE: when `id`
 * is currently a template, delete every NON-NULL `TEMPLATE_STRIP_FIELDS`
 * member from `setBody` and return the deleted field names (empty array
 * when nothing was stripped — not a template, or no offending field).
 * Explicit nulls are left untouched (they pass through to the write).
 *
 * MUST be called inside `runExclusive(filamentLockKey(id), …)` TOGETHER
 * with the persisting write (review P1-c on the PUT): decided-then-written
 * across a gap, a write racing a first-variant promotion could pass the
 * hasVariants check while the target was still a standalone and persist
 * AFTER the promotion cleared it — re-materializing inventory/color on a
 * fresh template. Serialized, either the write lands first (the promotion's
 * fresh snapshot moves the value onto the promoted variant) or the
 * promotion lands first (and this re-check strips the write).
 *
 * `hasVariants` is only queried when a field actually offends, so the
 * common no-op sync costs nothing extra.
 */
export async function stripTemplateFieldsForWrite(
  FilamentModel: FilamentModelLike,
  id: unknown,
  setBody: Record<string, unknown>,
): Promise<string[]> {
  const offending = TEMPLATE_STRIP_FIELDS.filter((f) => setBody[f] != null);
  if (offending.length === 0) return [];
  if (!(await hasVariants(FilamentModel, String(id)))) return [];
  for (const f of offending) {
    delete setBody[f];
  }
  return [...offending];
}

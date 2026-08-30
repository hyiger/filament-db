/**
 * Templates are not printable stock, so they must not reach a slicer as
 * selectable user presets.
 *
 * A filament with live variants is a TEMPLATE (GH #605): an abstract product
 * line that deliberately carries no colour and no inventory. The slicer's
 * filament dropdown is a list of things you can load and print, so a template
 * appearing there is an entry the user can select but can never actually have
 * on a spool — and picking it silently prints with the family's shared spec
 * and no colour.
 *
 * The subtlety is that a template still has to be FETCHED, because its
 * variants resolve their inherited values from it. So this is a filter on what
 * is EMITTED, never on what is loaded: keep templates in the parent lookup,
 * drop them from the section list.
 */

/** Minimal row shape the filter needs — deliberately not the Mongoose doc. */
export interface ExportCandidate {
  _id: unknown;
  parentId?: unknown;
}

/**
 * Ids of every filament that currently has at least one live variant.
 *
 * Mirrors `GET /api/filaments/parents`: one `distinct` over the non-deleted
 * rows' `parentId`. Trashed variants deliberately do NOT count — a template
 * whose only variants are in the trash has no live colours to sell, so it is a
 * standalone again as far as the slicer is concerned, and it will re-acquire
 * template-ness if one is restored.
 */
export async function liveTemplateIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
): Promise<Set<string>> {
  const ids: unknown[] = await FilamentModel.distinct("parentId", {
    _deletedAt: null,
    parentId: { $ne: null },
  });
  return new Set(ids.filter(Boolean).map((id) => String(id)));
}

/**
 * Drop templates from a list bound for a slicer bundle.
 *
 * Pure and separately testable so the two bulk export routes cannot drift:
 * they run the identical filter over their identical query results.
 */
export function excludeTemplates<T extends ExportCandidate>(
  filaments: readonly T[],
  templateIds: ReadonlySet<string>,
): T[] {
  return filaments.filter((f) => !templateIds.has(String(f._id)));
}

/**
 * The 400 a single-filament export answers with when asked for a template.
 *
 * Exported as one object so all three per-slicer routes give byte-identical
 * wording — a caller that special-cases the message must not have to match
 * three variants of it.
 */
export const TEMPLATE_NOT_EXPORTABLE = {
  error: "template_not_exportable",
  message:
    "This filament is a template — an abstract product line with no colour or inventory. " +
    "Export one of its colour variants instead.",
} as const;

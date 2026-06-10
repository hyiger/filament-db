import Filament from "@/models/Filament";
import { resolveFilament } from "@/lib/resolveFilament";

/**
 * Resolve a lean filament's EFFECTIVE (variant→parent) field values.
 *
 * GH #607: the OpenPrintTag re-sync routes must compare/validate against
 * what a filament effectively *is*, not its raw stored doc. A variant that
 * leaves a field unset to inherit from its parent reads as `null`/`[]` on
 * the raw doc, so a diff against the upstream material would treat it as an
 * empty local value — offering a spurious gap-fill on `check` and (if the
 * two routes disagreed) rejecting the apply on `sync`. Both routes call
 * this so their diffs stay in lockstep. The `.bin` download route
 * (`openprinttag/route.ts`) does the equivalent inline.
 *
 * Returns the doc unchanged for a root filament (no `parentId`) or when the
 * parent can't be loaded (deleted/missing) — callers then diff the raw doc,
 * exactly as before this helper existed.
 */
export async function resolveEffectiveFilament(
  filament: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!filament.parentId) return filament;
  const parent = await Filament.findOne({
    _id: filament.parentId,
    _deletedAt: null,
  }).lean();
  if (!parent) return filament;
  return resolveFilament(
    filament as unknown as Parameters<typeof resolveFilament>[0],
    parent as unknown as Parameters<typeof resolveFilament>[1],
  ) as unknown as Record<string, unknown>;
}

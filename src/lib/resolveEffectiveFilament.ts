import Filament from "@/models/Filament";
import { resolveFilament } from "@/lib/resolveFilament";

export interface EffectiveFilament {
  /** The variant's effective (variant→parent resolved) values. For a root
   *  filament this is the doc unchanged. */
  effective: Record<string, unknown>;
  /** The PARENT's effective values, or null for a root filament (or when the
   *  parent can't be loaded). Used to decide whether clearing an inherited
   *  array would actually take — clearing a variant's array `$set`s `[]`,
   *  which then resolves back to the parent's array, so a clear only reaches
   *  empty when the parent's array is also empty (GH #607, Codex P2). */
  parentEffective: Record<string, unknown> | null;
}

/**
 * Resolve a lean filament's EFFECTIVE (variant→parent) field values, plus the
 * parent's own effective values.
 *
 * GH #607: the OpenPrintTag re-sync routes must compare/validate against what
 * a filament effectively *is*, not its raw stored doc. A variant that leaves a
 * field unset to inherit from its parent reads as `null`/`[]` on the raw doc,
 * so a diff against the upstream material would treat it as an empty local
 * value — offering a spurious gap-fill on `check` and (if the two routes
 * disagreed) rejecting the apply on `sync`. Both routes call this so their
 * diffs stay in lockstep. The `.bin` download route (`openprinttag/route.ts`)
 * does the equivalent inline.
 *
 * `parentEffective` is resolved recursively so a parent that is itself a
 * variant still reports its inherited values. Returns `{ effective: <doc>,
 * parentEffective: null }` for a root filament or when the parent can't be
 * loaded — callers then diff the raw doc, exactly as before this helper.
 */
export async function resolveEffectiveFilament(
  filament: Record<string, unknown>,
): Promise<EffectiveFilament> {
  return resolveEffectiveFilamentInner(filament, new Set());
}

/**
 * GH #954: the recursion has no depth or seen guard, so a `parentId` cycle
 * (a filament whose ancestor chain loops back — self-reference, or two variants
 * pointing at each other in bad/corrupted data) recurses forever awaiting
 * `Filament.findOne` and the request never returns. Thread a `seen` set of the
 * ids resolved so far in this chain; on revisiting one, stop resolving
 * inheritance and fall back to the raw doc (`parentEffective: null`) — the same
 * degradation already used when the parent can't be loaded. Best-effort for
 * broken data; a well-formed chain (no cycle) is unaffected.
 */
async function resolveEffectiveFilamentInner(
  filament: Record<string, unknown>,
  seen: Set<string>,
): Promise<EffectiveFilament> {
  if (!filament.parentId) return { effective: filament, parentEffective: null };
  // A DB-loaded doc always carries `_id`; String() it for the visited-set key.
  const selfId = String(filament._id);
  if (seen.has(selfId)) return { effective: filament, parentEffective: null };
  seen.add(selfId);
  const parent = await Filament.findOne({
    _id: filament.parentId,
    _deletedAt: null,
  }).lean();
  if (!parent) return { effective: filament, parentEffective: null };
  const effective = resolveFilament(
    filament as unknown as Parameters<typeof resolveFilament>[0],
    parent as unknown as Parameters<typeof resolveFilament>[1],
  ) as unknown as Record<string, unknown>;
  // Resolve the parent too (it may itself be a variant) so the "value after
  // clearing this variant's own array" is the parent's EFFECTIVE array.
  const { effective: parentEffective } = await resolveEffectiveFilamentInner(
    parent as unknown as Record<string, unknown>,
    seen,
  );
  return { effective, parentEffective };
}

/**
 * GH #605 — template guard for spool creation, race-hardened.
 *
 * POST /api/filaments/{id}/spools must refuse to add a spool to a TEMPLATE
 * (a filament with ≥1 live variant — inventory lives on the variants). The
 * naive guard is check-then-act: `hasVariants(...)` then `$push` — but a
 * concurrent FIRST-variant creation can land between the two, leaving a
 * fresh spool on a just-promoted template with no error anywhere.
 *
 * There are no transactions available (standalone mongod), so the fix is
 * revalidate-and-compensate:
 *
 *   1. pre-check: already a template → refuse, nothing written;
 *   2. `$push` the spool atomically;
 *   3. re-check: if the filament BECAME a template while we pushed,
 *      `$pull` the exact spool we just added (matched by its fresh subdoc
 *      `_id`) and report the same refusal.
 *
 * The compensation window is small and self-healing: if the process dies
 * between 2 and 3 the spool survives on the template — the same
 * enforce-forward posture as a legacy parent's pre-#605 spools (visible,
 * and movable via the explicit "Convert to template" action).
 *
 * The variant-check is INJECTED (same signature as `hasVariants` in
 * src/lib/resolveFilament.ts) so the compensation branch is unit-testable
 * with a stub that flips from false to true between the two calls.
 */

// Mirrors the loose doc typing the other model-level helpers use
// (see src/lib/promoteParent.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentDoc = Record<string, any>;

export type GuardedSpoolPushResult =
  /** The target is a template (detected before OR after the push; a
   *  post-push detection has already been compensated by pulling the spool
   *  back out). Callers respond 400 `template_no_spools` either way. */
  | { outcome: "template" }
  /** No live filament with that id. */
  | { outcome: "not_found" }
  /** The spool landed; `filament` is the post-push document. */
  | { outcome: "created"; filament: FilamentDoc };

/**
 * Push `newSpool` onto filament `id` unless the filament is a template —
 * including one that became a template DURING the push (see module header).
 *
 * `newSpool.instanceId` must be set (the route always stamps it — either the
 * validated client value or a fresh `generateInstanceId()`): it is how the
 * just-pushed subdocument is located in the returned document so the
 * compensating `$pull` can match its fresh `_id` exactly, and never a
 * concurrent writer's spool.
 *
 * A push error propagates to the caller unchanged (the route's catch maps
 * it), with nothing to compensate — the failed `$push` wrote nothing.
 */
export async function pushSpoolWithTemplateGuard(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  id: string,
  newSpool: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkHasVariants: (FilamentModel: any, id: string) => Promise<boolean>,
): Promise<GuardedSpoolPushResult> {
  if (await checkHasVariants(FilamentModel, id)) {
    return { outcome: "template" };
  }

  const filament = await FilamentModel.findOneAndUpdate(
    { _id: id, _deletedAt: null },
    { $push: { spools: newSpool } },
    { returnDocument: "after" },
  ).lean();

  if (!filament) {
    return { outcome: "not_found" };
  }

  if (await checkHasVariants(FilamentModel, id)) {
    // The first variant landed between the pre-check and the $push —
    // compensate by removing exactly the spool this call added. Match by
    // the fresh subdoc `_id`, located via the instanceId we stamped, so a
    // concurrent spool POST's subdocument can never be pulled by mistake.
    const added = Array.isArray(filament.spools)
      ? (filament.spools as FilamentDoc[]).find((s) => s.instanceId === newSpool.instanceId)
      : undefined;
    if (added) {
      await FilamentModel.updateOne(
        { _id: id },
        { $pull: { spools: { _id: added._id } } },
      );
    }
    return { outcome: "template" };
  }

  return { outcome: "created", filament };
}

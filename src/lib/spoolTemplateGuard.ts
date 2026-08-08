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

import { findSpoolByInstanceId } from "@/lib/spoolResponseShape";

// Mirrors the loose doc typing the other model-level helpers use
// (see src/lib/promoteParent.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentDoc = Record<string, any>;

export type GuardedSpoolPushResult =
  /** The target is a template (detected before OR after the push; a
   *  post-push detection has already been compensated by pulling the spool
   *  back out). Callers respond 400 `template_no_spools` either way. */
  | { outcome: "template" }
  /** No live filament matched the push filter — the id doesn't exist, or an
   *  `extraFilter` condition (spool cap, name pin) didn't hold. */
  | { outcome: "not_found" }
  /** The spool landed; `filament` is the post-push document. */
  | { outcome: "created"; filament: FilamentDoc };

/**
 * The exact 400 body every spool-attach route returns when the target is a
 * template — shared (codex round 3, Finding B) so POST /filaments/{id}/spools
 * and the Prusament importer answer byte-identically and a client can handle
 * both the same way. Machine-readable `error` code, human `message` — the
 * shape the other structured rejections use (name_id_mismatch).
 */
export const TEMPLATE_NO_SPOOLS_BODY = {
  error: "template_no_spools",
  message:
    "This filament is a template (it has color variants) and cannot hold spools — add the spool to one of its variants instead.",
} as const;

/**
 * Push `newSpool` onto filament `id` unless the filament is a template —
 * including one that became a template DURING the push (see module header).
 *
 * `newSpool.instanceId` must be set (the route always stamps it — either the
 * validated client value or a fresh `generateInstanceId()`): it is how the
 * just-pushed subdocument is located in the returned document so the
 * compensating `$pull` can match its fresh `_id` exactly, and never a
 * concurrent writer's spool. The lookup is a duplicate-tolerant TAIL scan
 * (`findSpoolByInstanceId`, GH #1073) — see the compensation branch below
 * for why a head-first find could pull the wrong, pre-existing spool.
 *
 * A push error propagates to the caller unchanged (the route's catch maps
 * it), with nothing to compensate — the failed `$push` wrote nothing.
 *
 * `options.extraFilter` (codex round 3, Finding B) merges additional
 * conditions into the atomic push's filter — the Prusament importer needs
 * its per-filament spool cap (`$expr` on the spools size) and, on the
 * match-by-name fallbacks, a `name` pin enforced in the SAME atomic write
 * the original route used. A filter miss reports `not_found`; the caller
 * differentiates (cap vs gone) with its own probe, exactly as before.
 */
export async function pushSpoolWithTemplateGuard(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  id: string,
  newSpool: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkHasVariants: (FilamentModel: any, id: string) => Promise<boolean>,
  options?: { extraFilter?: Record<string, unknown> },
): Promise<GuardedSpoolPushResult> {
  if (await checkHasVariants(FilamentModel, id)) {
    return { outcome: "template" };
  }

  const filament = await FilamentModel.findOneAndUpdate(
    { _id: id, _deletedAt: null, ...(options?.extraFilter ?? {}) },
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
    //
    // GH #1073: the instanceId lookup scans from the TAIL
    // (findSpoolByInstanceId — shared with the #1027 create-response
    // lookup): `$push` appends, so the just-pushed subdoc is the LAST
    // match. instanceId uniqueness is only best-effort — the spool POST's
    // `isSpoolInstanceIdTaken` pre-check runs OUTSIDE the per-filament
    // lock (a documented race that can admit a duplicate), and snapshot
    // restores / hybrid whole-doc copies carry ids verbatim — so a
    // head-first `find` could resolve an OLDER pre-existing spool with the
    // same id, and the $pull would then permanently delete that spool
    // (photo, usageHistory, dryCycles) while the just-pushed one stayed on
    // the now-template filament. The duplicate-tolerant tail scan pins the
    // fresh subdoc instead.
    const added = findSpoolByInstanceId(
      Array.isArray(filament.spools) ? (filament.spools as FilamentDoc[]) : null,
      String(newSpool.instanceId),
    );
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

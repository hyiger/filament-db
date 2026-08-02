/**
 * GH #1027: opt-in response shaping for the five spool-mutation routes
 * (POST /spools, PUT + DELETE /spools/{spoolId}, POST …/usage,
 * POST …/dry-cycles).
 *
 * The DEFAULT (no `shape` param) response is the whole filament document —
 * every spool's photoDataUrl blob and usageHistory ledger — which is the
 * historical contract shipped clients parse (notably EAS-distributed mobile
 * builds that update out-of-band from the desktop server, whose
 * `handleSpoolUpdated` reads `.spools` off the body). The default must stay
 * byte-identical.
 *
 * `?shape=spool` opts into the slim shape: `{ spool: <the affected spool> }`
 * for the four routes where the spool still exists, and
 * `{ deleted: true, spoolId }` for DELETE (the post-$pull document no longer
 * contains the spool, so there is nothing to echo). This mirrors the #1005
 * query-side projection sweep on the response side.
 *
 * The param is strictly validated: an unrecognized value is a 400, so a typo
 * (`?shape=spol`) fails loudly instead of silently returning the
 * multi-megabyte default the caller was trying to avoid.
 */

export type SpoolResponseShape = "full" | "spool";

/**
 * Parse the `shape` query param off a request URL. Returns `null` for an
 * unrecognized value — the route turns that into a 400.
 */
export function parseSpoolResponseShape(
  searchParams: URLSearchParams,
): SpoolResponseShape | null {
  const raw = searchParams.get("shape");
  if (raw === null) return "full";
  if (raw === "spool") return "spool";
  return null;
}

/** Error message the routes return alongside the 400 for a bad `shape`. */
export const INVALID_SHAPE_MESSAGE =
  'Invalid shape parameter: expected "spool"';

/**
 * Locate a spool subdocument by `_id` on either a lean (plain-object) or
 * hydrated document's spools array — `_id` is an ObjectId instance in both,
 * so the comparison goes through String().
 */
export function findSpoolById<T extends { _id: unknown }>(
  spools: readonly T[] | undefined | null,
  spoolId: string,
): T | null {
  return spools?.find((s) => String(s._id) === spoolId) ?? null;
}

/**
 * Locate a just-created spool by its instanceId. The POST route can't know
 * the fresh subdocument's `_id` before the $push, but it always stamps
 * `instanceId` explicitly — the same invariant pushSpoolWithTemplateGuard's
 * compensation branch relies on to find the spool it may need to pull back
 * out (src/lib/spoolTemplateGuard.ts).
 */
export function findSpoolByInstanceId<T extends { instanceId?: unknown }>(
  spools: readonly T[] | undefined | null,
  instanceId: string,
): T | null {
  return spools?.find((s) => s.instanceId === instanceId) ?? null;
}

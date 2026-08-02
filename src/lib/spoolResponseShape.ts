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
 *
 * Case-INSENSITIVE on purpose: the routes' `"spools._id"` query filters go
 * through Mongoose's ObjectId cast, which accepts upper/mixed-case 24-hex —
 * so the write preceding this lookup COMMITS for such an id, while
 * `String(objectId)` is always lowercase. A case-sensitive compare here
 * would answer that committed write with a 404, and a retrying client
 * would double-apply it (adversarial-review finding on GH #1027).
 */
export function findSpoolById<T extends { _id: unknown }>(
  spools: readonly T[] | undefined | null,
  spoolId: string,
): T | null {
  const want = spoolId.toLowerCase();
  return spools?.find((s) => String(s._id).toLowerCase() === want) ?? null;
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
  // Scan from the TAIL: $push appends, so the just-created spool is the
  // LAST element. instanceId uniqueness is best-effort (a documented
  // read-then-write race can admit a duplicate), and a first-match scan
  // would then identify the WRONG, pre-existing spool in the create
  // response (adversarial-review finding on GH #1027).
  if (!spools) return null;
  for (let i = spools.length - 1; i >= 0; i--) {
    if (spools[i].instanceId === instanceId) return spools[i];
  }
  return null;
}

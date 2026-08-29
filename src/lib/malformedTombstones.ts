/**
 * Repair tombstones the sync engine cannot read — `_deletedAt` values that
 * `readTimestamp` parses to nothing (GH #1152). The canonical instance is the
 * raw-driver `_deletedAt: ""`.
 *
 * ## Why this shape is uniquely poisonous
 *
 * Mongoose cannot produce it (an empty string casts to null on a Date path),
 * so it only arrives via a raw-driver write — an external tool against a
 * shared Atlas, a raw import, or the sync engine itself. Once present, it
 * sits BETWEEN the two classifications the engine uses: OUTSIDE the partial
 * unique name index (`{_deletedAt: null}` matches null and missing only) yet
 * DELETED to the sync loop (`_deletedAt != null`). This removes the shape
 * instead of guarding every reader.
 *
 * The write-site guards in `electron/sync-service.ts` stop the ENGINE from
 * spreading the value; this pass heals what already exists — without it, a
 * peer that still carries the shape re-copies it forward on the next
 * whole-document LWW transfer (`stripForTransfer` drops only `_id`/`__v`).
 *
 * ## The stamp is EPOCH, and that is a decision, not a default
 *
 * `new Date(0)`, because the engine already treats an unreadable tombstone as
 * time zero (`readTimestamp(x) ?? 0`), so epoch preserves every LWW outcome
 * exactly: a live peer with any real `updatedAt` still wins and resurrects,
 * and a both-malformed pair becomes a legal tombstone with unchanged
 * arithmetic. Stamping `new Date()` would silently PROMOTE the malformed
 * tombstone into a fresh delete that beats older live edits — trashing a row
 * the user still has. And normalizing to `null` is explicitly rejected: that
 * moves the row INTO the partial unique name index mid-pass, where it can
 * E11000 against an active same-name row — the #1116 zombie failure mode —
 * and silently resurrects rows in the UI.
 *
 * ## What is deliberately left alone
 *
 * Anything `readTimestamp` CAN read: real Dates, parseable ISO strings,
 * finite numbers. The engine tolerates those today, and normalizing them
 * would CHANGE their LWW arithmetic — the opposite of a repair.
 *
 * Idempotent: a repaired row carries a real Date and no longer matches.
 */

/** Mirrors `SyncService.readTimestamp`'s acceptance, which is the contract:
 *  repair exactly what that helper cannot read. */
export function isReadableTombstone(value: unknown): boolean {
  if (value == null) return true; // null/missing = not a tombstone at all
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "string") return !Number.isNaN(Date.parse(value));
  if (typeof value === "number") return !Number.isNaN(value);
  return false; // objects, booleans — nothing readTimestamp understands
}

/** The minimal surface the repair needs — injected, like `purgedZombies`,
 *  because the Electron sync service holds raw driver handles with no
 *  Mongoose connection to the remote peer. */
export interface MinimalTombstoneCollection {
  find(
    filter: Record<string, unknown>,
    options: { projection: Record<string, number> },
  ): { toArray(): Promise<Array<{ _id: unknown; _deletedAt?: unknown }>> };
  bulkWrite(
    operations: Array<{
      updateOne: {
        filter: Record<string, unknown>;
        update: Record<string, unknown>;
      };
    }>,
  ): Promise<{ modifiedCount?: number } | unknown>;
}

/**
 * Stamp every unreadable `_deletedAt` in `collection` to epoch.
 *
 * Returns how many rows were repaired, for logging. The candidate query
 * excludes BSON dates server-side (always readable) and nulls; the JS filter
 * then keeps only values `readTimestamp` cannot read, so parseable strings
 * and numbers pass through untouched.
 */
export async function repairMalformedTombstones(
  collection: MinimalTombstoneCollection,
): Promise<number> {
  // `$exists` ONLY. Query-form `$type: "date"` matches array ELEMENTS, so it
  // hid `[new Date()]`; `$nin: [null]` has the SAME multikey semantics and hid
  // `[null]` and `[null, "bad"]`. Every value-inspecting query operator
  // evaluates against elements when the field holds an array, and arrays are
  // precisely a shape this repair exists to catch — so the server side gets
  // NO value predicate at all. The JS filter below is the single decision
  // point (scalar null included: `isReadableTombstone(null)` is true, so an
  // active row is simply skipped). The cost is fetching one projected field
  // for every row that has `_deletedAt` at all — these collections are small.
  const candidates = await collection
    .find(
      { _deletedAt: { $exists: true } },
      { projection: { _deletedAt: 1 } },
    )
    .toArray();
  const broken = candidates.filter((d) => !isReadableTombstone(d._deletedAt));
  if (broken.length === 0) return 0;
  // CONDITIONAL on the observed value, per row — the same
  // observed-state rule every staging write follows. An `_id`-only filter is
  // a TOCTOU: an API restore or a snapshot replacement landing between the
  // read above and this write would have its fresh `null` (or valid date)
  // overwritten with epoch — the repair silently RE-DELETING a row the user
  // just restored. Filtered on the exact malformed value, a changed row
  // simply no-matches and the next cycle re-examines it.
  const res = await collection.bulkWrite(
    broken.map((d) => ({
      updateOne: {
        // `$eq`, not implicit equality: the observed value sits in
        // QUERY position, and raw-driver values are explicitly in scope — a
        // BSON regex placed there implicitly becomes a regex QUERY that never
        // matches the regex-valued row (the repair would repeat forever), and
        // an operator-shaped document would change the filter's meaning
        // entirely. `$eq` compares the observed value as a literal.
        filter: { _id: d._id, _deletedAt: { $eq: d._deletedAt } },
        update: { $set: { _deletedAt: new Date(0) } },
      },
    })),
  );
  return (res as { modifiedCount?: number })?.modifiedCount ?? 0;
}

/** The collections the sync engine copies — every one can carry a tombstone. */
export const TOMBSTONE_COLLECTIONS = [
  "nozzles",
  "bedtypes",
  "printers",
  "locations",
  "filaments",
  "printhistories",
  "sharedcatalogs",
] as const;

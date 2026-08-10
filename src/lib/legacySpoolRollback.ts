/**
 * Undoing a legacy single-spool migration safely (GH #1121).
 *
 * `POST /api/print-history` materializes a legacy roll — a filament with no
 * `spools[]` and a top-level `totalWeight` — into a real spool so the job can
 * debit it (see the route). The route is all-or-nothing, so when a LATER
 * target refuses, or the persist fails, the migrations it already applied
 * have to be undone.
 *
 * The naive inverse is wrong. Between migrating filament A and failing on
 * filament B the request holds no key on A, so another print job can debit
 * A's new spool and record its own history row in that window. An
 * unconditional `$pull` then deletes a spool in active use: that job's
 * inventory and `usageHistory` are erased and its `PrintHistory` row is left
 * orphaned — real data loss, caused by compensating for an unrelated failure.
 *
 * So the undo is CONDITIONAL. It matches only while the spool is still
 * exactly as the migration left it:
 *
 *   - the filament's `totalWeight` is still null (nobody re-set it),
 *   - the spool still exists with the untouched weight,
 *   - and its `usageHistory` is still empty (nothing has been logged on it).
 *
 * If anything intervened the row is LEFT ALONE. The asymmetry is deliberate:
 * a migrated-but-not-debited filament is a benign representation change that
 * the next job completes, while deleting a live spool is unrecoverable.
 *
 * Extracted here (rather than inlined in the route) so the filter is
 * coverage-gated — the route's own file has no unit-testable seam.
 */

/** A migration this request performed, and the exact state it replaced. */
export interface AppliedLegacyMigration {
  /** The filament that was migrated. */
  id: unknown;
  /** The `_id` of the spool the migration created. */
  spoolId: unknown;
  /** The top-level `totalWeight` the migration moved onto that spool. */
  totalWeight: number;
}

/**
 * The filter that matches ONLY an untouched migration. Empty `usageHistory`
 * is expressed as absent-or-zero-length: Mongoose materializes the array on
 * save, but a document written by another path (the driver, hybrid sync)
 * may legitimately omit it, and treating "absent" as "has entries" would
 * refuse to undo a migration nothing has touched.
 */
export function untouchedMigrationFilter(
  m: AppliedLegacyMigration,
): Record<string, unknown> {
  return {
    _id: m.id,
    totalWeight: null,
    spools: {
      $elemMatch: {
        _id: m.spoolId,
        totalWeight: m.totalWeight,
        $or: [{ usageHistory: { $exists: false } }, { usageHistory: { $size: 0 } }],
      },
    },
  };
}

/**
 * The exact inverse of the migration: restore the top-level weight, drop the
 * spool it created.
 *
 * `$inc: { __v: 1 }` mirrors the migration's own save. A hydrated document
 * loaded before this undo would otherwise still match its version filter and
 * re-materialize the removed spool on its next `save()` — the same reason
 * `completeParentPromotion` bumps the version key (GH #605).
 */
export function undoMigrationUpdate(
  m: AppliedLegacyMigration,
): Record<string, unknown> {
  return {
    $set: { totalWeight: m.totalWeight },
    $pull: { spools: { _id: m.spoolId } },
    $inc: { __v: 1 },
  };
}

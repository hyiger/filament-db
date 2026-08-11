/**
 * Re-tombstone "zombie" filaments — `_purged: true` while still ACTIVE
 * (`_deletedAt: null`). GH #1004 F1.
 *
 * The pre-#1004 CSV/XLSX importer could resurrect a purge tombstone without
 * clearing the flag. The row then renders in the app while hybrid sync treats
 * it as a one-way tombstone, and a later soft-delete vanishes it from the trash
 * entirely. `_purged` with a live `_deletedAt` is simply not a legal state.
 *
 * ## Why this is driver-level, and why hybrid sync runs it too (GH #1116)
 *
 * It used to be a Mongoose `updateMany` inside `dbConnect`'s migration block,
 * which repairs the LOCAL database only. That was survivable while a zombie was
 * merely cosmetic; the name-trim makes it load-bearing:
 *
 *   - a zombie is ACTIVE as far as MongoDB is concerned (`_deletedAt: null`),
 *     so it OCCUPIES the partial unique name index;
 *   - `SyncService.sync()` never calls `dbConnect`, so the REMOTE's zombies are
 *     never repaired — and `syncCollection`'s both-purged branch is explicitly
 *     a no-op, so nothing else repairs them either;
 *   - the trim pass deliberately does not let a hidden zombie GATE a sync (a
 *     user cannot resolve a row the UI does not show), so a local `"X "` is
 *     free to become `"X"` even while a remote zombie holds `"X"`.
 *
 * Put together: the local trim succeeds, and then every subsequent
 * `replaceOne` of that filament onto the remote fails E11000 against the
 * zombie's index entry — permanently, taking filaments and print-history sync
 * down with it via the dependency chain.
 *
 * Suppressing the gate was therefore only half an answer. The other half is to
 * make the zombie stop occupying the index, which is exactly what tombstoning
 * it does — and it is the state the row should have been in all along, so this
 * repairs rather than destroys.
 *
 * Idempotent: once `_deletedAt` is set the filter matches nothing.
 */

/**
 * The minimal surface this needs: one collection that can `updateMany`.
 *
 * Taking the COLLECTION rather than a `db` handle is deliberate. It is less
 * indirection (this only ever touches `filaments`), and it lets each caller
 * pass whatever it already holds — `Filament.collection` from `dbConnect`, or
 * `db.collection("filaments")` from the Electron sync service, which has no
 * Mongoose connection to the remote peer at all.
 */
export interface MinimalZombieCollection {
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount?: number } | unknown>;
}

/**
 * Give every active-but-purged filament the tombstone date it should have had.
 *
 * Returns how many rows were repaired, for logging. `filaments` is the only
 * collection with a `_purged` concept (see `trimEntityNames`'s `honorsPurged`),
 * which is why the caller passes that one collection.
 */
export async function retombstonePurgedZombies(
  filaments: MinimalZombieCollection,
  now: Date = new Date(),
): Promise<number> {
  const res = await filaments.updateMany(
    { _purged: true, _deletedAt: null },
    { $set: { _deletedAt: now } },
  );
  return (res as { modifiedCount?: number })?.modifiedCount ?? 0;
}

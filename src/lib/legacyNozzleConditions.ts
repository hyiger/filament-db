/**
 * GH #1021 (#1022) — one-shot, per-DATABASE cleanup of the
 * machine-derived `nozzle_diameter[0]==D [or ...]` compatibility conditions the
 * pre-#1021 export wrote into `settings.compatible_printers_condition` (and
 * round-trips persisted). After the cleanup, any pure nozzle-only condition in
 * a settings bag is user-authored by construction, so the export passes every
 * pin through untouched — an export-time purge cannot distinguish the two.
 *
 * Design constraints this shape answers (each a Codex P1 round):
 *  - NOT safe to re-run: a pin authored after the cleanup is textually
 *    identical to the legacy values, so completion must be durable per DB —
 *    a marker document in `_migrations` — not a process-local flag.
 *  - CLAIM-FIRST: the marker is inserted (unique `_id`) BEFORE the destructive
 *    updateMany, so two processes racing the first boot serialize on the
 *    insert — the loser skips entirely and can never erase a pin the winner's
 *    era accepted. On a transient clear failure the claim is released
 *    (best-effort delete) so the next connect retries; a crash mid-clear
 *    leaves the claim held and the remaining legacy values untouched (the
 *    known pre-fix hidden-preset state, recoverable by hand) — strictly safer
 *    than any re-run that could eat a post-upgrade user pin.
 *  - HYBRID: the Electron sync engine opens Atlas directly (no dbConnect), and
 *    the raw update preserves `updatedAt`, so LWW would never propagate the
 *    local cleanup — each side must clean its own DB. This helper is
 *    driver-level (takes a `Db`) precisely so `dbConnect` (whatever URI the
 *    app runs against) AND `electron/sync-service.ts` (the remote side) share
 *    one implementation.
 */

/** The exact machine grammar the pre-#1021 export produced — one or more
 * `nozzle_diameter[0]==<number>` terms joined by ` or `, nothing else. */
export const LEGACY_NOZZLE_CONDITION_RE =
  /^nozzle_diameter\[0\]==\d+(\.\d+)?( or nozzle_diameter\[0\]==\d+(\.\d+)?)*$/;

const MARKER_ID = "legacyNozzleConditions";

/** Minimal driver surface (mongodb Db / collection) so the helper works with
 * both mongoose's `connection.db` and the sync service's raw MongoClient. */
export interface MinimalDb {
  collection(name: string): {
    findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    insertOne(doc: Record<string, unknown>): Promise<unknown>;
    updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<unknown>;
    updateMany(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<{ modifiedCount: number }>;
    deleteOne(filter: Record<string, unknown>): Promise<unknown>;
  };
}

// Private twin of mongodb.ts's isDuplicateKeyError — importing it would cycle
// (mongodb.ts imports this module) and pull mongoose into the Electron sync
// bundle; this helper must stay bare-driver.
function isDuplicateKey(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === 11000) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /E11000|duplicate key/i.test(message);
}

export type LegacyNozzleCleanupResult =
  | { ran: true; cleared: number }
  | { ran: false; reason: "already-done" | "claimed-elsewhere" };

/**
 * Run the one-shot cleanup against `db` exactly once per database.
 * Throws on transient failures (after releasing the claim) so callers can
 * retry on the next connect; returns how it resolved otherwise.
 */
export async function clearLegacyNozzleConditionsOnce(
  db: MinimalDb,
): Promise<LegacyNozzleCleanupResult> {
  const markers = db.collection("_migrations");

  const existing = await markers.findOne({ _id: MARKER_ID });
  if (existing) {
    // Completed, or claimed by another process/crashed claimer. Either way we
    // must NOT run: re-running risks erasing a post-cleanup user pin, which is
    // strictly worse than leaving residual legacy values hidden (see header).
    return { ran: false, reason: existing.completed === true ? "already-done" : "claimed-elsewhere" };
  }

  // CLAIM before mutating anything — the unique _id serializes racers.
  try {
    await markers.insertOne({ _id: MARKER_ID, claimedAt: new Date() });
  } catch (err) {
    if (isDuplicateKey(err)) return { ran: false, reason: "claimed-elsewhere" };
    throw err;
  }

  let cleared: number;
  try {
    const res = await db
      .collection("filaments")
      .updateMany(
        { "settings.compatible_printers_condition": { $regex: LEGACY_NOZZLE_CONDITION_RE } },
        { $set: { "settings.compatible_printers_condition": "" } },
      );
    cleared = res.modifiedCount;
  } catch (err) {
    // Release the claim (best-effort) so the next connect can retry; if this
    // delete also fails the claim stays held and the cleanup stays skipped —
    // logged by the caller, recoverable by deleting the marker by hand.
    await markers.deleteOne({ _id: MARKER_ID }).catch(() => {});
    throw err;
  }

  await markers.updateOne({ _id: MARKER_ID }, { $set: { completed: true, completedAt: new Date() } });
  return { ran: true, cleared };
}

/**
 * GH #605 — keyed async mutex for filament-family critical sections.
 *
 * The template model's guards are check-then-act (hasVariants →
 * promote/strip/push), and standalone mongod offers no transactions, so two
 * overlapping requests on the same filament family could each pass a check
 * against pre-write state (a spool landing on a just-promoted template, two
 * /promote calls both minting a promotion copy, a totalWeight PUT slipping
 * past the template strip mid-promotion). This module serializes those
 * sections per filament id: `runExclusive(key, fn)` chains fn behind
 * whatever holds `key`, so on any one key sections run strictly one at a
 * time; independent keys never wait on each other.
 *
 * PROCESS-LOCAL, by design. The app is a single-process Next.js server
 * (standalone / Electron-embedded — no serverless, no replicas), so a
 * module-level singleton map IS the whole coordination domain. The
 * compensating guards the routes already carry (spoolTemplateGuard's
 * re-check + $pull, the /promote nothing_to_convert re-derivation) stay in
 * place as defense-in-depth for anything outside the process (a second
 * deployment sharing the DB, direct DB writes).
 *
 * Chains never leak: each key's tail entry is deleted as soon as the last
 * queued section settles, and a rejection releases the key exactly like a
 * resolution does (the error still propagates to that caller alone — the
 * chain itself is built from settlement, not success).
 */

/** Per-key chain tails. A tail promise NEVER rejects (rejections are
 *  reflected to the caller via the returned promise, not the chain), so a
 *  thrown section can't poison the queue behind it. */
const tails = new Map<string, Promise<void>>();

/**
 * Run `fn` exclusively for `key`: it starts only after every section
 * previously queued on the same key has settled (resolved OR rejected), and
 * the next section on the key waits for this one the same way. Returns
 * `fn`'s own result/rejection unchanged.
 */
export function runExclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // The caller's view: settles exactly as fn settles.
  const result = prev.then(fn);
  // The chain's view: settlement only — a rejection must release the key
  // for the next waiter, not reject it.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  // Drain cleanup: once this tail settles, drop the map entry — unless a
  // later runExclusive already replaced it (then that call owns cleanup).
  void tail.then(() => {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  });
  return result;
}

/** Number of keys currently holding a chain — 0 when fully drained.
 *  Test-inspection helper: pins the no-leak contract. */
export function lockedKeyCount(): number {
  return tails.size;
}

/**
 * Canonical lock key for a filament id. MongoDB treats hex ObjectIds
 * case-insensitively (`isValidObjectId` accepts uppercase and the cast
 * matches the same document), but Map keys are byte-exact — a request
 * addressing `507F1F…` would otherwise serialize on a DIFFERENT key than
 * the `String(doc._id)` (lowercase) the create path uses, silently
 * bypassing the mutex for the same family. Non-ObjectId strings pass
 * through unchanged (they lock a key no document write shares, harmless).
 */
export function filamentLockKey(id: unknown): string {
  const s = String(id);
  return /^[0-9a-fA-F]{24}$/.test(s) ? s.toLowerCase() : s;
}

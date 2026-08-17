/**
 * "Did a sync cycle just end?" — the rule the Data health page uses to decide
 * when to refetch its own local scan (GH #1164).
 *
 * Why this is a module and not four `let`s inside the effect: the page has no
 * test harness in this repo, and the rule has now been wrong three separate
 * ways — each time in a direction that left the actionable conflict list
 * silently stale, which is the one failure mode the page exists to prevent.
 * Pure and coverage-gated here, the way `ntagPages.ts` and `ntagVersion.ts`
 * carry the arithmetic that `electron/` cannot test.
 *
 * The page's local scan is a mount-time snapshot, and a COMPLETED cycle can
 * copy a remote-only conflict INTO the local database — after which the pair
 * belongs in the actionable list, not the read-only remote section whose copy
 * says "resolve it above". So every ending has to trigger a refetch.
 */
export interface SyncCycleSample {
  lastSyncAt?: string | null;
  state?: string;
}

export interface SyncCycleWatcher {
  /**
   * The mount snapshot (the resolved `getSyncStatus()` promise). It only
   * establishes the baseline, and only when no live event has already done so:
   * the promise can resolve AFTER an event and carry older values, which would
   * rewind the baseline and cause a redundant refetch on the next event.
   */
  seed(sample: SyncCycleSample): void;
  /** A live status event. Returns true when a cycle just ended. */
  observe(sample: SyncCycleSample): boolean;
}

export function createSyncCycleWatcher(): SyncCycleWatcher {
  // A SEPARATE flag, not `lastSeenSync === null`: null is a legitimate stamp
  // — the app mounts mid-initial-sync, or after connection failures, with
  // `lastSyncAt` still null — and conflating "unset" with "null" made the
  // first REAL completion look like the mount snapshot, so its refetch was
  // skipped.
  let seenInitial = false;
  let lastSeenSync: string | null = null;
  let wasSyncing = false;

  const read = (sample: SyncCycleSample) => ({
    stamp: sample.lastSyncAt ?? null,
    syncing: sample.state === "syncing",
  });

  return {
    seed(sample) {
      if (seenInitial) return;
      const { stamp, syncing } = read(sample);
      seenInitial = true;
      lastSeenSync = stamp;
      wasSyncing = syncing;
    },

    observe(sample) {
      const { stamp, syncing } = read(sample);
      // A live event is by definition post-mount, even one that beats the
      // snapshot promise. Letting such an event claim the baseline swallowed
      // the very completion the refetch exists for: the page's own fetch had
      // already returned, and the snapshot resolving afterwards carried the
      // same terminal stamp, so nothing ever triggered a reload. With no
      // baseline yet, any non-syncing event IS a cycle that ended.
      //
      // Otherwise: a cycle ended if the stamp advanced OR we left the syncing
      // state. The second clause is what covers a FAILED cycle — the terminal
      // error status keeps the previous `lastSyncAt`, yet earlier collections
      // in that cycle may already have copied a remote conflict across, so a
      // stamp-only rule stayed stale until some later success.
      //
      // Progress ticks during a cycle carry the same stamp and are still
      // syncing, so they report false and this cannot loop.
      const ended = seenInitial
        ? stamp !== lastSeenSync || (wasSyncing && !syncing)
        : !syncing;
      seenInitial = true;
      lastSeenSync = stamp;
      wasSyncing = syncing;
      return ended;
    },
  };
}

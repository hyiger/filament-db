import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, type Api } from './api';

/**
 * Offline write queue (mobile Phase 3).
 *
 * Spool edits (move location, set remaining weight, retire, log usage / dry
 * cycle) are mutations. When the server is unreachable, instead of failing the
 * edit we persist it here and replay it FIFO once the server is reachable
 * again — so a scan-and-update on a flaky shop network isn't lost.
 *
 * Design:
 *   - Only IDEMPOTENT ops are queued — currently `updateSpool` (remaining
 *     weight / location / retire), which are absolute SETs, so replaying one is
 *     a no-op. logUsage / logDryCycle DECREMENT / APPEND, so replaying them
 *     after a committed-but-lost response (e.g. a slow LAN past the 15s
 *     request timeout) would double-apply — they therefore require live
 *     connectivity and are never queued (Codex review). Offline support for
 *     them would need a server-side idempotency key; deferred.
 *   - Network failures (ApiError status 0 — see api.ts) queue a queueable op.
 *     A real server rejection (4xx/5xx) is NOT queued: it would never succeed,
 *     so it surfaces to the user immediately (submitWrite) or is dropped on
 *     flush.
 *   - flushQueue CLAIMS the head (removes it) before the network call so a
 *     concurrent enqueue at the cap can't evict the in-flight entry; the head
 *     is restored at the front if the server is still unreachable.
 *   - All queue reads/writes funnel through a tiny async mutex so a flush and
 *     an enqueue can't interleave their load→save and clobber each other.
 *   - Persisted in AsyncStorage (NOT SecureStore — it's not a credential, and
 *     SecureStore caps values at ~2KB on Android, too small for a queue).
 */

const QUEUE_KEY = 'filamentdb.writeQueue.v1';
// Bound the queue so a phone left offline indefinitely can't grow it without
// limit. Oldest entries are dropped first if the cap is exceeded.
const MAX_QUEUE = 200;

export type WriteOp =
  | { kind: 'updateSpool'; patch: Record<string, unknown> }
  | { kind: 'logUsage'; grams: number; jobLabel?: string }
  | { kind: 'logDryCycle'; cycle: { tempC?: number; durationMin?: number; notes?: string } };

export interface QueuedWrite {
  id: string;
  createdAt: number;
  filamentId: string;
  spoolId: string;
  /** Human-readable summary for the pending-writes UI. */
  label: string;
  write: WriteOp;
}

// ── async mutex: serialize all load→modify→save sequences ──────────────────
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  // Keep the chain alive even if `fn` rejects, but don't leak the rejection.
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let seq = 0;
function nextId(): string {
  // Date.now() is fine in RN (the no-Date rule is workflow-script-only); the
  // seq counter disambiguates writes enqueued within the same millisecond.
  return `${Date.now()}-${seq++}`;
}

async function readQueue(): Promise<QueuedWrite[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedWrite[]) : [];
  } catch {
    return [];
  }
}

async function writeQueueRaw(list: QueuedWrite[]): Promise<void> {
  if (list.length === 0) await AsyncStorage.removeItem(QUEUE_KEY);
  else await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(list));
}

// ── change subscription so the UI can show a live pending count ────────────
type Listener = (count: number) => void;
const listeners = new Set<Listener>();
function notify(count: number): void {
  for (const l of listeners) l(count);
}
export function subscribePending(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function pendingCount(): Promise<number> {
  return withLock(async () => (await readQueue()).length);
}

/**
 * Drop all queued writes. Called when the configured server changes — queued
 * edits were made against the previous server and must NOT replay to a
 * different Filament DB instance (wrong spools / 404s). Codex P2 on #709.
 */
export async function clearQueue(): Promise<void> {
  await withLock(async () => {
    await writeQueueRaw([]);
    notify(0);
  });
}

/** Dispatch one queued write to the matching API call. */
export function applyWrite(api: Api, q: QueuedWrite): Promise<unknown> {
  switch (q.write.kind) {
    case 'updateSpool':
      return api.updateSpool(q.filamentId, q.spoolId, q.write.patch);
    case 'logUsage':
      return api.logUsage(q.filamentId, q.spoolId, q.write.grams, q.write.jobLabel);
    case 'logDryCycle':
      return api.logDryCycle(q.filamentId, q.spoolId, q.write.cycle);
  }
}

// True for the duration of a flushQueue run. Read by enqueue's cap-trim so it
// never evicts the in-flight head (index 0) that a flush is mid-request on.
let flushing = false;

async function enqueue(entry: Omit<QueuedWrite, 'id' | 'createdAt'>): Promise<void> {
  await withLock(async () => {
    const list = await readQueue();
    list.push({ ...entry, id: nextId(), createdAt: Date.now() });
    // Drop the oldest over the cap — but never index 0 while a flush is in
    // flight (that entry is mid-request; removing it would lose it). Drop the
    // next-oldest instead in that window.
    while (list.length > MAX_QUEUE) {
      list.splice(flushing && list.length > 1 ? 1 : 0, 1);
    }
    await writeQueueRaw(list);
    notify(list.length);
  });
}

export interface SubmitResult {
  /** true when the write was queued because the server was unreachable. */
  queued: boolean;
  /** The server's response when it went through synchronously. */
  result?: unknown;
}

/**
 * Whether an op is safe to queue + replay. Only idempotent ops qualify:
 * replaying an `updateSpool` (absolute SET) is a no-op, but logUsage /
 * logDryCycle decrement / append and would double-apply if a committed write's
 * response was lost (Codex review). Non-queueable ops require live connectivity.
 */
function isQueueable(write: WriteOp): boolean {
  return write.kind === 'updateSpool';
}

/**
 * Perform a write, queueing it if the server is unreachable AND the op is
 * idempotent (safe to replay). A real server error (4xx/5xx) — or a network
 * failure on a non-idempotent op (usage / dry cycle) — is re-thrown so the
 * caller surfaces it: queueing a request the server rejected would fail
 * forever, and replaying a decrement/append could double-apply.
 */
export async function submitWrite(
  api: Api,
  entry: Omit<QueuedWrite, 'id' | 'createdAt'>,
): Promise<SubmitResult> {
  // FIFO ordering: while any write is already pending, a live write would let
  // an OLDER queued write replay on top of it on the next flush (Codex P1/P2,
  // e.g. queued remaining=100 then a live remaining=50, or a queued SET that
  // replays over a live usage decrement).
  if ((await pendingCount()) > 0) {
    // First try to drain — the server may be reachable now even though no
    // mount/focus/foreground flush has fired, so we shouldn't enqueue/block
    // unnecessarily and leave the user stuck (Codex P2). A concurrent flush
    // (the guard) no-ops here; we then re-check below.
    await flushQueue(api).catch(() => {});
  }
  if ((await pendingCount()) > 0) {
    if (isQueueable(entry.write)) {
      // Idempotent — enqueue it to drain in order behind the pending writes.
      await enqueue(entry);
      return { queued: true };
    }
    // Non-idempotent (usage / dry cycle) can't be queued safely, so it must
    // wait for the queue to drain rather than apply out of order.
    throw new Error(
      'You have unsynced offline changes. Let them sync first, then log usage or a dry cycle.',
    );
  }
  try {
    const result = await applyWrite(api, { ...entry, id: 'live', createdAt: 0 });
    return { queued: false, result };
  } catch (e) {
    if (e instanceof ApiError && e.status === 0 && isQueueable(entry.write)) {
      await enqueue(entry);
      return { queued: true };
    }
    throw e;
  }
}

export interface FlushResult {
  flushed: number;
  dropped: number;
  remaining: number;
}

/**
 * Whether an error status is transient/recoverable (keep the queued write and
 * retry later) vs a permanent rejection of the request (drop it, else it wedges
 * the FIFO queue). Auth (401/403) is transient — the user can fix a stale API
 * key and the edit must survive until then (Codex P1). Network (0), timeout
 * (408), rate-limit (429) and server errors (5xx) are transient too. Other 4xx
 * (400/404/409/410/422…) mean the request is bad/gone — drop.
 */
function isTransient(status: number): boolean {
  return (
    status === 0 ||
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

/**
 * Replay queued writes FIFO. The head is PEEKED, not removed, before its
 * network call: if the app is killed mid-request the entry survives in storage
 * and is retried next flush (safe because only idempotent ops are queued — a
 * lost-but-committed response just re-applies harmlessly; Codex P2). enqueue's
 * cap-trim skips the in-flight head so a concurrent enqueue can't evict it. A
 * transient error (network / auth / server) stops the flush and KEEPS the head;
 * a permanent client error drops it so it can't wedge the queue. Concurrent
 * calls are a no-op.
 */
export async function flushQueue(api: Api): Promise<FlushResult> {
  if (flushing) return { flushed: 0, dropped: 0, remaining: await pendingCount() };
  flushing = true;
  let flushed = 0;
  let dropped = 0;
  // Remove a processed entry by id; returns false if it was no longer present.
  const removeById = (id: string): Promise<boolean> =>
    withLock(async () => {
      const list = await readQueue();
      const idx = list.findIndex((e) => e.id === id);
      if (idx < 0) return false;
      list.splice(idx, 1);
      await writeQueueRaw(list);
      notify(list.length);
      return true;
    });
  try {
    for (;;) {
      // Peek the head WITHOUT removing it — durability across a crash/kill.
      const head = await withLock(async () => (await readQueue())[0] ?? null);
      if (!head) break;
      try {
        await applyWrite(api, head);
        flushed++;
      } catch (e) {
        if (e instanceof ApiError && isTransient(e.status)) break; // keep it, stop
        dropped++; // permanent rejection — fall through and remove
      }
      // Remove the processed head. If it's already gone, the queue was cleared
      // under us (a server change called clearQueue) and may now hold entries
      // for a DIFFERENT server — stop rather than replay them via this now-stale
      // api (Codex P2).
      if (!(await removeById(head.id))) break;
    }
  } finally {
    flushing = false;
  }
  return { flushed, dropped, remaining: await pendingCount() };
}

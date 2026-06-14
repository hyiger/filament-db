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

async function enqueue(entry: Omit<QueuedWrite, 'id' | 'createdAt'>): Promise<void> {
  await withLock(async () => {
    const list = await readQueue();
    list.push({ ...entry, id: nextId(), createdAt: Date.now() });
    // Drop the oldest if over the cap.
    while (list.length > MAX_QUEUE) list.shift();
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

let flushing = false;

/**
 * Replay queued writes FIFO. Stops at the first network failure (still
 * offline); drops a write the server rejects (4xx/5xx — it would never
 * succeed). Safe to call repeatedly; a concurrent call is a no-op. Only
 * idempotent ops are ever in the queue (see submitWrite), so the at-least-once
 * replay that a lost-but-committed response causes is harmless.
 */
export async function flushQueue(api: Api): Promise<FlushResult> {
  if (flushing) return { flushed: 0, dropped: 0, remaining: await pendingCount() };
  flushing = true;
  let flushed = 0;
  let dropped = 0;
  try {
    for (;;) {
      // CLAIM the head — remove it under lock BEFORE the network call — so a
      // concurrent enqueue at the cap can't evict the in-flight entry from the
      // front and silently lose it (Codex P3). It's restored below if the
      // server is still unreachable.
      const head = await withLock(async () => {
        const list = await readQueue();
        const h = list.shift();
        if (h) {
          await writeQueueRaw(list);
          notify(list.length);
        }
        return h ?? null;
      });
      if (!head) break;
      try {
        await applyWrite(api, head);
        flushed++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) {
          // Still offline — put the claimed head back at the front and stop.
          // If concurrent enqueues filled the queue while it was in flight,
          // trim from the NEWEST end so the restored (oldest) head survives.
          await withLock(async () => {
            const list = await readQueue();
            list.unshift(head);
            while (list.length > MAX_QUEUE) list.pop();
            await writeQueueRaw(list);
            notify(list.length);
          });
          break;
        }
        dropped++; // server rejected it (already removed) — drop so it can't wedge the queue
      }
    }
  } finally {
    flushing = false;
  }
  return { flushed, dropped, remaining: await pendingCount() };
}

/**
 * GH #808 — retry helper for the shared MongoMemoryServer startup.
 *
 * mongodb-memory-server picks a random port; if that port is already held by
 * another local process (Steam, another dev server, a prior test run not yet
 * reaped), it throws `StdoutInstanceError: Port "57343" already in use` and the
 * WHOLE vitest run fails before a single suite executes — a flaky, unrelated
 * red build. Retrying with a fresh server picks a new random port.
 *
 * Dependency-injected (`create` is passed in) so it's unit-testable without
 * spawning real mongod. Lives in tests/ (not src/lib) since it's test infra and
 * isn't subject to the src coverage thresholds.
 */

/** Is this a "the port I randomly picked is taken" error — i.e. retryable by
 *  just trying a fresh port? Matches mongodb-memory-server's
 *  `StdoutInstanceError` message and the raw EADDRINUSE shape. Genuine startup
 *  failures (missing binary, launch timeout) do NOT match, so they surface. */
export function isPortInUseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/already in use/i.test(msg) || /EADDRINUSE/i.test(msg)) return true;
  return (err as { code?: string } | null)?.code === "EADDRINUSE";
}

export interface StartWithRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  /** Called before each retry (not before the first attempt, not after the
   *  final failure) — used to warn() so CI shows the flake happened. */
  onRetry?: (attempt: number, err: unknown) => void;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `create()`, retrying only on a port-collision error with a fresh call
 * each time, up to `maxAttempts`. Non-retryable errors throw immediately; the
 * last attempt's error propagates so a genuine failure stays visible.
 */
export async function startWithRetry<T>(
  create: () => Promise<T>,
  opts: StartWithRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const delayMs = opts.delayMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await create();
    } catch (err) {
      lastErr = err;
      if (!isPortInUseError(err) || attempt === maxAttempts) throw err;
      opts.onRetry?.(attempt, err);
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the compiler.
  throw lastErr;
}

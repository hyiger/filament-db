import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { beforeAll, afterAll, afterEach } from "vitest";
import { startWithRetry } from "./mongoRetry";

// Allow a generous startup budget — Windows CI runners have been observed
// downloading/extracting the mongodb binary and failing the default 10s
// timeout. Tests that don't need MongoDB still run, but this avoids the
// whole suite collapsing on a cold cache.
const MONGO_START_TIMEOUT_MS = 120_000;

// Per-instance launch timeout for `MongoMemoryServer.create()` — the
// mongodb-memory-server-core internal default is 10 seconds and that's
// not enough on the Windows-arm64 release runner, which executes the
// suite under x64 emulation. v1.27.0 shipped without Windows-arm64
// assets because both the initial build and the re-run hit
// `GenericMMSError: Instance failed to start within 10000ms` on the
// first `MongoMemoryServer.create()`. Two consecutive failures is the
// "becoming a pattern" trigger CLAUDE.md's release-process gotcha
// section already calls out — bumping the start timeout is the
// recommended durable fix. 60s gives the emulated runner ~6× the
// headroom of the default; faster runners (mac/linux native) only
// spend their typical ~1–2s and remain unaffected.
const MONGO_INSTANCE_LAUNCH_TIMEOUT_MS = 60_000;

let mongoServer: MongoMemoryServer | null = null;

beforeAll(async () => {
  // GH #808: mongodb-memory-server picks a random port; if it collides with
  // another local process it throws "Port … already in use" and fails the
  // ENTIRE run before any suite executes. Retry with a fresh server (new random
  // port) on that specific error only — genuine startup failures still surface.
  // Port collisions fail fast, so a handful of retries fit inside the budget.
  mongoServer = await startWithRetry(
    () =>
      MongoMemoryServer.create({
        instance: { launchTimeout: MONGO_INSTANCE_LAUNCH_TIMEOUT_MS },
      }),
    {
      maxAttempts: 5,
      delayMs: 250,
      onRetry: (attempt, err) =>
        console.warn(
          `[tests/setup] MongoMemoryServer port collision (attempt ${attempt}/5); retrying with a fresh port: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
    },
  );
  const uri = mongoServer.getUri();
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
}, MONGO_START_TIMEOUT_MS);

afterEach(async () => {
  if (mongoose.connection.readyState !== 1) return;
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].drop().catch(() => {});
  }
  // Clear cached models so schemas are fresh each test
  for (const modelName of Object.keys(mongoose.models)) {
    delete mongoose.models[modelName];
  }
});

// Bump the hook timeout — vitest's default of 10s isn't enough for the
// disconnect + mongod stop pipeline on slow / first-run machines.
//
// GH #186 + GH #399: mongodb-memory-server's stop() default sends
// SIGINT to mongod and waits ~10s before falling back to SIGKILL — but
// vitest's worker-level SIGINT→SIGKILL grace is shorter, so vitest
// force-kills the worker (with a noisy SIGKILL warning) before mongod
// has a chance to exit cleanly.
//
// Codex P2 on PR #479 r3: `stop({ force: true })` does NOT shorten
// the kill phase. In mongodb-memory-server-core@11.0.1, `force` is
// only consumed by `cleanup()` to allow removing non-temp data dirs;
// `_instanceInfo.instance.stop()` (which actually kills mongod) still
// runs the full SIGINT→wait→SIGKILL dance via the upstream
// `killProcess` helper.
//
// Real fix: SIGKILL the mongod child process directly via
// `process.kill(pid, 'SIGKILL')` BEFORE calling `mongoServer.stop()`.
// `stop()` then races a 1ms-ish wait for the already-dead child to be
// reaped and proceeds straight to cleanup() — per-worker teardown
// completes in well under 1s. The data directory is a temp dir and
// mongodb-memory-server-core registers a `process.on('exit')` hook
// that wipes it regardless of how we got there, so no orphaned state.
const TEARDOWN_TIMEOUT_MS = 30_000;

/** Reach into mongodb-memory-server's internals to find the mongod
 *  child pid. The field is `mongodProcess` on the MongoInstance — the
 *  short-lived `childProcess` alias was removed in
 *  mongodb-memory-server-core@11.0.0 (Codex P2 on PR #479 r4 caught
 *  the silent no-op from looking up the old name). The shape is
 *  intentionally narrowed; if upstream renames the field again, the
 *  optional chain short-circuits to undefined and the teardown falls
 *  back to the slow stop() path rather than throwing. */
function getMongodPid(server: MongoMemoryServer): number | undefined {
  type Reach = {
    instanceInfo?: { instance?: { mongodProcess?: { pid?: number } } };
  };
  return (server as unknown as Reach).instanceInfo?.instance?.mongodProcess?.pid;
}

afterAll(async () => {
  // Guard each step — if beforeAll failed, mongoServer may be null and
  // mongoose may not be connected. A throwing teardown would mask the real
  // startup error (e.g. "Cannot read properties of undefined (reading 'stop')").
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch {
    // ignore
  }
  if (mongoServer) {
    // GH #399 (Codex P2 PR #479 r3): kill mongod BEFORE calling stop()
    // so the stop()'s internal `killProcess` doesn't sit in its 10s
    // SIGINT wait. The kill is best-effort — if it fails or the child
    // is already gone, stop() handles cleanup as usual.
    const pid = getMongodPid(mongoServer);
    if (pid != null) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // child already exited, or we don't own it — let stop() decide.
      }
    }
    await mongoServer.stop({ doCleanup: true, force: true }).catch(() => {});
  }
}, TEARDOWN_TIMEOUT_MS);

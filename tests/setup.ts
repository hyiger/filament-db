import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { beforeAll, afterAll, afterEach } from "vitest";

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
  mongoServer = await MongoMemoryServer.create({
    instance: { launchTimeout: MONGO_INSTANCE_LAUNCH_TIMEOUT_MS },
  });
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
// GH #186 + GH #399: mongodb-memory-server's stop() default sends
// SIGINT to mongod and waits ~10s before falling back to SIGKILL — but
// vitest's worker-level SIGINT→SIGKILL grace is shorter than that, so
// vitest force-kills the worker (with a noisy SIGKILL warning) before
// mongod even gets the chance to exit cleanly. `force: true` below
// skips mongod's SIGINT phase entirely and goes straight to SIGKILL,
// so the per-worker teardown completes in <1s and vitest sees a clean
// exit — eliminating both the warning noise AND the apparent "stalled"
// progress while workers wait to die.
const TEARDOWN_TIMEOUT_MS = 30_000;

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
    // GH #399: `force: true` skips the SIGINT-then-wait dance and
    // SIGKILLs mongod immediately. Safe here because the in-memory
    // mongod has no persistent state to lose — its data directory is
    // a temp dir that gets cleaned up next.
    await mongoServer.stop({ force: true, doCleanup: true }).catch(() => {});
  }
}, TEARDOWN_TIMEOUT_MS);

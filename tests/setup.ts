import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { beforeAll, afterAll, afterEach } from "vitest";

// Allow a generous startup budget — Windows CI runners have been observed
// downloading/extracting the mongodb binary and failing the default 10s
// timeout. Tests that don't need MongoDB still run, but this avoids the
// whole suite collapsing on a cold cache.
const MONGO_START_TIMEOUT_MS = 120_000;

let mongoServer: MongoMemoryServer | null = null;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
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
// mongodb-memory-server's stop() sends SIGINT to mongod, waits 10s, then
// falls back to SIGKILL (the warning is hardcoded inside
// node_modules/mongodb-memory-server-core/.../utils.js). Worst case the
// teardown takes ~20s (10s SIGINT wait + the kill+exit roundtrip), so
// 30s gives the test suite enough headroom to exit cleanly even when
// mongod refuses the soft signal (GH #186).
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
    await mongoServer.stop().catch(() => {});
  }
}, TEARDOWN_TIMEOUT_MS);

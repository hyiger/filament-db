import { MongoMemoryServer } from "mongodb-memory-server-core";
import path from "path";
import { app } from "electron";
import fs from "fs";

let mongod: MongoMemoryServer | null = null;
let uri: string | null = null;
/** In-flight start, so concurrent callers share one create() (#681). */
let starting: Promise<string> | null = null;

/**
 * Start an embedded local MongoDB instance.
 * Data is persisted under the app's userData directory.
 */
export async function startLocalMongo(): Promise<string> {
  if (mongod && uri) return uri;
  // #681: `mongod` is only assigned AFTER MongoMemoryServer.create() resolves,
  // so two overlapping callers (e.g. a hybrid resolveMongoUri racing the
  // atlas-fallback path) would both pass the guard above and each spawn a
  // mongod → port conflict + orphaned server. Share one in-flight start.
  if (starting) return starting;
  starting = doStartLocalMongo();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function doStartLocalMongo(): Promise<string> {
  const dbPath = path.join(app.getPath("userData"), "mongodb-data");
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }

  // MongoDB ships no native Windows arm64 build — only x86_64. Without this
  // override, mongodb-memory-server derives the arch from os.arch() ("arm64"
  // → "aarch64") and tries to download a nonexistent
  // mongodb-windows-aarch64-*.zip. Windows on ARM runs the x64 binary fine
  // under emulation, so pin the download to x86_64. (GH #240)
  const binary =
    process.platform === "win32" && process.arch === "arm64"
      ? { arch: "x86_64" }
      : undefined;

  mongod = await MongoMemoryServer.create({
    binary,
    instance: {
      dbPath,
      storageEngine: "wiredTiger",
      launchTimeout: 60000,
      // GH #318: pin the bind address to loopback explicitly. The
      // embedded database is unauthenticated; relying on the library's
      // default bind would silently expose it to the LAN if a future
      // mongodb-memory-server release changed that default.
      ip: "127.0.0.1",
    },
  });

  // GH #435: if anything in the URI-parse / db-name-append block
  // throws (malformed URI is the obvious case), the catch must roll
  // back the partially-initialised state. Without rollback `mongod`
  // stays set with `uri` still null — the next startLocalMongo()
  // call's `if (mongod && uri) return uri` guard is false (uri is
  // null), so it re-enters `MongoMemoryServer.create()` while the
  // previous instance is still running → port conflict + orphaned
  // mongod.
  try {
    let rawUri = mongod.getUri();
    const url = new URL(rawUri);
    url.pathname = "/filament-db";
    rawUri = url.toString();
    uri = rawUri;
  } catch (err) {
    await mongod.stop().catch(() => {});
    mongod = null;
    uri = null;
    throw err;
  }

  console.log("Local MongoDB started:", uri);
  return uri;
}

/**
 * Stop the embedded MongoDB instance.
 */
export async function stopLocalMongo(): Promise<void> {
  if (mongod) {
    await mongod.stop();
    mongod = null;
    uri = null;
    console.log("Local MongoDB stopped");
  }
}

/**
 * Get the current local MongoDB URI, or null if not running.
 */
export function getLocalMongoUri(): string | null {
  return uri;
}

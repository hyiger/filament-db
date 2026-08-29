import { MongoMemoryServer } from "mongodb-memory-server-core";
import path from "path";
import { app } from "electron";
import fs from "fs";

let mongod: MongoMemoryServer | null = null;
let uri: string | null = null;
/** In-flight start, so concurrent callers share one create() (#681). */
let starting: Promise<string> | null = null;
/**
 * #914: set by stopLocalMongo() so an in-flight MongoMemoryServer.create()
 * that resolves AFTER shutdown began self-stops (see doStartLocalMongo /
 * stopLocalMongo). Reset on a fresh start.
 */
let shuttingDown = false;

/**
 * Start an embedded local MongoDB instance.
 * Data is persisted under the app's userData directory.
 */
export async function startLocalMongo(): Promise<string> {
  if (mongod && uri) return uri;
  shuttingDown = false; // a fresh start supersedes any prior shutdown intent
  // #681: `mongod` is only assigned AFTER create() resolves, so two
  // overlapping callers would both pass the guard above and each spawn a
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

  // #914: shutdown may have begun while create() was in flight. Stop the
  // just-created server so it doesn't linger holding the dbPath lock, and
  // throw so callers see the start didn't complete.
  if (shuttingDown) {
    await mongod.stop().catch(() => {});
    mongod = null;
    uri = null;
    throw new Error("Local MongoDB start aborted — app is shutting down");
  }

  // GH #435: a throw in the URI-parse block must roll back the partial
  // state — otherwise `mongod` stays set with `uri` null, the next
  // startLocalMongo() re-enters create() while the previous instance still
  // runs → port conflict + orphaned mongod.
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
  // #914: signal any in-flight start to self-stop on completion — the
  // backstop for when the start outlasts main.ts's 5s quit timeout and
  // app.quit() fires before the await below returns; create() still sees
  // the flag and stops itself, so no orphaned mongod holds the dbPath lock.
  shuttingDown = true;
  // #900: if a start is in flight, `mongod` isn't assigned yet — returning
  // here would let create() resolve AFTER we return, orphaning a mongod
  // with no handle to stop it. Wait for the start to settle, then stop
  // whatever it produced (a failed/self-aborted start rolls `mongod` back
  // to null).
  if (starting) {
    try {
      await starting;
    } catch {
      // start failed — nothing was left running to stop.
    }
  }
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

import { MongoMemoryServer } from "mongodb-memory-server-core";
import path from "path";
import { app } from "electron";
import fs from "fs";

let mongod: MongoMemoryServer | null = null;
let uri: string | null = null;

/**
 * Start an embedded local MongoDB instance.
 * Data is persisted under the app's userData directory.
 */
export async function startLocalMongo(): Promise<string> {
  if (mongod && uri) return uri;

  const dbPath = path.join(app.getPath("userData"), "mongodb-data");
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }

  mongod = await MongoMemoryServer.create({
    instance: {
      dbPath,
      storageEngine: "wiredTiger",
    },
  });

  uri = mongod.getUri();
  // Append the database name
  const url = new URL(uri);
  url.pathname = "/filament-db";
  uri = url.toString();

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

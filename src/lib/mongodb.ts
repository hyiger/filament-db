import mongoose from "mongoose";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  uri: string | null;
  /** Per-migration completion flags. Each migration only runs until it
   * succeeds — a transient failure (network blip, MongoDB busy) won't
   * permanently mark the migration done, so the next request will retry
   * instead of leaving the install stuck on stale data/index state. */
  migrations: {
    instanceIds: boolean;
    sharedCatalogIndexes: boolean;
  };
}

declare global {
  var mongoose: MongooseCache | undefined;
}

export default async function dbConnect() {
  const MONGODB_URI = process.env.MONGODB_URI;

  if (!MONGODB_URI) {
    throw new Error(
      "Please define the MONGODB_URI environment variable in .env.local"
    );
  }

  const cached: MongooseCache = global.mongoose ?? {
    conn: null,
    promise: null,
    uri: null,
    migrations: { instanceIds: false, sharedCatalogIndexes: false },
  };

  if (!global.mongoose) {
    global.mongoose = cached;
  }

  // If URI changed (e.g., switched from local to Atlas), reconnect — and
  // re-run migrations against the new database.
  if (cached.conn && cached.uri !== MONGODB_URI) {
    await mongoose.disconnect();
    cached.conn = null;
    cached.promise = null;
    cached.uri = null;
    cached.migrations = { instanceIds: false, sharedCatalogIndexes: false };
  }

  // Short-circuit only when both the connection AND all migrations are
  // settled. Without checking migrations, a transient failure on first
  // connect would never get retried — the next call would hit this
  // early return and skip the migration block entirely.
  if (
    cached.conn &&
    cached.migrations.instanceIds &&
    cached.migrations.sharedCatalogIndexes
  ) {
    return cached.conn;
  }

  if (!cached.conn) {
    if (!cached.promise) {
      cached.uri = MONGODB_URI;
      cached.promise = mongoose.connect(MONGODB_URI).catch((err) => {
        cached.promise = null;
        throw err;
      });
    }
    cached.conn = await cached.promise;
  }

  // One-time migrations on first connect after process start. Each
  // migration tracks its own success flag — a transient failure on one
  // doesn't poison the cache for the rest, and the next request retries
  // any that didn't complete instead of skipping the whole block.
  if (!cached.migrations.instanceIds) {
    try {
      const { backfillInstanceIds } = await import("@/models/Filament");
      const count = await backfillInstanceIds();
      if (count > 0) {
        console.log(`[migration] Backfilled instanceId for ${count} filament(s)`);
      }
      cached.migrations.instanceIds = true;
    } catch (err) {
      console.error("[migration] Failed to backfill instanceIds (will retry on next connect):", err);
    }
  }

  // SharedCatalog's slug index changed from a plain unique index to
  // a partial-unique-on-_deletedAt-null index when soft-delete landed.
  // MongoDB won't mutate existing index options in-place, so on
  // existing installs the old `slug_1` index keeps enforcing global
  // uniqueness (including over tombstoned rows). syncIndexes() drops
  // indexes that don't match the current schema and recreates them
  // with the new options — idempotent on fresh databases (the indexes
  // already match), corrective on upgraded ones.
  if (!cached.migrations.sharedCatalogIndexes) {
    try {
      const SharedCatalog = (await import("@/models/SharedCatalog")).default;
      const dropped = await SharedCatalog.syncIndexes();
      if (dropped.length > 0) {
        console.log(`[migration] Rebuilt SharedCatalog indexes (dropped: ${dropped.join(", ")})`);
      }
      cached.migrations.sharedCatalogIndexes = true;
    } catch (err) {
      console.error("[migration] Failed to sync SharedCatalog indexes (will retry on next connect):", err);
    }
  }

  return cached.conn;
}

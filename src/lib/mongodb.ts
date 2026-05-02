import mongoose from "mongoose";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  uri: string | null;
  migrated: boolean;
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
    migrated: false,
  };

  if (!global.mongoose) {
    global.mongoose = cached;
  }

  // If URI changed (e.g., switched from local to Atlas), reconnect
  if (cached.conn && cached.uri !== MONGODB_URI) {
    await mongoose.disconnect();
    cached.conn = null;
    cached.promise = null;
    cached.uri = null;
    cached.migrated = false;
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.uri = MONGODB_URI;
    cached.promise = mongoose.connect(MONGODB_URI).catch((err) => {
      cached.promise = null;
      throw err;
    });
  }

  cached.conn = await cached.promise;

  // One-time migrations on first connect after process start.
  if (!cached.migrated) {
    try {
      const { backfillInstanceIds } = await import("@/models/Filament");
      const count = await backfillInstanceIds();
      if (count > 0) {
        console.log(`[migration] Backfilled instanceId for ${count} filament(s)`);
      }
    } catch (err) {
      console.error("[migration] Failed to backfill instanceIds:", err);
    }

    // SharedCatalog's slug index changed from a plain unique index to
    // a partial-unique-on-_deletedAt-null index when soft-delete landed.
    // MongoDB won't mutate existing index options in-place, so on
    // existing installs the old `slug_1` index keeps enforcing global
    // uniqueness (including over tombstoned rows). syncIndexes() drops
    // indexes that don't match the current schema and recreates them
    // with the new options — idempotent on fresh databases (the indexes
    // already match), corrective on upgraded ones.
    try {
      const SharedCatalog = (await import("@/models/SharedCatalog")).default;
      const dropped = await SharedCatalog.syncIndexes();
      if (dropped.length > 0) {
        console.log(`[migration] Rebuilt SharedCatalog indexes (dropped: ${dropped.join(", ")})`);
      }
    } catch (err) {
      console.error("[migration] Failed to sync SharedCatalog indexes:", err);
    }

    cached.migrated = true;
  }

  return cached.conn;
}

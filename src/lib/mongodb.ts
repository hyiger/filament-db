import mongoose from "mongoose";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  uri: string | null;
}

declare global {
  // eslint-disable-next-line no-var
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
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.uri = MONGODB_URI;
    cached.promise = mongoose.connect(MONGODB_URI);
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

import { NextResponse } from "next/server";

export async function GET() {
  const uri = process.env.MONGODB_URI;
  const info: Record<string, unknown> = {
    hasUri: !!uri,
    uriPrefix: uri ? uri.substring(0, 20) + "..." : null,
    nodeVersion: process.version,
  };

  if (!uri) {
    return NextResponse.json({ ...info, error: "MONGODB_URI not set" });
  }

  try {
    const mongoose = await import("mongoose");
    info.mongooseVersion = mongoose.version;

    const conn = await mongoose.createConnection(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    }).asPromise();

    const collections = await conn.db!.listCollections().toArray();
    info.collections = collections.map((c) => c.name);
    info.connected = true;

    await conn.close();
  } catch (err) {
    info.connected = false;
    info.error = err instanceof Error ? err.message : String(err);
    info.stack = err instanceof Error ? err.stack?.split("\n").slice(0, 5) : null;
  }

  return NextResponse.json(info);
}

import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";

export async function POST(request: NextRequest) {
  const { mongodbUri } = await request.json();

  if (!mongodbUri) {
    return NextResponse.json({ error: "MongoDB URI is required" }, { status: 400 });
  }

  try {
    // Test the connection with a short timeout
    const testConnection = await mongoose.createConnection(mongodbUri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    }).asPromise();

    await testConnection.close();

    return NextResponse.json({ success: true, message: "Connection successful" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

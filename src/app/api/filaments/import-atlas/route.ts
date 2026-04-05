import { NextRequest, NextResponse } from "next/server";
import { MongoClient } from "mongodb";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

// POST with { uri } — list filaments from remote Atlas
// POST with { uri, filaments: [...ids] } — import selected filaments
export async function POST(request: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
  }
  const { uri } = body;

  if (!uri || typeof uri !== "string") {
    return NextResponse.json({ error: "Connection string is required" }, { status: 400 });
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();

    // Parse database name from connection string, default to "filament-db"
    let dbName = "filament-db";
    try {
      const parsed = new URL(uri.replace("mongodb+srv://", "https://").replace("mongodb://", "https://"));
      const pathDb = parsed.pathname.replace("/", "").split("?")[0];
      if (pathDb) dbName = pathDb;
    } catch { /* use default */ }
    const db = client.db(dbName);

    // If filament IDs provided, import them
    if (body.filamentIds && Array.isArray(body.filamentIds)) {
      const { ObjectId } = await import("mongodb");

      // Validate IDs before constructing ObjectId
      const ids = body.filamentIds.map((id: string) => String(id).trim());
      const invalidIds = ids.filter((id: string) => !/^[a-f0-9]{24}$/i.test(id));
      if (invalidIds.length > 0) {
        return NextResponse.json({ error: `Invalid filament ID(s): ${invalidIds.join(", ")}` }, { status: 400 });
      }

      const objectIds = ids.map((id: string) => new ObjectId(id));
      const remoteFilaments = await db
        .collection("filaments")
        .find({ _id: { $in: objectIds } })
        .toArray();

      if (remoteFilaments.length === 0) {
        return NextResponse.json({ error: "No matching filaments found" }, { status: 404 });
      }

      await dbConnect();

      let created = 0;
      let updated = 0;

      for (const remote of remoteFilaments) {
        // Strip MongoDB internal fields
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id: _remoteId, __v: _remoteV, createdAt: _createdAt, updatedAt: _updatedAt, ...filamentData } = remote;

        // Strip parent references (they won't exist in the local DB)
        delete filamentData.parentId;

        const existing = await Filament.findOne({ name: filamentData.name, _deletedAt: null });
        if (existing) {
          await Filament.updateOne({ _id: existing._id }, filamentData);
          updated++;
        } else {
          // If a soft-deleted doc with the same name exists, resurrect it
          const softDeleted = await Filament.findOne({ name: filamentData.name, _deletedAt: { $ne: null } });
          if (softDeleted) {
            await Filament.updateOne({ _id: softDeleted._id }, { ...filamentData, _deletedAt: null });
            updated++;
          } else {
            await Filament.create(filamentData);
            created++;
          }
        }
      }

      return NextResponse.json({
        message: `Imported ${remoteFilaments.length} filament${remoteFilaments.length !== 1 ? "s" : ""} (${created} new, ${updated} updated)`,
        total: remoteFilaments.length,
        created,
        updated,
      });
    }

    // Otherwise, list all filaments from the remote DB
    const filaments = await db
      .collection("filaments")
      .find({ _deletedAt: null })
      .project({
        _id: 1,
        name: 1,
        vendor: 1,
        type: 1,
        color: 1,
        "temperatures.nozzle": 1,
        "temperatures.bed": 1,
      })
      .sort({ name: 1 })
      .toArray();

    return NextResponse.json({ filaments });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    // Sanitize: don't leak the full connection string back
    const safe = message.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "mongodb://***");
    return NextResponse.json({ error: safe }, { status: 500 });
  } finally {
    await client.close();
  }
}

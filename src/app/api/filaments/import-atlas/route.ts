import { NextRequest, NextResponse } from "next/server";
import { MongoClient } from "mongodb";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

// POST with { uri } — list filaments from remote Atlas
// POST with { uri, filaments: [...ids] } — import selected filaments
export async function POST(request: NextRequest) {
  const body = await request.json();
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
    const db = client.db("filament-db");

    // If filament IDs provided, import them
    if (body.filamentIds && Array.isArray(body.filamentIds)) {
      const { ObjectId } = await import("mongodb");
      const objectIds = body.filamentIds.map((id: string) => new ObjectId(id));
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
        const { _id, __v, createdAt, updatedAt, ...filamentData } = remote;

        // Strip parent references (they won't exist in the local DB)
        delete filamentData.parentId;

        const existing = await Filament.findOne({ name: filamentData.name });
        if (existing) {
          await Filament.updateOne({ name: filamentData.name }, filamentData);
          updated++;
        } else {
          await Filament.create(filamentData);
          created++;
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
      .find({})
      .project({
        _id: 1,
        name: 1,
        vendor: 1,
        type: 1,
        color: 1,
        parentId: 1,
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

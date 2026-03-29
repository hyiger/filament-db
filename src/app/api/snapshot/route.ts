import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";

/**
 * GET /api/snapshot — Export the entire database as a JSON snapshot.
 *
 * The snapshot includes all documents (including soft-deleted) from all
 * three collections. Timestamps, _ids, and references are preserved so
 * the snapshot can be restored as-is.
 */
export async function GET() {
  await dbConnect();

  const [filaments, nozzles, printers] = await Promise.all([
    Filament.find({}).lean(),
    Nozzle.find({}).lean(),
    Printer.find({}).lean(),
  ]);

  const snapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    collections: {
      filaments,
      nozzles,
      printers,
    },
  };

  const json = JSON.stringify(snapshot, null, 2);
  const date = new Date().toISOString().slice(0, 10);

  return new NextResponse(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="filament-db-snapshot-${date}.json"`,
    },
  });
}

/**
 * POST /api/snapshot — Restore the database from a JSON snapshot.
 *
 * This is a destructive operation: all existing documents in the three
 * collections are deleted and replaced with the snapshot contents.
 *
 * Expects multipart/form-data with a single "file" field containing
 * the snapshot JSON.
 */
export async function POST(request: NextRequest) {
  await dbConnect();

  let snapshot: {
    version?: number;
    collections?: {
      filaments?: unknown[];
      nozzles?: unknown[];
      printers?: unknown[];
    };
  };

  const contentType = request.headers.get("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      const text = await file.text();
      snapshot = JSON.parse(text);
    } else {
      snapshot = await request.json();
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON in snapshot file" }, { status: 400 });
  }

  // Validate structure
  if (!snapshot.collections) {
    return NextResponse.json(
      { error: "Invalid snapshot: missing 'collections' key" },
      { status: 400 },
    );
  }

  const { filaments = [], nozzles = [], printers = [] } = snapshot.collections;

  // Use a transaction-like approach: delete all, then insert
  // (MongoDB transactions require replica sets, which local dev may not have)
  try {
    // Delete all existing documents from each collection
    await Promise.all([
      Nozzle.deleteMany({}),
      Printer.deleteMany({}),
      Filament.deleteMany({}),
    ]);

    // Insert snapshot data (order matters: nozzles first since filaments/printers reference them)
    const results = { filaments: 0, nozzles: 0, printers: 0 };

    if (nozzles.length > 0) {
      await Nozzle.insertMany(nozzles, { lean: true, ordered: false });
      results.nozzles = nozzles.length;
    }

    if (printers.length > 0) {
      await Printer.insertMany(printers, { lean: true, ordered: false });
      results.printers = printers.length;
    }

    if (filaments.length > 0) {
      await Filament.insertMany(filaments, { lean: true, ordered: false });
      results.filaments = filaments.length;
    }

    return NextResponse.json({
      message: "Snapshot restored successfully",
      restored: results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to restore snapshot", detail: message },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";

// Simple in-memory mutex to prevent concurrent restore operations.
// Limitation: this only guards within a single Node.js process. In a
// horizontally-scaled deployment each instance would have its own flag,
// so concurrent restores from different instances would not be blocked.
// This is acceptable for a single-instance desktop app.
let restoreInProgress = false;

const OID_RE = /^[a-f0-9]{24}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const OID_FIELDS = new Set(["_id", "parentId", "printer", "nozzle", "bedType"]);
const DATE_FIELDS = new Set(["createdAt", "updatedAt", "_deletedAt"]);

/**
 * Recursively restore ObjectId and Date fields that were serialized as strings.
 * Handles _id, parentId, array elements in compatibleNozzles/installedNozzles,
 * nested refs in calibrations/spools, and timestamp fields.
 */
function restoreTypes(doc: Record<string, unknown>): Record<string, unknown> {
  for (const [key, val] of Object.entries(doc)) {
    if (val === null || val === undefined) continue;

    if (typeof val === "string") {
      if (OID_RE.test(val) && OID_FIELDS.has(key)) {
        doc[key] = new mongoose.Types.ObjectId(val);
      } else if (DATE_FIELDS.has(key) && ISO_DATE_RE.test(val)) {
        doc[key] = new Date(val);
      }
    } else if (Array.isArray(val)) {
      doc[key] = val.map((item) => {
        if (typeof item === "string" && OID_RE.test(item)) {
          return new mongoose.Types.ObjectId(item);
        }
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          return restoreTypes(item as Record<string, unknown>);
        }
        return item;
      });
    } else if (typeof val === "object" && !(val instanceof mongoose.Types.ObjectId) && !(val instanceof Date)) {
      doc[key] = restoreTypes(val as Record<string, unknown>);
    }
  }
  return doc;
}

/**
 * GET /api/snapshot — Export the entire database as a JSON snapshot.
 *
 * The snapshot includes all documents (including soft-deleted) from all
 * three collections. Timestamps, _ids, and references are preserved so
 * the snapshot can be restored as-is.
 */
export async function GET() {
  await dbConnect();

  const [filaments, nozzles, printers, bedTypes] = await Promise.all([
    Filament.find({}).lean(),
    Nozzle.find({}).lean(),
    Printer.find({}).lean(),
    BedType.find({}).lean(),
  ]);

  // Snapshot version bumped to 2 to signal that the bedTypes collection is
  // present. Restores of version-1 snapshots still work — bedTypes will be
  // empty in that case — but clients can detect missing data and warn.
  const snapshot = {
    version: 2,
    createdAt: new Date().toISOString(),
    collections: {
      filaments,
      nozzles,
      printers,
      bedTypes,
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
  if (restoreInProgress) {
    return NextResponse.json(
      { error: "A snapshot restore is already in progress. Please wait." },
      { status: 409 },
    );
  }

  restoreInProgress = true;
  try {
    return await restoreSnapshot(request);
  } finally {
    restoreInProgress = false;
  }
}

async function restoreSnapshot(request: NextRequest) {
  await dbConnect();

  let snapshot: {
    version?: number;
    collections?: {
      filaments?: unknown[];
      nozzles?: unknown[];
      printers?: unknown[];
      bedTypes?: unknown[];
    };
  };

  const contentType = request.headers.get("content-type") || "";

  const MAX_SNAPSHOT_SIZE = 50 * 1024 * 1024; // 50 MB

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      if (file.size > MAX_SNAPSHOT_SIZE) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        return NextResponse.json(
          { error: `File too large (${sizeMB} MB). Maximum snapshot size is 50 MB.` },
          { status: 413 },
        );
      }
      const text = await file.text();
      snapshot = JSON.parse(text);
    } else {
      const text = await request.text();
      if (text.length > MAX_SNAPSHOT_SIZE) {
        return NextResponse.json(
          { error: `Snapshot too large (max ${MAX_SNAPSHOT_SIZE / 1024 / 1024}MB)` },
          { status: 413 },
        );
      }
      snapshot = JSON.parse(text);
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

  const {
    filaments = [],
    nozzles = [],
    printers = [],
    bedTypes = [],
  } = snapshot.collections;

  // --- Safety: snapshot the current DB so we can roll back on failure ---
  const [backupFilaments, backupNozzles, backupPrinters, backupBedTypes] = await Promise.all([
    Filament.find({}).lean(),
    Nozzle.find({}).lean(),
    Printer.find({}).lean(),
    BedType.find({}).lean(),
  ]);

  try {
    // Delete all existing documents from each collection
    await Promise.all([
      Nozzle.deleteMany({}),
      Printer.deleteMany({}),
      Filament.deleteMany({}),
      BedType.deleteMany({}),
    ]);

    // Insert snapshot data (order matters: reference targets before referrers
    // — nozzles, printers, and bedTypes all exist before filaments that
    // reference them via calibrations)
    const results = { filaments: 0, nozzles: 0, printers: 0, bedTypes: 0 };

    if (nozzles.length > 0) {
      const docs = (nozzles as Record<string, unknown>[]).map(restoreTypes);
      await Nozzle.insertMany(docs, { lean: true, ordered: false });
      results.nozzles = nozzles.length;
    }

    if (printers.length > 0) {
      const docs = (printers as Record<string, unknown>[]).map(restoreTypes);
      await Printer.insertMany(docs, { lean: true, ordered: false });
      results.printers = printers.length;
    }

    if (bedTypes.length > 0) {
      const docs = (bedTypes as Record<string, unknown>[]).map(restoreTypes);
      await BedType.insertMany(docs, { lean: true, ordered: false });
      results.bedTypes = bedTypes.length;
    }

    if (filaments.length > 0) {
      const docs = (filaments as Record<string, unknown>[]).map(restoreTypes);
      await Filament.insertMany(docs, { lean: true, ordered: false });
      results.filaments = filaments.length;
    }

    return NextResponse.json({
      message: "Snapshot restored successfully",
      restored: results,
    });
  } catch (err) {
    // --- Rollback: attempt to restore the pre-restore data ---
    try {
      await Promise.all([
        Nozzle.deleteMany({}),
        Printer.deleteMany({}),
        Filament.deleteMany({}),
        BedType.deleteMany({}),
      ]);
      if (backupNozzles.length > 0) await Nozzle.insertMany(backupNozzles, { ordered: false });
      if (backupPrinters.length > 0) await Printer.insertMany(backupPrinters, { ordered: false });
      if (backupBedTypes.length > 0) await BedType.insertMany(backupBedTypes, { ordered: false });
      if (backupFilaments.length > 0) await Filament.insertMany(backupFilaments, { ordered: false });
    } catch (rollbackErr) {
      // Rollback itself failed — report it so the user knows data may be lost
      const detail = err instanceof Error ? err.message : String(err);
      const rollbackDetail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      return NextResponse.json(
        {
          error: "Failed to restore snapshot and rollback also failed. Database may be in an inconsistent state — re-import a backup manually.",
          detail,
          rollbackError: rollbackDetail,
        },
        { status: 500 },
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to restore snapshot — previous data has been rolled back.", detail: message },
      { status: 500 },
    );
  }
}

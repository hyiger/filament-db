import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { checkContentLength } from "@/lib/apiErrorHandler";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import Location from "@/models/Location";
import PrintHistory from "@/models/PrintHistory";
import SharedCatalog from "@/models/SharedCatalog";

// Simple in-memory mutex to prevent concurrent restore operations.
// Limitation: this only guards within a single Node.js process. In a
// horizontally-scaled deployment each instance would have its own flag,
// so concurrent restores from different instances would not be blocked.
// This is acceptable for a single-instance desktop app.
let restoreInProgress = false;

/** Current snapshot schema version (see the version history in GET). Bumped
 * whenever the `collections` shape changes so restore can reject newer files
 * (GH #953). */
const CURRENT_SNAPSHOT_VERSION = 4;

/** The collection keys a v≤4 snapshot carries. Restore requires at least one to
 * be present so a wrong-shape / newer file 400s instead of silently wiping the
 * DB and inserting nothing (GH #953). */
const KNOWN_COLLECTION_KEYS = [
  "filaments",
  "nozzles",
  "printers",
  "bedTypes",
  "locations",
  "printHistory",
  "sharedCatalogs",
] as const;

const OID_RE = /^[a-f0-9]{24}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const OID_FIELDS = new Set([
  "_id",
  "parentId",
  "printer",
  "nozzle",
  "bedType",
  "locationId",
  "printerId",
  "filamentId",
  "spoolId",
]);
/**
 * GH #890: the ObjectId-array fields. The array branch of restoreTypes must
 * coerce a 24-hex string element to an ObjectId ONLY for these keys — mirroring
 * the field-gated scalar path (OID_FIELDS). Without this gate it coerced EVERY
 * 24-hex array element regardless of field name, so a future string-array field
 * whose values happened to be 24 hex chars would have its type silently changed
 * on restore. The only ObjectId arrays in the schema are the two nozzle arrays.
 */
const OID_ARRAY_FIELDS = new Set(["compatibleNozzles", "installedNozzles"]);
const DATE_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "_deletedAt",
  "purchaseDate",
  "openedDate",
  "startedAt",
  "date",
  "expiresAt",
]);

/**
 * Recursively restore ObjectId and Date fields that were serialized as strings.
 * Handles _id, parentId, ObjectId-array elements (only the keys in
 * OID_ARRAY_FIELDS — compatibleNozzles/installedNozzles), nested refs in
 * calibrations/spools, and timestamp fields. Array-element ObjectId coercion is
 * field-gated (GH #890) so a non-ObjectId 24-hex string in any other array
 * round-trips as a string.
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
        // GH #890: gate on the key, mirroring the scalar path — only coerce
        // 24-hex elements of the known ObjectId arrays, never any 24-hex string.
        if (typeof item === "string" && OID_RE.test(item) && OID_ARRAY_FIELDS.has(key)) {
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
 * GET /api/snapshot — Export snapshot-scoped app data as JSON.
 *
 * The snapshot includes all documents (including soft-deleted) from
 * filaments, nozzles, printers, bed types, locations, print history,
 * and shared catalogs. Timestamps, _ids, and references are preserved
 * so the snapshot can be restored as-is.
 *
 * #732 Phase 5: filaments are exported whole (embedded spools included),
 * so each spool's per-spool `instanceId` round-trips with no special
 * handling — restore re-hydrates the subdoc through the Filament schema.
 *
 * Note on JSON keys: `bedTypes`, `printHistory`, and `sharedCatalogs`
 * are camelCase keys in the JSON shape, but the restore writes go
 * through the corresponding Mongoose models (BedType, PrintHistory,
 * SharedCatalog) — the keys never reach Mongo, so there's no
 * collection-name mismatch. The keys are kept stable so older
 * snapshots round-trip on the same shape.
 */
export async function GET(request: NextRequest) {
  // GH #252: a snapshot is a full data export — reject cross-origin
  // (CSRF) callers so a hostile page can't trigger an exfiltration.
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  await dbConnect();

  const [
    filaments,
    nozzles,
    printers,
    bedTypes,
    locations,
    printHistory,
    sharedCatalogs,
  ] = await Promise.all([
    Filament.find({}).lean(),
    Nozzle.find({}).lean(),
    Printer.find({}).lean(),
    BedType.find({}).lean(),
    Location.find({}).lean(),
    PrintHistory.find({}).lean(),
    SharedCatalog.find({}).lean(),
  ]);

  // Snapshot version history:
  //   v1 — filaments, nozzles, printers
  //   v2 — adds bedTypes
  //   v3 — adds locations + printHistory
  //   v4 — adds sharedCatalogs (GH #158: previously dropped on every
  //        snapshot/restore round-trip, silently losing every published
  //        share link; now symmetric with /api/snapshot/delete which
  //        always cleared SharedCatalog)
  // Older snapshots still restore cleanly because POST destructures
  // missing collections to `[]`.
  const snapshot = {
    version: CURRENT_SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    collections: {
      filaments,
      nozzles,
      printers,
      bedTypes,
      locations,
      printHistory,
      sharedCatalogs,
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
 * This is a destructive operation: all existing documents in the
 * snapshot-scoped collections are deleted and replaced with the snapshot
 * contents.
 *
 * Expects multipart/form-data with a single "file" field containing
 * the snapshot JSON.
 */
export async function POST(request: NextRequest) {
  // GH #252: restore wipes and replaces every collection — reject
  // cross-origin (CSRF) callers before the destructive work begins.
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

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
      locations?: unknown[];
      printHistory?: unknown[];
      sharedCatalogs?: unknown[];
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
      // GH #889: cap the raw body via Content-Length BEFORE buffering it, so a
      // multi-GB body can't force full allocation before the post-buffer guard
      // fires (the sibling raw-body routes — prusaslicer, nfc/decode — do this).
      const lenError = checkContentLength(request, MAX_SNAPSHOT_SIZE);
      if (lenError) return lenError;
      const text = await request.text();
      // Codex P2 (#890→#920): measure BYTES, not UTF-16 code units. When the
      // Content-Length header is missing/wrong the preflight above doesn't fire,
      // so this belt-and-suspenders check is the only byte cap — and multi-byte
      // text would slip past a `text.length` (code-unit) comparison. Matches the
      // sibling raw-body routes' `Buffer.byteLength(body, "utf8")`.
      if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_SIZE) {
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

  // GH #953: reject a snapshot from a NEWER app version BEFORE the destructive
  // wipe. The restore only knows the seven v≤4 collection keys (destructured
  // with `= []` defaults); a v5+ file that added/renamed/moved a collection
  // would have that data silently dropped after every current collection is
  // wiped, and the handler would still report "restored successfully" — a
  // partial restore over a full wipe with no warning. Fail closed instead.
  if (
    typeof snapshot.version === "number" &&
    snapshot.version > CURRENT_SNAPSHOT_VERSION
  ) {
    return NextResponse.json(
      {
        error: `This snapshot is from a newer version (v${snapshot.version}). Update Filament DB to at least the version that created it before restoring.`,
      },
      { status: 400 },
    );
  }

  // Validate structure. `collections` must be a plain, non-array object that
  // carries at least one recognized collection key. GH #953: the old bare
  // truthiness check (`if (!snapshot.collections)`) let a wrong-shape file
  // through — `collections: 1`, `collections: {}`, or `collections: { foo: [] }`
  // all destructure the seven known keys to `[]`, so the wipe runs, nothing is
  // inserted, and the handler reports success over an emptied DB.
  const cols = snapshot.collections;
  if (typeof cols !== "object" || cols === null || Array.isArray(cols)) {
    return NextResponse.json(
      { error: "Invalid snapshot: missing or malformed 'collections'" },
      { status: 400 },
    );
  }
  if (!KNOWN_COLLECTION_KEYS.some((k) => k in cols)) {
    return NextResponse.json(
      {
        error:
          "Invalid snapshot: 'collections' contains no recognized collections (filaments, nozzles, printers, bedTypes, locations, printHistory, sharedCatalogs). This file may not be a Filament DB snapshot, or is from a newer version.",
      },
      { status: 400 },
    );
  }
  // GH #953 (Codex P1): each PRESENT known collection must be an array. The
  // destructure below only defaults ABSENT keys to `[]` — a present non-array
  // value (`{ filaments: {} }`, `{ locations: 1 }`) survives, its `.length` is
  // undefined so every insert is skipped, and the handler wipes the DB then
  // reports success with nothing restored. Reject before the backup/wipe.
  const colsRecord = cols as Record<string, unknown>;
  for (const key of KNOWN_COLLECTION_KEYS) {
    if (key in colsRecord && !Array.isArray(colsRecord[key])) {
      return NextResponse.json(
        { error: `Invalid snapshot: 'collections.${key}' must be an array` },
        { status: 400 },
      );
    }
  }

  const {
    filaments = [],
    nozzles = [],
    printers = [],
    bedTypes = [],
    locations = [],
    printHistory = [],
    sharedCatalogs = [],
  } = cols;

  // --- Safety: snapshot the current DB so we can roll back on failure ---
  const [
    backupFilaments,
    backupNozzles,
    backupPrinters,
    backupBedTypes,
    backupLocations,
    backupPrintHistory,
    backupSharedCatalogs,
  ] = await Promise.all([
    Filament.find({}).lean(),
    Nozzle.find({}).lean(),
    Printer.find({}).lean(),
    BedType.find({}).lean(),
    Location.find({}).lean(),
    PrintHistory.find({}).lean(),
    SharedCatalog.find({}).lean(),
  ]);

  try {
    // Delete all existing documents from each collection
    await Promise.all([
      Nozzle.deleteMany({}),
      Printer.deleteMany({}),
      Filament.deleteMany({}),
      BedType.deleteMany({}),
      Location.deleteMany({}),
      PrintHistory.deleteMany({}),
      SharedCatalog.deleteMany({}),
    ]);

    // Insert snapshot data (order matters: reference targets before referrers
    // — nozzles, printers, bedTypes, locations all exist before filaments
    // that reference them via calibrations / spools.locationId).
    //
    // GH #259: `insertMany` runs WITHOUT `lean: true`. `lean` skipped
    // Mongoose hydration entirely — so casting, schema validation, and
    // strict-mode unknown-key stripping were all bypassed, making
    // restore an arbitrary-document-write primitive (negative numerics,
    // injected keys, bad types). Hydrating each doc applies the schema.
    //
    // GH #259 (Codex P1): `ordered: true` (NOT `ordered: false`). With
    // `ordered: false` Mongoose inserts the valid subset and — with the
    // default `throwOnValidationError: false` — does NOT throw, so an
    // invalid snapshot would be acknowledged as a successful restore
    // while silently dropping records. `ordered: true` throws on the
    // first invalid document, and the catch below rolls every
    // collection back to the pre-restore backup — true all-or-nothing.
    const results = {
      filaments: 0,
      nozzles: 0,
      printers: 0,
      bedTypes: 0,
      locations: 0,
      printHistory: 0,
      sharedCatalogs: 0,
    };

    if (nozzles.length > 0) {
      const docs = (nozzles as Record<string, unknown>[]).map(restoreTypes);
      await Nozzle.insertMany(docs, { ordered: true });
      results.nozzles = nozzles.length;
    }

    if (printers.length > 0) {
      const docs = (printers as Record<string, unknown>[]).map(restoreTypes);
      await Printer.insertMany(docs, { ordered: true });
      results.printers = printers.length;
    }

    if (bedTypes.length > 0) {
      const docs = (bedTypes as Record<string, unknown>[]).map(restoreTypes);
      await BedType.insertMany(docs, { ordered: true });
      results.bedTypes = bedTypes.length;
    }

    if (locations.length > 0) {
      const docs = (locations as Record<string, unknown>[]).map(restoreTypes);
      await Location.insertMany(docs, { ordered: true });
      results.locations = locations.length;
    }

    if (filaments.length > 0) {
      const docs = (filaments as Record<string, unknown>[]).map(restoreTypes);
      await Filament.insertMany(docs, { ordered: true });
      results.filaments = filaments.length;
    }

    if (printHistory.length > 0) {
      const docs = (printHistory as Record<string, unknown>[]).map(restoreTypes);
      await PrintHistory.insertMany(docs, { ordered: true });
      results.printHistory = printHistory.length;
    }

    if (sharedCatalogs.length > 0) {
      const docs = (sharedCatalogs as Record<string, unknown>[]).map(restoreTypes);
      await SharedCatalog.insertMany(docs, { ordered: true });
      results.sharedCatalogs = sharedCatalogs.length;
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
        Location.deleteMany({}),
        PrintHistory.deleteMany({}),
        SharedCatalog.deleteMany({}),
      ]);
      if (backupNozzles.length > 0) await Nozzle.insertMany(backupNozzles, { ordered: false });
      if (backupPrinters.length > 0) await Printer.insertMany(backupPrinters, { ordered: false });
      if (backupBedTypes.length > 0) await BedType.insertMany(backupBedTypes, { ordered: false });
      if (backupLocations.length > 0) await Location.insertMany(backupLocations, { ordered: false });
      if (backupFilaments.length > 0) await Filament.insertMany(backupFilaments, { ordered: false });
      if (backupPrintHistory.length > 0) await PrintHistory.insertMany(backupPrintHistory, { ordered: false });
      if (backupSharedCatalogs.length > 0) await SharedCatalog.insertMany(backupSharedCatalogs, { ordered: false });
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

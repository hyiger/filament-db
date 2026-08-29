import { NextRequest, NextResponse } from "next/server";
import { findTrimmedNameCollision } from "@/lib/trimEntityNames";
import mongoose from "mongoose";
import dbConnect, {
  rerunLegacyNozzleCleanupAfterRestore,
  RestoreCleanupInvalidationError,
} from "@/lib/mongodb";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { checkContentLength } from "@/lib/apiErrorHandler";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import Location from "@/models/Location";
import PrintHistory from "@/models/PrintHistory";
import SharedCatalog from "@/models/SharedCatalog";

// In-memory mutex against concurrent restores. Guards a single Node process
// only — acceptable for a single-instance desktop app.
let restoreInProgress = false;

/** Current snapshot schema version (see the version history in GET). Bumped
 * whenever the snapshot shape changes so restore can reject newer files
 * (GH #953). v5 carries the `legacyNozzleCleanupComplete` provenance flag
 * (GH #1021); v7 (GH #1074) adds `debitedGrams` on BOTH usage ledgers — a
 * pre-#1074 build would ACCEPT a v7 file while its strict schemas silently
 * strip the field, quietly losing the data that prevents the clamped-debit
 * over-refund. A refused restore is recoverable, a silent partial one
 * isn't. */
const CURRENT_SNAPSHOT_VERSION = 7;

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

/**
 * Wipe / insert / rollback order: reference targets before referrers.
 * Deliberately SEPARATE from KNOWN_COLLECTION_KEYS, which is the order the
 * validation guards walk — collapsing the two would change which collection
 * a malformed file is reported against.
 */
const SNAPSHOT_RESTORE_ORDER = [
  "nozzles",
  "printers",
  "bedTypes",
  "locations",
  "filaments",
  "printHistory",
  "sharedCatalogs",
] as const;

/**
 * The slice of a Mongoose model the wipe / rollback needs. Declared
 * structurally rather than as a union of the seven model types: TS resolves
 * a union's `deleteMany` to an intersection of overloads, making even
 * `deleteMany({})` unassignable.
 */
interface SnapshotCollectionModel {
  deleteMany(filter: Record<string, unknown>): Promise<unknown>;
  insertMany(docs: unknown[], opts: Record<string, unknown>): Promise<unknown[]>;
}

/** Collection key → model, so the wipe/rollback can be driven by key. */
const SNAPSHOT_MODELS: Record<
  (typeof KNOWN_COLLECTION_KEYS)[number],
  SnapshotCollectionModel
> = {
  filaments: Filament as unknown as SnapshotCollectionModel,
  nozzles: Nozzle as unknown as SnapshotCollectionModel,
  printers: Printer as unknown as SnapshotCollectionModel,
  bedTypes: BedType as unknown as SnapshotCollectionModel,
  locations: Location as unknown as SnapshotCollectionModel,
  printHistory: PrintHistory as unknown as SnapshotCollectionModel,
  sharedCatalogs: SharedCatalog as unknown as SnapshotCollectionModel,
};

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
 * GH #890: the ObjectId-array fields. restoreTypes coerces a 24-hex string
 * array element ONLY for these keys — ungated, a future string-array field
 * whose values happen to be 24 hex chars would have its type silently
 * changed on restore.
 */
const OID_ARRAY_FIELDS = new Set(["compatibleNozzles", "installedNozzles"]);
const DATE_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "_deletedAt",
  "purchaseDate",
  "openedDate",
  "desiccantChangedAt",
  "startedAt",
  "date",
  "expiresAt",
]);

/**
 * Recursively restore ObjectId and Date fields that were serialized as
 * strings. Array-element ObjectId coercion is field-gated (OID_ARRAY_FIELDS,
 * GH #890) so a non-ObjectId 24-hex string in any other array round-trips as
 * a string.
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
 * GH #1009: re-tombstone a purged-but-not-deleted "zombie" row at restore
 * time. The startup `purgedZombies` migration runs once per process and its
 * in-memory flag is already set when this restore runs, so a restored zombie
 * would stay visible until an app restart while hybrid sync treats it as a
 * permanent tombstone. No-op for the common case.
 */
function normalizePurgedTombstone(doc: Record<string, unknown>): Record<string, unknown> {
  if (doc._purged === true && doc._deletedAt == null) {
    doc._deletedAt = new Date();
  }
  return doc;
}

/**
 * GET /api/snapshot — Export snapshot-scoped app data as JSON.
 *
 * Includes all documents (soft-deleted too) from the seven collections;
 * timestamps, _ids and references are preserved so the snapshot restores
 * as-is (filaments whole, embedded spools + per-spool instanceId included).
 *
 * The camelCase JSON keys (`bedTypes`, `printHistory`, `sharedCatalogs`)
 * never reach Mongo — restore writes go through the Mongoose models — and
 * are kept stable so older snapshots round-trip on the same shape.
 */
export async function GET(request: NextRequest) {
  // GH #252: a snapshot is a full data export — reject cross-origin (CSRF)
  // callers so a hostile page can't trigger an exfiltration.
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
  //        round-trip, silently losing every published share link)
  //   v5 — adds the top-level legacyNozzleCleanupComplete flag (GH #1021)
  //   v6 — adds Location.desiccantChangedAt (a build without the field
  //        would accept the file and silently DROP the date; failing closed
  //        via the #953 guard is the established trade-off)
  //   v7 — adds debitedGrams on both usage ledgers (GH #1074)
  // Older snapshots still restore cleanly because POST destructures missing
  // collections to `[]`.
  // GH #1021: cleanup provenance — restore uses this to decide whether the
  // snapshot's data predates the one-shot legacy nozzle-condition cleanup
  // (absent/false → re-run it over the restored rows) or is post-cleanup
  // (true → a byte-identical pure nozzle condition in the backup is a USER
  // pin, and re-judging it would erase legitimate configuration).
  const cleanupMarker = await mongoose.connection.db
    ?.collection("_migrations")
    .findOne({ _id: "legacyNozzleConditions" as never });

  const snapshot = {
    version: CURRENT_SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    legacyNozzleCleanupComplete: cleanupMarker?.completed === true,
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
 * Destructive: documents in the collections the snapshot CARRIES are deleted
 * and replaced. Expects multipart/form-data with a "file" field.
 */
export async function POST(request: NextRequest) {
  // GH #252: restore wipes and replaces collections — reject cross-origin
  // (CSRF) callers before the destructive work begins.
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
    legacyNozzleCleanupComplete?: boolean;
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
      // GH #889: cap the raw body via Content-Length BEFORE buffering it, so
      // a multi-GB body can't force full allocation (mirrors the sibling
      // raw-body routes).
      const lenError = checkContentLength(request, MAX_SNAPSHOT_SIZE);
      if (lenError) return lenError;
      const text = await request.text();
      // Measure BYTES, not UTF-16 code units — with a missing/wrong
      // Content-Length this is the only byte cap, and multi-byte text slips
      // past a `text.length` comparison.
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

  // GH #953: reject a snapshot from a NEWER app version BEFORE the
  // destructive wipe — a newer file's added/renamed collections would be
  // silently dropped after the wipe while still reporting success. Fail
  // closed instead.
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

  // GH #953: `collections` must be a plain, non-array object carrying at
  // least one recognized key — a wrong-shape file (`collections: 1`, `{}`,
  // `{ foo: [] }`) would destructure every known key to `[]`, wipe, insert
  // nothing, and report success over an emptied DB.
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
  // GH #953: each PRESENT known collection must be an array — the
  // destructure only defaults ABSENT keys to `[]`, so a present non-array
  // survives, its `.length` is undefined, every insert is skipped, and the
  // handler wipes then reports success. Reject before the backup/wipe.
  const colsRecord = cols as Record<string, unknown>;
  for (const key of KNOWN_COLLECTION_KEYS) {
    if (key in colsRecord && !Array.isArray(colsRecord[key])) {
      return NextResponse.json(
        { error: `Invalid snapshot: 'collections.${key}' must be an array` },
        { status: 400 },
      );
    }
  }

  // GH #1104: which collections this file actually CARRIES. A
  // present-but-empty array is a deliberate "make this collection empty"; an
  // ABSENT key means the file has no opinion — wiping on its behalf is what
  // silently emptied Locations/PrintHistory/SharedCatalog when an
  // older-format snapshot was restored. `in` rather than truthiness: the
  // validation above rejected every present non-array, so present ⇒ array.
  const present = new Set(
    KNOWN_COLLECTION_KEYS.filter((k) =>
      Object.prototype.hasOwnProperty.call(colsRecord, k),
    ),
  );
  const skipped = KNOWN_COLLECTION_KEYS.filter((k) => !present.has(k));

  const {
    filaments = [],
    nozzles = [],
    printers = [],
    bedTypes = [],
    locations = [],
    printHistory = [],
    sharedCatalogs = [],
  } = cols;

  // GH #1004 F2(b): pre-validate EVERY incoming doc BEFORE the destructive
  // wipe. Real installs carry legacy docs that fail CURRENT schema
  // validation, so a snapshot of one's own DB could previously
  // wipe-then-fail-then-rollback every time; validating up front turns that
  // into a clean 400 with the DB untouched. The rollback path below remains
  // reachable only for driver-level errors (duplicate keys inside the file,
  // BSON limits).
  const UNIQUE_NAME_COLLECTIONS = new Set([
    "nozzles",
    "printers",
    "bedTypes",
    "locations",
    "filaments",
  ]);
  const preValidate: Array<
    [string, { new (doc: Record<string, unknown>): { validate(): Promise<void> } }, unknown[]]
  > = [
    ["nozzles", Nozzle, nozzles],
    ["printers", Printer, printers],
    ["bedTypes", BedType, bedTypes],
    ["locations", Location, locations],
    ["filaments", Filament, filaments],
    ["printHistory", PrintHistory, printHistory],
    ["sharedCatalogs", SharedCatalog, sharedCatalogs],
  ];
  for (const [colName, Model, rows] of preValidate) {
    // GH #1116: `name` carries `trim: true` and the setter applies on
    // insertMany — a pre-trim snapshot legitimately holding both `X` and
    // `X ` would collapse to identical names and abort the ordered batch on
    // E11000 AFTER the wipe. State it up front, change nothing. Scoped to
    // the collections whose `name` is a UNIQUE key.
    const collision = UNIQUE_NAME_COLLECTIONS.has(colName)
      ? // Only `filaments` gets the `_purged` exemption: it is the one
        // unique-name collection this route re-tombstones before inserting.
        // The other four schemas don't declare `_purged` at all, so strict
        // mode strips it and the row inserts ACTIVE — exempting it there
        // would suppress a real collision and produce the post-wipe E11000
        // this check exists to replace.
        findTrimmedNameCollision(rows, colName === "filaments")
      : null;
    if (collision) {
      return NextResponse.json(
        {
          error: `Snapshot failed validation at ${colName}[${collision.indexes[1]}] — nothing was changed. It carries two active records whose names differ only by surrounding whitespace (${JSON.stringify(collision.name)}, also at index ${collision.indexes[0]}), which are now the same name. Rename or remove one and retry.`,
        },
        { status: 400 },
      );
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // A null / non-object element passes the array-shape check upstream,
      // but restoreTypes(null) → Object.entries(null) throws OUTSIDE the try
      // below — a 500 instead of the intended clean 400. Reject here.
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        return NextResponse.json(
          {
            error: `Snapshot failed validation at ${colName}[${i}] — expected an object, got ${row === null ? "null" : Array.isArray(row) ? "array" : typeof row}. Nothing was changed.`,
          },
          { status: 400 },
        );
      }
      const candidate = new Model(restoreTypes(row as Record<string, unknown>));
      try {
        await candidate.validate();
      } catch (validationErr) {
        const detail =
          validationErr instanceof Error ? validationErr.message : String(validationErr);
        return NextResponse.json(
          {
            error: `Snapshot failed validation at ${colName}[${i}] — nothing was changed. Fix the snapshot (or the offending record) and retry.`,
            detail,
          },
          { status: 400 },
        );
      }
    }
  }

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
    // Delete existing documents from each collection the snapshot CARRIES.
    //
    // GH #1104: wiping all seven unconditionally emptied Locations,
    // PrintHistory and SharedCatalog whenever a v2-era snapshot was restored
    // — dangling every spool's locationId and destroying every share link
    // under a green success message. Trade-off, stated plainly: better on
    // balance, not strictly better — _ids ARE preserved so refs resolve
    // whenever the target is in the file or a surviving collection, but e.g.
    // a nozzles-only file over surviving filaments can strand
    // `calibrations[].nozzle`. That is recoverable and visible; silently
    // losing every location and print job is neither. The response names
    // what was skipped.
    await Promise.all(
      SNAPSHOT_RESTORE_ORDER.filter((k) => present.has(k)).map((k) =>
        SNAPSHOT_MODELS[k].deleteMany({}),
      ),
    );

    // Insert snapshot data (order matters: reference targets before
    // referrers).
    //
    // GH #259: `insertMany` runs WITHOUT `lean: true` — `lean` skips
    // Mongoose hydration entirely (casting, schema validation, strict-mode
    // stripping), making restore an arbitrary-document-write primitive.
    //
    // And `ordered: true` (NOT false): with `ordered: false` Mongoose
    // inserts the valid subset and does NOT throw (default
    // `throwOnValidationError: false`), so an invalid snapshot would be
    // acknowledged as successful while silently dropping records.
    // `ordered: true` throws on the first invalid document and the catch
    // below rolls back — true all-or-nothing.
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
      // normalizePurgedTombstone applies to the three `_purged`-carrying
      // collections (Filament / PrintHistory / SharedCatalog).
      const docs = (filaments as Record<string, unknown>[]).map(restoreTypes).map(normalizePurgedTombstone);
      await Filament.insertMany(docs, { ordered: true });
      results.filaments = filaments.length;
    }

    if (printHistory.length > 0) {
      const docs = (printHistory as Record<string, unknown>[]).map(restoreTypes).map(normalizePurgedTombstone);
      await PrintHistory.insertMany(docs, { ordered: true });
      results.printHistory = printHistory.length;
    }

    if (sharedCatalogs.length > 0) {
      const docs = (sharedCatalogs as Record<string, unknown>[]).map(restoreTypes).map(normalizePurgedTombstone);
      await SharedCatalog.insertMany(docs, { ordered: true });
      results.sharedCatalogs = sharedCatalogs.length;
    }

    // GH #1021: snapshots don't carry `_migrations`, so a completed marker
    // would keep skipping the cleanup over freshly-restored PRE-upgrade
    // data. The snapshot's own provenance flag decides: post-cleanup backups
    // keep their pins (a byte-identical condition there is user input);
    // pre-cleanup/older backups get re-cleaned. Best-effort: a transient
    // failure leaves the process-local flag false so the next dbConnect
    // retries — the restore itself already succeeded.
    //
    // GH #1104: gated on the snapshot actually CARRYING filaments — ungated,
    // a pre-v5 locations-only restore would durably invalidate the one-shot
    // marker and re-judge UNTOUCHED live filaments (clearing legitimate
    // pins), while the v5+ branch would stamp `completed` over filaments
    // never cleaned, suppressing a legitimate future run. One gate covers
    // both.
    if (present.has("filaments")) {
      try {
        await rerunLegacyNozzleCleanupAfterRestore(snapshot.legacyNozzleCleanupComplete === true);
      } catch (cleanupErr) {
      // Two failure shapes: if the DURABLE marker state was never updated,
      // no later dbConnect (or restart) will re-run the cleanup — reporting
      // success would strand restored legacy conditions forever, so fail the
      // request and have the user run the (idempotent) restore again. A
      // failure AFTER the durable invalidation genuinely retries on the next
      // connect.
        if (cleanupErr instanceof RestoreCleanupInvalidationError) {
          console.error("[snapshot] Restore cleanup invalidation failed:", cleanupErr);
          return NextResponse.json(
            {
              error:
                "Snapshot data was restored, but the legacy nozzle-condition cleanup could not be scheduled. Run the restore again.",
            },
            { status: 500 },
          );
        }
        console.error(
          "[snapshot] Post-restore legacy nozzle-condition cleanup failed (dbConnect will retry):",
          cleanupErr,
        );
      }
    }

    return NextResponse.json({
      message: "Snapshot restored successfully",
      restored: results,
      // GH #1104: name the collections this file had no opinion about, so a
      // partial restore can't read as a full one.
      skipped,
    });
  } catch (err) {
    // --- Rollback: attempt to restore the pre-restore data ---
    try {
      // GH #1104: roll back only what the forward pass touched — destroying
      // and recreating untouched collections inside an error path risks a
      // second failure reporting "inconsistent state" for data this restore
      // was never going to change.
      await Promise.all(
        SNAPSHOT_RESTORE_ORDER.filter((k) => present.has(k)).map((k) =>
          SNAPSHOT_MODELS[k].deleteMany({}),
        ),
      );
      // GH #1004 F2(a): `lean: true` here — the backup docs came verbatim
      // from THIS database and never left the server, so #259's
      // untrusted-input rationale doesn't apply. Without it, Mongoose
      // re-validates against the CURRENT schema and silently SKIPS any
      // legacy doc that no longer validates while the response claims a full
      // rollback. Byte-identical reinsertion is the correct rollback
      // semantic; the count checks catch any residual silent-subset path.
      const rollbackInsert = async (
        name: string,
        model: { insertMany(docs: unknown[], opts: Record<string, unknown>): Promise<unknown[]> },
        backup: unknown[],
      ) => {
        if (backup.length === 0) return;
        const inserted = await model.insertMany(backup, { ordered: false, lean: true });
        if (inserted.length !== backup.length) {
          throw new Error(
            `rollback of ${name} restored ${inserted.length} of ${backup.length} documents`,
          );
        }
      };
      const backups: Record<(typeof SNAPSHOT_RESTORE_ORDER)[number], unknown[]> = {
        nozzles: backupNozzles,
        printers: backupPrinters,
        bedTypes: backupBedTypes,
        locations: backupLocations,
        filaments: backupFilaments,
        printHistory: backupPrintHistory,
        sharedCatalogs: backupSharedCatalogs,
      };
      for (const key of SNAPSHOT_RESTORE_ORDER) {
        if (!present.has(key)) continue;
        await rollbackInsert(key, SNAPSHOT_MODELS[key], backups[key]);
      }
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

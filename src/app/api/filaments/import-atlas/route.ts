import { NextRequest, NextResponse } from "next/server";
import { MongoClient } from "mongodb";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { assertSafeMongoUri } from "@/lib/mongoUriGuard";
import { validateSpoolPhotoDataUrl } from "@/lib/validateSpoolBody";

/**
 * GH #255: explicit ALLOW-LIST of filament fields that may be copied
 * from a remote Atlas document. The remote DB is whatever URI the
 * caller supplied — fully attacker-controlled — so spreading the remote
 * document and stripping a fixed deny-list let everything unlisted
 * through, including `syncId` / `instanceId` (a sync-engine collision /
 * takeover vector). Cross-DB ObjectId refs (`parentId`,
 * `compatibleNozzles`, `calibrations`) are deliberately NOT listed —
 * they point at the source database and are force-emptied below.
 */
const IMPORTABLE_FILAMENT_FIELDS = [
  "name", "vendor", "type", "color", "colorName", "cost", "density",
  "diameter", "temperatures", "bedTypeTemps", "maxVolumetricSpeed",
  "presets", "spools", "spoolWeight", "netFilamentWeight", "totalWeight",
  "lowStockThreshold", "dryingTemperature", "dryingTime",
  "transmissionDistance", "glassTempTransition", "heatDeflectionTemp",
  "shoreHardnessA", "shoreHardnessD", "shrinkageXY", "shrinkageZ",
  "minPrintSpeed", "maxPrintSpeed", "spoolType", "optTags", "tdsUrl",
  "inherits", "settings",
] as const;

// POST with { uri } — list filaments from remote Atlas
// POST with { uri, filaments: [...ids] } — import selected filaments
export async function POST(request: NextRequest) {
  // GH #252: this route connects to a caller-supplied MongoDB host and
  // can overwrite local filaments — reject cross-origin (CSRF) callers.
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

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

  // GH #254: SSRF guard — without this, a request body with
  // `uri: "mongodb://10.0.0.5:27017"` turns the server into an
  // internal-network port scanner. Importing from a remote Atlas
  // legitimately uses a public `mongodb+srv://` host, so require that
  // scheme and reject any host resolving to a private/internal address.
  try {
    await assertSafeMongoUri(uri, { requireSrv: true, blockPrivateHosts: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid connection string" },
      { status: 400 },
    );
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
        // GH #255: copy ONLY allow-listed fields from the (attacker-
        // controlled) remote document — `syncId` / `instanceId` /
        // `_purged` and any other unlisted key never make it through.
        const filamentData: Record<string, unknown> = {};
        for (const key of IMPORTABLE_FILAMENT_FIELDS) {
          if (remote[key] !== undefined) filamentData[key] = remote[key];
        }

        // Foreign-ObjectId references point at documents in the *source*
        // Atlas database and won't resolve locally. Set them to explicit
        // empty values (rather than omitting them) so an updateOne on an
        // existing row actually *clears* any previously-stored Atlas IDs.
        filamentData.parentId = null;
        filamentData.compatibleNozzles = [];
        filamentData.calibrations = [];
        if (Array.isArray(filamentData.spools)) {
          for (const s of filamentData.spools) {
            if (s && typeof s === "object") {
              const spool = s as Record<string, unknown>;
              spool.locationId = null;
              // GH #626: the remote document is attacker-controllable, and
              // spool photos here bypassed the MIME allow-list + 5MB cap
              // that the dedicated spool routes enforce via
              // validateSpoolBody (SVG is rejected because inline <script>
              // can execute in some rendering contexts). Sanitize rather
              // than reject — same posture as the ref force-emptying above,
              // and a legacy oversized photo in the user's own Atlas DB
              // shouldn't abort the whole import.
              const photo = validateSpoolPhotoDataUrl(spool.photoDataUrl);
              spool.photoDataUrl = photo.ok ? (photo.value ?? null) : null;
            }
          }
        }

        const importName = String(filamentData.name ?? "");
        const existing = await Filament.findOne({ name: importName, _deletedAt: null });
        if (existing) {
          // GH #255: runValidators so schema constraints (cost.min, etc.)
          // are enforced on the update path, not just on create.
          await Filament.updateOne(
            { _id: existing._id },
            filamentData,
            { runValidators: true, context: "query" },
          );
          updated++;
        } else {
          // If a soft-deleted doc with the same name exists, resurrect it.
          //
          // GH #499: filter on `_purged: { $ne: true }` to match every
          // other resurrection path (filament-import, bambustudio,
          // restore, prusaslicer). A `_purged: true` doc is the v1.15
          // permanent-delete tombstone — a one-way "gone forever on both
          // peers" signal documented on the Filament model. Without this
          // filter, an Atlas import containing a name that the user
          // permanent-deleted locally would flip `_deletedAt` back to
          // null while leaving `_purged: true` set — the row becomes
          // invisible everywhere (list / trash both filter on `_purged:
          // { $ne: true }`) but still occupies the name on the partial-
          // unique active-name index, so the user can't recreate it.
          const softDeleted = await Filament.findOne({
            name: importName,
            _deletedAt: { $ne: null },
            _purged: { $ne: true },
          });
          if (softDeleted) {
            await Filament.updateOne(
              { _id: softDeleted._id },
              { ...filamentData, _deletedAt: null },
              { runValidators: true, context: "query" },
            );
            updated++;
          } else {
              // The partial-unique index on `name` is filtered to
            // `_deletedAt: null`, and `_purged` rows by definition have
            // `_deletedAt != null` (the permanent-delete handler keeps
            // the tombstone date set), so a `_purged` row owning this
            // name doesn't block the create below.
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

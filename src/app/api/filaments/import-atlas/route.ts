import { NextRequest, NextResponse } from "next/server";
import { MongoClient, type ObjectId as ObjectIdType } from "mongodb";
import dbConnect from "@/lib/mongodb";
import Filament, { generateInstanceId } from "@/models/Filament";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { assertSafeMongoUri } from "@/lib/mongoUriGuard";
import { validateSpoolPhotoDataUrl } from "@/lib/validateSpoolBody";
import { hasVariants } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import {
  deriveLegacyNozzleCondition,
  LEGACY_NOZZLE_CONDITION_RE,
} from "@/lib/legacyNozzleConditions";

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

  // GH #627 item 1: cap the per-request id count — every sibling bulk
  // endpoint enforces one (openprinttag/import: 500, share: 500,
  // print-history: 100) but this one looped an unbounded id list through
  // sequential findOne/updateOne/create round-trips. Checked BEFORE the
  // SSRF guard / remote connect so an oversized request never touches
  // the network.
  const MAX_IMPORT_IDS = 1_000;
  if (Array.isArray(body.filamentIds) && body.filamentIds.length > MAX_IMPORT_IDS) {
    return NextResponse.json(
      { error: `Too many filament IDs (max ${MAX_IMPORT_IDS})` },
      { status: 400 },
    );
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
      // GH #605 (codex round 3 sweep): per-row notes for content the import
      // refused to apply (remote spools aimed at a local template). The row
      // itself still imports — only the offending payload is skipped.
      const errors: string[] = [];

      for (const remote of remoteFilaments) {
        // GH #255: copy ONLY allow-listed fields from the (attacker-
        // controlled) remote document — `syncId` / `instanceId` /
        // `_purged` and any other unlisted key never make it through.
        const filamentData: Record<string, unknown> = {};
        for (const key of IMPORTABLE_FILAMENT_FIELDS) {
          if (remote[key] !== undefined) filamentData[key] = remote[key];
        }

        // GH #1021 (Codex P1 r20): a pre-#1022 source Atlas can carry the
        // stamped machine condition in the allow-listed `settings` bag — and
        // the local one-shot marker is already completed, so nothing later
        // catches it. The provenance lives in the SOURCE database's nozzle
        // refs, which the block below is about to discard — so resolve them
        // against the SOURCE db first (own refs, else the ACTIVE source
        // parent's) and strip a provenance-matching value into the cloned
        // bag. A non-matching pure nozzle condition imports as a user pin;
        // the source Atlas itself stays read-only by contract (its own
        // deployment's migration owns cleaning it).
        const importedSettings = filamentData.settings;
        if (
          importedSettings &&
          typeof importedSettings === "object" &&
          !Array.isArray(importedSettings)
        ) {
          const cond = (importedSettings as Record<string, unknown>).compatible_printers_condition;
          if (typeof cond === "string" && LEGACY_NOZZLE_CONDITION_RE.test(cond)) {
            let refs: unknown[] | null =
              Array.isArray(remote.compatibleNozzles) && remote.compatibleNozzles.length > 0
                ? (remote.compatibleNozzles as unknown[])
                : null;
            if (!refs && remote.parentId != null) {
              const srcParent = await db
                .collection("filaments")
                .findOne(
                  { _id: remote.parentId, _deletedAt: null },
                  { projection: { compatibleNozzles: 1 } },
                );
              refs =
                Array.isArray(srcParent?.compatibleNozzles) && srcParent.compatibleNozzles.length > 0
                  ? (srcParent.compatibleNozzles as unknown[])
                  : null;
            }
            if (refs) {
              const nozzleDocs = await db
                .collection("nozzles")
                .find(
                  { _id: { $in: refs as ObjectIdType[] } },
                  { projection: { _id: 1, diameter: 1 } },
                )
                .toArray();
              if (deriveLegacyNozzleCondition(nozzleDocs) === cond) {
                filamentData.settings = {
                  ...(importedSettings as Record<string, unknown>),
                  compatible_printers_condition: "",
                };
              }
            }
          }
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
              // GH #732: the top-level `instanceId` is already excluded from
              // IMPORTABLE_FILAMENT_FIELDS so a remote can't spoof a filament
              // identity. The spool `instanceId` rides inside the allow-listed
              // `spools` array, so regenerate it locally — otherwise an
              // attacker-controlled / unrelated Atlas DB could persist duplicate
              // or spoofed spool identities that Phase 2 will match labels/NFC
              // against.
              spool.instanceId = generateInstanceId();
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

        // GH #732: on an UPDATE the whole spools array is replaced, so reuse
        // the EXISTING LOCAL spool instanceId by position rather than the
        // freshly-minted one — otherwise a routine re-import from Atlas would
        // rotate the durable spool identity every time and orphan any
        // label/NFC/match that stored the prior id. New positions (beyond the
        // local count) keep their minted id; the remote's id is never trusted
        // (anti-spoofing, GH #732 round 2). Matching is positional because
        // spool subdocs have no stable cross-side id (the deferred spool-syncId
        // migration — same limitation as amsSlots[].spoolId).
        const preserveLocalSpoolIds = (
          localSpools: Array<{ instanceId?: string }> | undefined,
        ) => {
          if (!Array.isArray(filamentData.spools) || !Array.isArray(localSpools)) return;
          for (let i = 0; i < filamentData.spools.length; i++) {
            const localId = localSpools[i]?.instanceId;
            if (localId) {
              (filamentData.spools[i] as Record<string, unknown>).instanceId = localId;
            }
          }
        };

        const importName = String(filamentData.name ?? "");
        const existing = await Filament.findOne({ name: importName, _deletedAt: null });
        if (existing) {
          preserveLocalSpoolIds(existing.spools);
          // GH #605 (codex round 3 sweep): when the LOCAL row is a TEMPLATE
          // (it has live color variants), the remote's spools must not be
          // written onto it — a template holds no inventory. Drop only the
          // `spools` key (the rest of the update still applies, and the
          // local spool state stays untouched) and report it per-row; an
          // import can't confirm the alternative (a promotion). Decided and
          // written inside the same per-filament mutex the promotion gate
          // locks, so a concurrent first-variant promotion can't land
          // between the check and the update and have this write re-attach
          // the just-moved inventory.
          await runExclusive(filamentLockKey(existing._id), async () => {
            const remoteSpools = filamentData.spools;
            const carriesSpools = Array.isArray(remoteSpools) && remoteSpools.length > 0;
            // `totalWeight` is the OTHER inventory field (legacy pre-spools
            // tracking) and is allow-listed above — PUT strips exactly a
            // non-null totalWeight on templates, so this path must too or
            // a re-import would re-attach legacy inventory the promotion
            // just moved off. An explicit remote null still applies
            // (clearing a legacy leftover is legitimate cleanup — same
            // posture as PUT).
            const carriesTotalWeight = filamentData.totalWeight != null;
            if (
              (carriesSpools || carriesTotalWeight) &&
              (await hasVariants(Filament, String(existing._id)))
            ) {
              const droppedParts: string[] = [];
              if (carriesSpools) {
                delete filamentData.spools;
                droppedParts.push(`${(remoteSpools as unknown[]).length} spool(s)`);
              }
              if (carriesTotalWeight) {
                delete filamentData.totalWeight;
                droppedParts.push("a tracked total weight");
              }
              errors.push(
                `${importName}: skipped ${droppedParts.join(" and ")} — the local filament is a template (inventory lives on its variants)`,
              );
            }
            // GH #255: runValidators so schema constraints (cost.min, etc.)
            // are enforced on the update path, not just on create.
            await Filament.updateOne(
              { _id: existing._id },
              filamentData,
              { runValidators: true, context: "query" },
            );
          });
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
            // GH #605 sweep: no template check needed on the resurrect — a
            // trashed doc cannot have live variants (soft-deleting a parent
            // with variants is refused; restoring a variant under a trashed
            // parent is refused; variant creation requires an ACTIVE
            // parent), so the revived row is never a template at this
            // write. The create below is a fresh doc — same reasoning.
            preserveLocalSpoolIds(softDeleted.spools);
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

      let message = `Imported ${remoteFilaments.length} filament${remoteFilaments.length !== 1 ? "s" : ""} (${created} new, ${updated} updated)`;
      if (errors.length > 0) message += `. ${errors.length} note(s).`;
      return NextResponse.json({
        message,
        total: remoteFilaments.length,
        created,
        updated,
        // Same optional shape the OpenPrintTag importer uses.
        errors: errors.length > 0 ? errors : undefined,
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

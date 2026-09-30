import { NextRequest, NextResponse } from "next/server";
import { MongoClient, type ObjectId as ObjectIdType } from "mongodb";
import type { Types } from "mongoose";
import dbConnect from "@/lib/mongodb";
import Filament, { generateInstanceId } from "@/models/Filament";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { assertSafeMongoUri } from "@/lib/mongoUriGuard";
import { validateSpoolPhotoDataUrl } from "@/lib/validateSpoolBody";
import Printer from "@/models/Printer";
import { assignSpoolToSlot } from "@/lib/spoolSlots";
import {
  keyRemoteSpools,
  reconcileImportedSpools,
  type KeyedRemoteSpool,
  type LocalSpool,
} from "@/lib/atlasSpoolReconcile";
import { hasVariants } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import {
  deriveLegacyNozzleCondition,
  LEGACY_NOZZLE_CONDITION_RE,
} from "@/lib/legacyNozzleConditions";
import { castNameLikeSchema } from "@/lib/trimEntityNames";
import {
  findByTrimmedName,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";

/**
 * GH #255: explicit ALLOW-LIST of filament fields copyable from a remote
 * Atlas document. The remote DB is attacker-controlled (caller-supplied
 * URI), so a deny-list would let unlisted keys through — including
 * `syncId` / `instanceId` (a sync-engine collision / takeover vector).
 * Cross-DB ObjectId refs (`parentId`, `compatibleNozzles`, `calibrations`)
 * are deliberately NOT listed — they point at the source database and are
 * force-emptied below.
 */
const IMPORTABLE_FILAMENT_FIELDS = [
  "name", "vendor", "type", "color", "secondaryColors", "colorName", "cost", "density",
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

  // GH #627: cap the per-request id count (the loop does sequential
  // round-trips per id). Checked BEFORE the SSRF guard / remote connect so
  // an oversized request never touches the network.
  const MAX_IMPORT_IDS = 1_000;
  if (Array.isArray(body.filamentIds) && body.filamentIds.length > MAX_IMPORT_IDS) {
    return NextResponse.json(
      { error: `Too many filament IDs (max ${MAX_IMPORT_IDS})` },
      { status: 400 },
    );
  }

  // GH #254: SSRF guard — a `uri: "mongodb://10.0.0.5:27017"` would turn
  // the server into an internal-network port scanner. Require the public
  // `mongodb+srv://` scheme and reject private/internal hosts.
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
      // GH #605: per-row notes for content the import refused to apply; the
      // row itself still imports.
      const errors: string[] = [];
      const failures: string[] = [];

      for (const remote of remoteFilaments) {
        try {
          // GH #255: copy ONLY allow-listed fields — `syncId` / `instanceId` /
          // `_purged` and any other unlisted key never make it through.
          const filamentData: Record<string, unknown> = {};
          for (const key of IMPORTABLE_FILAMENT_FIELDS) {
            if (remote[key] !== undefined) filamentData[key] = remote[key];
          }

          // GH #1213: a coextruded/gradient filament keeps its colors in
          // `secondaryColors` with a null primary, so dropping the field
          // imported it colorless (and left a re-import's stale secondaries in
          // place). The remote is caller-supplied, so keep only what the schema
          // would accept — up to five `#RRGGBB` strings — rather than letting
          // one malformed entry fail the write. An explicit `[]` clears the
          // local array; a value that is not an array, or an array with no
          // valid entry at all, is not a clear and leaves the local one alone.
          if ("secondaryColors" in filamentData) {
            const raw = filamentData.secondaryColors;
            if (!Array.isArray(raw)) {
              delete filamentData.secondaryColors;
            } else {
              const clean = raw
                .filter((c): c is string => typeof c === "string" && /^#[0-9A-Fa-f]{6}$/.test(c))
                .slice(0, 5);
              if (raw.length > 0 && clean.length === 0) {
                delete filamentData.secondaryColors;
              } else {
                filamentData.secondaryColors = clean;
              }
              if (clean.length !== raw.length) {
                errors.push(
                  `${String(remote.name)}: skipped ${raw.length - clean.length} invalid or excess secondary color(s)`,
                );
              }
            }
          }

          // GH #1021: a pre-#1022 source Atlas can carry the stamped machine
          // condition in the allow-listed `settings` bag — the local one-shot
          // marker is already completed, so nothing later catches it. The
          // provenance lives in the SOURCE database's nozzle refs (which the
          // block below discards), so resolve them against the SOURCE db first
          // (own refs, else the ACTIVE source parent's) and strip a
          // provenance-matching value. A non-matching pure nozzle condition
          // imports as a user pin; the source Atlas stays read-only by
          // contract.
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

          // Foreign-ObjectId refs point at the *source* database and won't
          // resolve locally. Set explicit empty values (not omit) so an
          // updateOne actually *clears* any previously-stored Atlas IDs.
          filamentData.parentId = null;
          filamentData.compatibleNozzles = [];
          filamentData.calibrations = [];

          // GH #1209: spools are MERGED into the local ones by `_id` (see
          // src/lib/atlasSpoolReconcile.ts), never swapped in wholesale — that
          // replaced every local spool `_id` and left printer slots,
          // print-history refunds and `?spool=` links naming subdocuments that
          // no longer existed. A `spools` value that isn't an array carries no
          // spools and leaves the local ones alone.
          let remoteSpools: KeyedRemoteSpool[] | null = null;
          if (Array.isArray(filamentData.spools)) {
            const keyed = keyRemoteSpools(filamentData.spools, String(remote._id));
            for (const { spool } of keyed.entries) {
              // GH #626: enforce the MIME allow-list + 5MB cap the spool
              // routes apply (SVG rejected — inline <script> can execute in
              // some rendering contexts). Sanitize rather than reject — a
              // legacy oversized photo in the user's own Atlas DB shouldn't
              // abort the whole import.
              // Only when the source carries the key: under the #1209 merge
              // an omitted photo keeps the local spool's.
              if (spool.photoDataUrl !== undefined) {
                const photo = validateSpoolPhotoDataUrl(spool.photoDataUrl);
                spool.photoDataUrl = photo.ok ? (photo.value ?? null) : null;
              }
            }
            remoteSpools = keyed.entries;
            if (keyed.dropped > 0) {
              errors.push(
                `${String(remote.name)}: skipped ${keyed.dropped} malformed or duplicate spool(s) in the source`,
              );
            }
          }
          delete filamentData.spools;

          // GH #1116: normalize the SOURCE name at the boundary. Not
          // load-bearing today (the Mongoose setter casts the query below),
          // but written explicitly because that behaviour is invisible — this
          // repo moves hot lookups to the raw driver routinely, and the day
          // this query moves the trim would silently stop applying (an older
          // Atlas source holding `"PLA Basic "` would miss the local row, fall
          // through to create, and E11000 on the setter).
          //
          // ONLY values the String schema itself accepts: a blanket
          // `String(...)` would MANUFACTURE a legal name out of one Mongoose
          // would have rejected — an array `["Victim"]` stringifies to
          // `Victim` and would select and overwrite the local `Victim` row. A
          // non-castable name is left exactly as it arrived, for the
          // update/create below to reject.
          const castName = castNameLikeSchema(filamentData.name);
          const importName = castName === null ? "" : castName.trim();
          if (castName !== null) filamentData.name = importName;

          // Merge the source spools into `localSpools` (the target's own, read
          // under its key; empty on a create) and set the result on
          // filamentData. Returns the notes for the user and the matched spools
          // retired after the merge; the caller clears their printer slots once
          // its write has landed.
          const mergeSpools = async (
            localSpools: readonly LocalSpool[],
            targetId: Types.ObjectId | null,
          ): Promise<{ notes: string[]; retiredIds: string[] }> => {
            if (!remoteSpools) return { notes: [], retiredIds: [] };
            // A source spool whose `_id` another local filament already holds
            // would give one roll two owners. Trashed rows count (restoring
            // one would surface the second owner); purged tombstones don't.
            // One `$in` per row — there is no index on `spools._id`.
            const ids = remoteSpools.map((e) => e.id);
            const owners =
              ids.length === 0
                ? []
                : await Filament.find(
                    {
                      ...(targetId != null ? { _id: { $ne: targetId } } : {}),
                      _purged: { $ne: true },
                      "spools._id": { $in: ids },
                    },
                    { "spools._id": 1 },
                  ).lean();
            const wanted = new Set(ids);
            const ownedElsewhere = new Set<string>();
            for (const owner of owners) {
              for (const sp of owner.spools ?? []) {
                const id = String(sp._id).toLowerCase();
                if (wanted.has(id)) ownedElsewhere.add(id);
              }
            }
            const r = reconcileImportedSpools(
              remoteSpools,
              localSpools,
              ownedElsewhere,
              generateInstanceId,
            );
            filamentData.spools = r.spools;
            const notes: string[] = [];
            if (r.keptLocal > 0) {
              notes.push(
                `${importName}: kept ${r.keptLocal} local spool(s) the source doesn't have — delete any that duplicate an imported roll`,
              );
            }
            if (r.skippedOwned > 0) {
              notes.push(
                `${importName}: skipped ${r.skippedOwned} spool(s) another local filament already holds`,
              );
            }
            return { notes, retiredIds: r.retiredIds };
          };
          // A retired spool can't stay loaded in a printer slot (GH #268 —
          // every later printer save would 400), same as a retire through the
          // spool route. Idempotent, so every import repairs a slot an earlier
          // import's interrupted cleanup left behind.
          const clearRetiredFromSlots = async (ids: readonly string[]) => {
            for (const id of ids) await assignSpoolToSlot(Printer, id, null);
          };
          let existing = await Filament.findOne({ name: importName, _deletedAt: null });
          if (!existing && importName !== "") {
            // GH #1116: the miss may be a LOOKUP failure, not an absence — the
            // setter casts this query, so it cannot select an untrimmed
            // survivor, and falling through to create would mint a second
            // active filament rendering identically. Re-hydrate by `_id`, the
            // one key casting cannot break.
            const survivor = await findByTrimmedName(
              Filament.collection as unknown as MinimalNameCollection,
              importName,
              { _deletedAt: null },
            );
            if (survivor) {
              existing = await Filament.findOne({
                _id: survivor._id as Parameters<typeof Filament.findById>[0],
                _deletedAt: null,
              });
            }
          }
          if (existing) {
            const existingId = existing._id;
            let merged: { notes: string[]; retiredIds: string[] } = { notes: [], retiredIds: [] };
            // GH #605: when the LOCAL row is a TEMPLATE, the remote's
            // per-variant state must not be written onto it. PUT-parity rule:
            // whatever the PUT handler strips on templates (the shared
            // TEMPLATE_STRIP_FIELDS in src/lib/templateStrip.ts, also used by
            // every slicer sync route), this path drops — keep this inline
            // mirror in lockstep (it stays hand-rolled for its per-field
            // human-readable notes and the extra `spools` guard the shared
            // list doesn't carry). Drop only the offending keys (the rest of
            // the update still applies) and report per-row; an import can't
            // confirm the alternative (a promotion). Explicit remote nulls
            // still apply (same posture as PUT). Decided and written inside
            // the same per-filament mutex the promotion gate locks, so a
            // concurrent first-variant promotion can't land between the check
            // and the update.
            await runExclusive(filamentLockKey(existingId), async () => {
              const carriesSpools = remoteSpools != null && remoteSpools.length > 0;
              const carriesTotalWeight = filamentData.totalWeight != null;
              const carriesColor = filamentData.color != null;
              const carriesColorName = filamentData.colorName != null;
              const carriesLowStock = filamentData.lowStockThreshold != null;
              if (
                (carriesSpools ||
                  carriesTotalWeight ||
                  carriesColor ||
                  carriesColorName ||
                  carriesLowStock) &&
                (await hasVariants(Filament, String(existing._id)))
              ) {
                const droppedParts: string[] = [];
                if (carriesSpools) {
                  droppedParts.push(`${remoteSpools!.length} spool(s)`);
                  remoteSpools = null;
                }
                if (carriesTotalWeight) {
                  delete filamentData.totalWeight;
                  droppedParts.push("a tracked total weight");
                }
                if (carriesColor) {
                  delete filamentData.color;
                  droppedParts.push("a color");
                }
                if (carriesColorName) {
                  delete filamentData.colorName;
                  droppedParts.push("a color name");
                }
                if (carriesLowStock) {
                  delete filamentData.lowStockThreshold;
                  droppedParts.push("a low-stock threshold");
                }
                errors.push(
                  `${importName}: skipped ${droppedParts.join(" and ")} — the local filament is a template (inventory and color live on its variants)`,
                );
              }
              // GH #1209: merge into the spools as they are NOW — `existing`
              // was read before this key was held.
              const current = await Filament.findById(existingId).select("spools").lean();
              merged = await mergeSpools((current?.spools ?? []) as unknown as LocalSpool[], existingId);
              // GH #255: runValidators so schema constraints (cost.min, etc.)
              // are enforced on the update path, not just on create. An array
              // rewrite doesn't move `__v` by itself, so bump it: a document
              // hydrated before this write must not positionally save over it
              // (the promoteParent.ts precedent).
              await Filament.updateOne(
                { _id: existingId },
                { $set: filamentData, ...(filamentData.spools ? { $inc: { __v: 1 } } : {}) },
                { runValidators: true, context: "query" },
              );
            });
            errors.push(...merged.notes);
            updated++;
            await clearRetiredFromSlots(merged.retiredIds);
          } else {
            // If a soft-deleted doc with the same name exists, resurrect it.
            // GH #499: filter on `_purged: { $ne: true }` like every other
            // resurrection path — `_purged` is the one-way permanent-delete
            // tombstone, and resurrecting it would flip `_deletedAt` back to
            // null while leaving `_purged: true`: invisible everywhere yet
            // still occupying the name on the partial-unique index.
            let softDeleted = await Filament.findOne({
              name: importName,
              _deletedAt: { $ne: null },
              _purged: { $ne: true },
            });
            if (!softDeleted && importName !== "") {
              // Same lookup failure, one state over. Missing an untrimmed
              // TOMBSTONE doesn't immediately duplicate (the partial unique
              // index only covers active rows) but defers it: restoring that
              // tombstone later flips only `_deletedAt`, leaving its raw name
              // intact — two ACTIVE rows rendering identically. Resurrect the
              // row that is actually there instead.
              const survivor = await findByTrimmedName(
                Filament.collection as unknown as MinimalNameCollection,
                importName,
                { _deletedAt: { $ne: null }, _purged: { $ne: true } },
              );
              if (survivor) {
                softDeleted = await Filament.findOne({
                  _id: survivor._id as Parameters<typeof Filament.findById>[0],
                  _deletedAt: { $ne: null },
                  _purged: { $ne: true },
                });
              }
            }
            if (softDeleted) {
              // GH #605: no template check needed on the resurrect — a trashed
              // doc cannot have live variants (soft-deleting a parent with
              // variants is refused under the same per-filament mutex the
              // first-variant gates lock; restoring a variant under a trashed
              // parent is refused; variant creation requires an ACTIVE
              // parent). The create below is a fresh doc — same reasoning.
              // GH #1079: a permanent delete can land BETWEEN the findOne
              // above and this write. An unguarded update would flip
              // `_deletedAt: null` on a row whose `_purged: true` was just
              // set, minting the active-but-purged "zombie" #1004 F1 exists to
              // prevent. Re-assert the tombstone check on the WRITE, mirroring
              // the resurrect guard in src/lib/importFilaments.ts; a
              // zero-match falls through to a fresh create.
              //
              // GH #1209: the source spools merge into the tombstone's own,
              // read fresh under its key like the update path.
              const tombstoneId = softDeleted._id;
              let merged: { notes: string[]; retiredIds: string[] } = { notes: [], retiredIds: [] };
              const resurrected = await runExclusive(filamentLockKey(tombstoneId), async () => {
                const current = await Filament.findOne({ _id: tombstoneId, _purged: { $ne: true } })
                  .select("spools")
                  .lean();
                merged = await mergeSpools((current?.spools ?? []) as unknown as LocalSpool[], tombstoneId);
                const res = await Filament.updateOne(
                  { _id: tombstoneId, _purged: { $ne: true } },
                  {
                    $set: { ...filamentData, _deletedAt: null },
                    ...(filamentData.spools ? { $inc: { __v: 1 } } : {}),
                  },
                  { runValidators: true, context: "query" },
                );
                return res.matchedCount > 0;
              });
              if (!resurrected) {
                // The tombstone was purged mid-import — mint a fresh doc (the
                // partial-unique name index permits it; the purged row keeps
                // `_deletedAt` set). Its spools come from the SOURCE alone: a
                // merged array would hand it the tombstone's spool identities.
                merged = await mergeSpools([], null);
                await Filament.create(filamentData);
                created++;
              } else {
                updated++;
              }
              errors.push(...merged.notes);
              await clearRetiredFromSlots(merged.retiredIds);
            } else {
              // The partial-unique index on `name` covers `_deletedAt: null`
              // only, and `_purged` rows keep `_deletedAt` set — so a
              // `_purged` row owning this name doesn't block the create.
              const merged = await mergeSpools([], null);
              await Filament.create(filamentData);
              errors.push(...merged.notes);
              created++;
            }
          }
        } catch (rowErr) {
          // One bad row (a source value the schema rejects, a legacy local
          // spool that no longer validates) must not abort the batch after
          // the rows before it were already written — record it and go on.
          failures.push(
            `${String(remote.name ?? remote._id)}: not imported — ${rowErr instanceof Error ? rowErr.message : String(rowErr)}`,
          );
        }
      }

      const imported = created + updated;
      if (imported === 0 && failures.length > 0) {
        // Nothing landed: answer as the whole request failing, as a
        // single-row import always did.
        const safe = failures[0].replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "mongodb://***");
        return NextResponse.json({ error: safe }, { status: 500 });
      }
      errors.push(...failures);
      let message = `Imported ${imported} filament${imported !== 1 ? "s" : ""} (${created} new, ${updated} updated)`;
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

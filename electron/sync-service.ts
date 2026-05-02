import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { MongoClient, ObjectId, Document } from "mongodb";

/**
 * Extract the database name from a MongoDB connection URI.
 *
 * The DB name is the path segment after the authority:
 *   mongodb+srv://user:pass@cluster.mongodb.net/my-db?retryWrites=true
 *                                                └─ "my-db"
 *
 * Falls back to "filament-db" if the URI has no explicit DB path, matching
 * the app's historical default so upgrading users keep working against the
 * same database.
 */
export function getDbNameFromUri(uri: string): string {
  try {
    // Normalise scheme so the URL parser accepts mongodb[+srv]:// URIs
    const normalised = uri.replace(/^mongodb(\+srv)?:\/\//, "http://");
    const url = new URL(normalised);
    const db = url.pathname.replace(/^\//, "");
    return db || "filament-db";
  } catch {
    return "filament-db";
  }
}

export interface SyncStatus {
  state: "idle" | "syncing" | "error" | "offline";
  lastSyncAt: string | null;
  error: string | null;
  progress: string | null;
}

interface SyncResult {
  collection: string;
  pushed: number;
  pulled: number;
  updated: number;
  deleted: number;
}

/**
 * Bidirectional sync engine between local MongoDB and Atlas.
 * Uses last-write-wins conflict resolution based on updatedAt timestamps.
 * Nozzles, printers, locations, and bedtypes are synced first so filaments
 * (and their embedded spools) can have their references remapped onto the
 * target DB's IDs. Printhistories and sharedcatalogs sync after filaments.
 *
 * Known limitation: spool subdocuments inside Filament don't have stable
 * cross-side identifiers. Anything that references a spool by id —
 * printer.amsSlots[].spoolId, printhistory.usage[].spoolId — clears that
 * id during cross-side remap. Per-filament gram totals still reconcile;
 * per-spool attribution is dropped pending a spool-syncId migration.
 */
export class SyncService extends EventEmitter {
  private localUri: string;
  private atlasUri: string;
  private status: SyncStatus = {
    state: "idle",
    lastSyncAt: null,
    error: null,
    progress: null,
  };
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(localUri: string, atlasUri: string) {
    super();
    this.localUri = localUri;
    this.atlasUri = atlasUri;
  }

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  private updateStatus(partial: Partial<SyncStatus>) {
    Object.assign(this.status, partial);
    this.emit("statusChange", this.getStatus());
  }

  /**
   * Test if Atlas is reachable.
   */
  async checkAtlasConnectivity(): Promise<boolean> {
    const client = new MongoClient(this.atlasUri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    try {
      await client.connect();
      await client.db(getDbNameFromUri(this.atlasUri)).command({ ping: 1 });
      return true;
    } catch {
      return false;
    } finally {
      await client.close();
    }
  }

  /**
   * Start periodic sync (every intervalMs, default 5 minutes).
   */
  startPeriodicSync(intervalMs = 5 * 60 * 1000) {
    this.stopPeriodicSync();
    // Run immediately, then on interval
    this.sync().catch((err) => console.error("Periodic sync failed:", err));
    this.intervalId = setInterval(() => {
      this.sync().catch((err) => console.error("Periodic sync failed:", err));
    }, intervalMs);
  }

  stopPeriodicSync() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Run a full bidirectional sync cycle.
   */
  async sync(): Promise<SyncResult[]> {
    if (this.syncing) return [];
    this.syncing = true;
    this.updateStatus({ state: "syncing", error: null, progress: "Connecting to Atlas..." });

    const local = new MongoClient(this.localUri);
    const remote = new MongoClient(this.atlasUri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    try {
      await local.connect();
      await remote.connect();

      const localDb = local.db(getDbNameFromUri(this.localUri));
      const remoteDb = remote.db(getDbNameFromUri(this.atlasUri));

      // Sync nozzles first (filaments and printers reference them)
      this.updateStatus({ progress: "Syncing nozzles..." });
      const nozzleResult = await this.syncCollection(localDb, remoteDb, "nozzles");

      // Build nozzle syncId→ID maps for reference remapping
      const localNozzles = await localDb.collection("nozzles").find({ _deletedAt: null }).toArray();
      const remoteNozzles = await remoteDb.collection("nozzles").find({ _deletedAt: null }).toArray();
      const localNozzleBySyncId = new Map(localNozzles.filter(n => n.syncId).map(n => [n.syncId as string, n._id]));
      const remoteNozzleBySyncId = new Map(remoteNozzles.filter(n => n.syncId).map(n => [n.syncId as string, n._id]));

      // Sync printers (filament calibrations reference them)
      this.updateStatus({ progress: "Syncing printers..." });
      const printerResult = await this.syncCollection(
        localDb, remoteDb, "printers",
        (doc, direction) => this.remapPrinterRefs(doc, direction, localNozzleBySyncId, remoteNozzleBySyncId)
      );

      // Build printer syncId→ID maps for filament calibration reference remapping
      const localPrinters = await localDb.collection("printers").find({ _deletedAt: null }).toArray();
      const remotePrinters = await remoteDb.collection("printers").find({ _deletedAt: null }).toArray();
      const localPrinterBySyncId = new Map(localPrinters.filter(p => p.syncId).map(p => [p.syncId as string, p._id]));
      const remotePrinterBySyncId = new Map(remotePrinters.filter(p => p.syncId).map(p => [p.syncId as string, p._id]));

      // Sync locations before filaments so spool.locationId can be remapped.
      // Locations are referenced from filaments[].spools[].locationId — a
      // missing remap would either drop the reference or, worse, point at a
      // wrong location on the target DB (GH #116).
      //
      // Reconcile by name first: locations existed on both sides before sync
      // was added (v1.11.3). On the very first sync each side has its own
      // locally-minted syncId, so a naive push would `insertOne` a row whose
      // name collides with the partial-unique index on Location and abort
      // the entire sync cycle. Pairing matching-name rows and unifying their
      // syncIds turns the duplicates into a no-op last-write-wins merge.
      this.updateStatus({ progress: "Syncing locations..." });
      await this.reconcileLocationsByName(localDb, remoteDb);
      const locationResult = await this.syncCollection(localDb, remoteDb, "locations");

      // Build location syncId→ID maps for spool reference remapping
      const localLocations = await localDb.collection("locations").find({ _deletedAt: null }).toArray();
      const remoteLocations = await remoteDb.collection("locations").find({ _deletedAt: null }).toArray();
      const localLocationBySyncId = new Map(localLocations.filter(l => l.syncId).map(l => [l.syncId as string, l._id]));
      const remoteLocationBySyncId = new Map(remoteLocations.filter(l => l.syncId).map(l => [l.syncId as string, l._id]));

      // Repair dangling spool.locationId references left behind by pre-#116
      // sync cycles. Filaments synced before the locationId remap landed
      // carry spools[].locationId values that point at the *other side's*
      // ObjectId (which obviously doesn't exist on this side). The normal
      // filament sync path can't fix them: those filaments often have equal
      // updatedAt on both sides, so syncCollection's last-write-wins skip
      // never re-runs the transform on them. Patch them in-place using the
      // freshly-built location maps; bumps updatedAt so subsequent syncs
      // notice the rewrite.
      await this.repairDanglingSpoolLocations(
        localDb, remoteDb, localLocationBySyncId, remoteLocationBySyncId,
      );

      // Sync bedtypes before filaments so calibrations[].bedType can be
      // remapped. Same partial-unique-name index trap as locations — bed
      // types existed before sync was added in this collection set, and
      // duplicate names on first sync would E11000 the cycle. Reconcile
      // by name first to unify the syncIds.
      this.updateStatus({ progress: "Syncing bed types..." });
      await this.reconcileBedTypesByName(localDb, remoteDb);
      const bedTypeResult = await this.syncCollection(localDb, remoteDb, "bedtypes");

      // Build bedType syncId→ID maps for filament calibration remap
      const localBedTypes = await localDb.collection("bedtypes").find({ _deletedAt: null }).toArray();
      const remoteBedTypes = await remoteDb.collection("bedtypes").find({ _deletedAt: null }).toArray();
      const localBedTypeBySyncId = new Map(localBedTypes.filter(b => b.syncId).map(b => [b.syncId as string, b._id]));
      const remoteBedTypeBySyncId = new Map(remoteBedTypes.filter(b => b.syncId).map(b => [b.syncId as string, b._id]));

      // Backfill filament syncIds before building maps (syncCollection does this too, but we need maps first)
      await this.backfillSyncIds(localDb.collection("filaments"));
      await this.backfillSyncIds(remoteDb.collection("filaments"));

      // Build filament syncId→ID maps for parentId remapping
      const localFilaments = await localDb.collection("filaments").find({}).toArray();
      const remoteFilaments = await remoteDb.collection("filaments").find({}).toArray();
      const localFilamentBySyncId = new Map(localFilaments.filter(f => f.syncId).map(f => [f.syncId as string, f._id]));
      const remoteFilamentBySyncId = new Map(remoteFilaments.filter(f => f.syncId).map(f => [f.syncId as string, f._id]));

      // Snapshot each side's pre-existing filaments as `_id → updatedAt(ms)`
      // so the post-sync repair pass can tell whether THIS sync cycle wrote
      // each row. Two shapes both qualify as "fair game to repair":
      //   (a) row not in snapshot at all → freshly inserted by this pull
      //       (the GH #128 fresh-install shape);
      //   (b) row in snapshot but updatedAt has changed → rewritten by
      //       this cycle's syncCollection update (the Codex P1 shape on
      //       PR #131: pre-existing variant whose parentId got nulled
      //       because the in-line transform's target map missed the parent
      //       that's about to be inserted later in the same cycle).
      // Anything else is a row this sync didn't touch — user territory,
      // leave alone (Codex P2 on PR #130 / v1.12.1).
      const localFilamentSnapshot = new Map<string, number | null>();
      for (const f of localFilaments) {
        const t = SyncService.readUpdatedAt(f);
        localFilamentSnapshot.set(f._id.toString(), t ?? null);
      }
      const remoteFilamentSnapshot = new Map<string, number | null>();
      for (const f of remoteFilaments) {
        const t = SyncService.readUpdatedAt(f);
        remoteFilamentSnapshot.set(f._id.toString(), t ?? null);
      }

      // Sync filaments with nozzle, printer, parent, spool-location, and
      // bedType remapping
      this.updateStatus({ progress: "Syncing filaments..." });
      const filamentTransform = this.buildFilamentRefsTransform(
        localNozzleBySyncId, remoteNozzleBySyncId,
        localPrinterBySyncId, remotePrinterBySyncId,
        localFilamentBySyncId, remoteFilamentBySyncId,
        localLocationBySyncId, remoteLocationBySyncId,
        localBedTypeBySyncId, remoteBedTypeBySyncId,
      );
      const filamentResult = await this.syncCollection(
        localDb, remoteDb, "filaments",
        filamentTransform,
      );

      // Repair filaments whose parentId was dropped (or stale) when the
      // syncCollection transform ran. The transform builds its target id
      // map BEFORE the sync inserts — so on a fresh install the local map
      // is empty and every variant's parentId gets nulled on first pull
      // (GH #128). Same shape can also happen for any newly-created
      // parent+variant pair pulled in the same cycle. This pass projects
      // the truth from the *other* side via syncId maps that are now
      // built against the post-sync state of both DBs.
      await this.repairFilamentParentIds(
        localDb, remoteDb,
        localFilamentSnapshot, remoteFilamentSnapshot,
      );

      // Rebuild filament syncId maps now that filament sync has settled —
      // both the printer amsSlots repair below and the print-history
      // transform need ids that exist on both sides post-sync.
      const lFilPost = await localDb.collection("filaments").find({}).toArray();
      const rFilPost = await remoteDb.collection("filaments").find({}).toArray();
      const localFilPostBySyncId = new Map(lFilPost.filter(f => f.syncId).map(f => [f.syncId as string, f._id]));
      const remoteFilPostBySyncId = new Map(rFilPost.filter(f => f.syncId).map(f => [f.syncId as string, f._id]));

      // Repair printer amsSlots[].filamentId refs. Printers sync runs
      // BEFORE filaments to break the calibrations[].printer ↔
      // amsSlots[].filamentId cycle, but that means the printer transform
      // can't remap amsSlots into filament ids that don't yet exist on
      // the target side. Patch them in-place now via the post-sync
      // filament syncId maps. amsSlots[].spoolId can't be remapped at
      // all without spool syncIds (a separate schema migration); it gets
      // cleared if the parent filamentId reference itself can't be
      // resolved, otherwise left alone.
      await this.repairPrinterAmsSlots(
        localDb, remoteDb,
        localFilPostBySyncId, remoteFilPostBySyncId,
      );

      // Sync print history. Top-level job ledger that references
      // printerId + usage[].filamentId. usage[].spoolId can't be remapped
      // (no spool syncIds) and is cleared on insert — the job total still
      // reconciles via filamentId + grams; the per-spool attribution is
      // dropped pending the spool-syncId migration.
      this.updateStatus({ progress: "Syncing print history..." });
      const printHistoryTransform = this.buildPrintHistoryTransform(
        localPrinterBySyncId, remotePrinterBySyncId,
        localFilPostBySyncId, remoteFilPostBySyncId,
      );
      const printHistoryResult = await this.syncCollection(
        localDb, remoteDb, "printhistories", printHistoryTransform,
      );

      // Sync shared catalogs. Payload is denormalised at publish time so
      // there are no outbound refs to remap — straight syncId-keyed
      // last-write-wins between the two sides.
      this.updateStatus({ progress: "Syncing shared catalogs..." });
      const sharedCatalogResult = await this.syncCollection(
        localDb, remoteDb, "sharedcatalogs",
      );

      const results = [
        nozzleResult, printerResult, locationResult, bedTypeResult,
        filamentResult, printHistoryResult, sharedCatalogResult,
      ];
      this.updateStatus({
        state: "idle",
        lastSyncAt: new Date().toISOString(),
        progress: null,
      });

      this.emit("syncComplete", results);
      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sync failed";
      const safe = message.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "mongodb://***");
      this.updateStatus({ state: "error", error: safe, progress: null });
      this.emit("syncError", safe);
      return [];
    } finally {
      this.syncing = false;
      await local.close();
      await remote.close();
    }
  }

  /**
   * Sync a single collection bidirectionally using syncId as the stable
   * cross-database identity key. Documents without a syncId get one
   * assigned automatically (UUID). This survives renames.
   */
  private async syncCollection(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
    collectionName: string,
    transformDoc?: (doc: Document, direction: "toLocal" | "toRemote") => Document,
  ): Promise<SyncResult> {
    const localCol = localDb.collection(collectionName);
    const remoteCol = remoteDb.collection(collectionName);

    // Backfill: assign syncId to any docs that don't have one yet
    await this.backfillSyncIds(localCol);
    await this.backfillSyncIds(remoteCol);

    // Fetch all docs (including soft-deleted) from both sides
    const localDocs = await localCol.find({}).toArray();
    const remoteDocs = await remoteCol.find({}).toArray();

    const localBySyncId = new Map(localDocs.filter(d => d.syncId).map(d => [d.syncId as string, d]));
    const remoteBySyncId = new Map(remoteDocs.filter(d => d.syncId).map(d => [d.syncId as string, d]));

    const result: SyncResult = { collection: collectionName, pushed: 0, pulled: 0, updated: 0, deleted: 0 };

    // Process all unique syncIds from both sides
    const allSyncIds = new Set([...localBySyncId.keys(), ...remoteBySyncId.keys()]);

    for (const syncId of allSyncIds) {
      const localDoc = localBySyncId.get(syncId);
      const remoteDoc = remoteBySyncId.get(syncId);

      if (localDoc && !remoteDoc) {
        // Local-only: push to remote
        const doc = this.stripForTransfer(localDoc);
        const transformed = transformDoc ? transformDoc(doc, "toRemote") : doc;
        await remoteCol.insertOne({ ...transformed, _id: new ObjectId() });
        result.pushed++;
      } else if (!localDoc && remoteDoc) {
        // Remote-only: pull to local
        const doc = this.stripForTransfer(remoteDoc);
        const transformed = transformDoc ? transformDoc(doc, "toLocal") : doc;
        await localCol.insertOne({ ...transformed, _id: new ObjectId() });
        result.pulled++;
      } else if (localDoc && remoteDoc) {
        // Both exist: handle conflicts
        const localDeleted = localDoc._deletedAt != null;
        const remoteDeleted = remoteDoc._deletedAt != null;

        if (localDeleted && remoteDeleted) {
          // Both deleted — nothing to do
          continue;
        }

        if (localDeleted && !remoteDeleted) {
          // Deleted locally — propagate if deletion is newer
          const localDeletedAt = new Date(localDoc._deletedAt).getTime();
          const remoteUpdatedAt = new Date(remoteDoc.updatedAt).getTime();
          if (localDeletedAt > remoteUpdatedAt) {
            await remoteCol.updateOne({ _id: remoteDoc._id }, { $set: { _deletedAt: localDoc._deletedAt } });
            result.deleted++;
          } else {
            // Remote was updated after local delete — resurrect locally
            const doc = this.stripForTransfer(remoteDoc);
            const transformed = transformDoc ? transformDoc(doc, "toLocal") : doc;
            await localCol.updateOne({ _id: localDoc._id }, { $set: { ...transformed, _deletedAt: null } });
            result.pulled++;
          }
          continue;
        }

        if (!localDeleted && remoteDeleted) {
          const remoteDeletedAt = new Date(remoteDoc._deletedAt).getTime();
          const localUpdatedAt = new Date(localDoc.updatedAt).getTime();
          if (remoteDeletedAt > localUpdatedAt) {
            await localCol.updateOne({ _id: localDoc._id }, { $set: { _deletedAt: remoteDoc._deletedAt } });
            result.deleted++;
          } else {
            const doc = this.stripForTransfer(localDoc);
            const transformed = transformDoc ? transformDoc(doc, "toRemote") : doc;
            await remoteCol.updateOne({ _id: remoteDoc._id }, { $set: { ...transformed, _deletedAt: null } });
            result.pushed++;
          }
          continue;
        }

        // Both active — last-write-wins
        const localTime = new Date(localDoc.updatedAt).getTime();
        const remoteTime = new Date(remoteDoc.updatedAt).getTime();

        if (localTime > remoteTime) {
          // Local is newer — push to remote
          const doc = this.stripForTransfer(localDoc);
          const transformed = transformDoc ? transformDoc(doc, "toRemote") : doc;
          await remoteCol.updateOne({ _id: remoteDoc._id }, { $set: transformed });
          result.updated++;
        } else if (remoteTime > localTime) {
          // Remote is newer — pull to local
          const doc = this.stripForTransfer(remoteDoc);
          const transformed = transformDoc ? transformDoc(doc, "toLocal") : doc;
          await localCol.updateOne({ _id: localDoc._id }, { $set: transformed });
          result.updated++;
        }
        // Equal timestamps — no action needed
      }
    }

    return result;
  }

  /**
   * Assign a syncId (UUID) to any documents that don't have one.
   * This allows existing data to participate in syncId-based sync.
   */
  private async backfillSyncIds(col: ReturnType<ReturnType<MongoClient["db"]>["collection"]>) {
    const cursor = col.find({ syncId: { $exists: false } });
    const bulk: { updateOne: { filter: { _id: ObjectId }; update: { $set: { syncId: string } } } }[] = [];
    for await (const doc of cursor) {
      bulk.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { syncId: randomUUID() } },
        },
      });
    }
    if (bulk.length > 0) {
      await col.bulkWrite(bulk);
    }
  }

  /**
   * Strip _id and __v for transfer between databases.
   */
  private stripForTransfer(doc: Document): Document {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id: _stripId, __v: _stripV, ...rest } = doc;
    return rest;
  }

  /**
   * Pair locations by name across DBs and unify their syncIds before the
   * collection sync runs. Without this step the very first sync after the
   * GH #116 fix lands hits Location's partial unique-name index whenever a
   * user has independently created the same location ("Drybox #1") on a
   * desktop and on Docker — both rows have local-only syncIds, so the
   * insertOne in syncCollection's "local-only" branch raises E11000 and
   * aborts the whole cycle.
   *
   * Tie-break for picking the surviving syncId, in order:
   *   1. Both already share a syncId → no-op.
   *   2. Exactly one side has a syncId → propagate to the other.
   *   3. Neither has a syncId → mint a fresh UUID, assign to both.
   *   4. Both have syncIds and they differ → keep local's, overwrite remote's.
   *      (Local wins so the owning desktop's sync history stays intact;
   *      remote rows get re-keyed onto the local id.)
   *
   * Defensive in case 2/4: if the chosen syncId is already in use by a
   * *different* doc on the target side, skip the pair and log — this
   * indicates pre-existing corruption that needs human attention rather
   * than another silent overwrite.
   */
  private async reconcileLocationsByName(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
  ): Promise<void> {
    await this.reconcileByName(localDb, remoteDb, "locations");
  }

  /**
   * Same name-collision resolver used for locations, applied to bedtypes.
   * BedType has a partial-unique index on `name` (non-deleted only), so two
   * desktops that independently created "Textured PEI" before bedtype sync
   * existed would E11000 on the very first sync push.
   */
  private async reconcileBedTypesByName(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
  ): Promise<void> {
    await this.reconcileByName(localDb, remoteDb, "bedtypes");
  }

  /**
   * Generic name-keyed syncId reconciliation. Used for any collection
   * with a partial-unique-name index where the same logical row may have
   * been created independently on both sides before sync was added —
   * locations (v1.11.3) and bedtypes (this PR).
   */
  private async reconcileByName(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
    collectionName: string,
  ): Promise<void> {
    const localCol = localDb.collection(collectionName);
    const remoteCol = remoteDb.collection(collectionName);
    const localActive = await localCol.find({ _deletedAt: null }).toArray();
    const remoteActive = await remoteCol.find({ _deletedAt: null }).toArray();

    const remoteByName = new Map(remoteActive.map((d) => [d.name as string, d]));

    for (const local of localActive) {
      const remote = remoteByName.get(local.name as string);
      if (!remote) continue;

      const localSyncId = local.syncId as string | undefined;
      const remoteSyncId = remote.syncId as string | undefined;

      if (localSyncId && remoteSyncId && localSyncId === remoteSyncId) continue;

      const winningSyncId = localSyncId || remoteSyncId || randomUUID();

      if (localSyncId !== winningSyncId) {
        const conflict = await localCol.findOne({ syncId: winningSyncId, _id: { $ne: local._id } });
        if (conflict) {
          console.warn(`reconcileByName(${collectionName}): local syncId conflict for "${local.name}" — skipping`);
          continue;
        }
        await localCol.updateOne({ _id: local._id }, { $set: { syncId: winningSyncId } });
      }
      if (remoteSyncId !== winningSyncId) {
        const conflict = await remoteCol.findOne({ syncId: winningSyncId, _id: { $ne: remote._id } });
        if (conflict) {
          console.warn(`reconcileByName(${collectionName}): remote syncId conflict for "${local.name}" — skipping`);
          continue;
        }
        await remoteCol.updateOne({ _id: remote._id }, { $set: { syncId: winningSyncId } });
      }
    }
  }

  /**
   * Walk both sides' active filaments and patch any spool whose locationId
   * doesn't match a current location ObjectId on that side.
   *
   * Pre-#116 sync cycles copied filaments wholesale across DBs without
   * remapping spools[].locationId, so a filament on Atlas can be carrying
   * a desktop-side ObjectId (and vice versa). The normal filament sync
   * doesn't fix these — both sides have equal updatedAt for those rows,
   * so syncCollection's last-write-wins skip never re-runs the transform.
   *
   * Recovery uses the syncId maps already built from this cycle's location
   * sync: a dangling id on one side gets looked up via the *other* side's
   * id→syncId map, then resolved to the correct local id via this side's
   * syncId→id map. Orphans (id not present on either side) clear to null
   * rather than persist as a permanent dangling reference.
   */
  private async repairDanglingSpoolLocations(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
    localLocationBySyncId: Map<string, ObjectId>,
    remoteLocationBySyncId: Map<string, ObjectId>,
  ): Promise<void> {
    const localActiveIds = new Set(Array.from(localLocationBySyncId.values()).map((id) => id.toString()));
    const remoteActiveIds = new Set(Array.from(remoteLocationBySyncId.values()).map((id) => id.toString()));

    const localIdToSyncId = new Map<string, string>();
    for (const [syncId, id] of localLocationBySyncId) localIdToSyncId.set(id.toString(), syncId);
    const remoteIdToSyncId = new Map<string, string>();
    for (const [syncId, id] of remoteLocationBySyncId) remoteIdToSyncId.set(id.toString(), syncId);

    await this.repairSideSpoolLocations(localDb, localActiveIds, localLocationBySyncId, remoteIdToSyncId, "local");
    await this.repairSideSpoolLocations(remoteDb, remoteActiveIds, remoteLocationBySyncId, localIdToSyncId, "remote");
  }

  private async repairSideSpoolLocations(
    db: ReturnType<MongoClient["db"]>,
    sideActiveIds: Set<string>,
    sideSyncIdToId: Map<string, ObjectId>,
    otherSideIdToSyncId: Map<string, string>,
    sideLabel: "local" | "remote",
  ): Promise<void> {
    const filaments = await db
      .collection("filaments")
      .find({ _deletedAt: null, "spools.locationId": { $ne: null } })
      .toArray();

    let repaired = 0;
    for (const f of filaments) {
      const spools: Document[] = Array.isArray(f.spools) ? f.spools : [];
      let changed = false;
      const newSpools = spools.map((spool) => {
        if (!spool.locationId) return spool;
        const idStr = spool.locationId.toString();
        if (sideActiveIds.has(idStr)) return spool; // already valid

        const syncId = otherSideIdToSyncId.get(idStr);
        const correctId = syncId ? sideSyncIdToId.get(syncId) : null;
        if (!correctId) {
          changed = true;
          return { ...spool, locationId: null };
        }
        if (correctId.toString() === idStr) return spool;
        changed = true;
        return { ...spool, locationId: correctId };
      });
      if (changed) {
        // CRITICAL: do NOT bump updatedAt. This repair runs before the
        // filament-sync last-write-wins comparison; bumping the timestamp
        // here would make the repaired side look "newest" purely because
        // we touched it, and a subsequent push could overwrite genuinely
        // newer edits on the *other* side that haven't synced yet.
        // Preserving updatedAt lets the existing comparison resolve the
        // sync correctly: equal timestamps → no action needed (both sides
        // now consistent), unequal → real edit recency wins.
        await db.collection("filaments").updateOne(
          { _id: f._id },
          { $set: { spools: newSpools } },
        );
        repaired++;
      }
    }
    if (repaired > 0) {
      console.log(`repairDanglingSpoolLocations: fixed ${repaired} ${sideLabel} filament(s)`);
    }
  }

  /**
   * Restore filament parentId references that the in-line transform couldn't
   * resolve when syncCollection ran. The transform builds its target id map
   * once at sync start — on a fresh install the local map is empty, so when
   * a variant is pulled, the lookup `localFilamentBySyncId.get(syncId)` for
   * its parent returns undefined and the variant gets `parentId: null` on
   * first insert. Subsequent syncs see equal updatedAt and skip the row, so
   * the wrong null persists forever (GH #128).
   *
   * This pass runs AFTER the main filament sync and uses freshly-rebuilt
   * id maps. It projects the truth from the *other* side via the syncId
   * map so a fresh install gets the parent links it should have. Conservative:
   * only writes when current parentId is null-but-should-be-set, OR is set
   * but dangling (points at a non-existent id on this side). Existing valid
   * parentIds are left alone — last-write-wins on the next sync handles
   * intentional user edits.
   *
   * Does NOT bump updatedAt — same rationale as repairDanglingSpoolLocations.
   */
  private async repairFilamentParentIds(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
    localSnapshot: Map<string, number | null>,
    remoteSnapshot: Map<string, number | null>,
  ): Promise<void> {
    const lf = await localDb.collection("filaments").find({}).toArray();
    const rf = await remoteDb.collection("filaments").find({}).toArray();

    const localBySyncId = new Map<string, Document>();
    const localIdToSyncId = new Map<string, string>();
    for (const f of lf) {
      if (f.syncId) {
        localBySyncId.set(f.syncId as string, f);
        localIdToSyncId.set(f._id.toString(), f.syncId as string);
      }
    }
    const remoteBySyncId = new Map<string, Document>();
    const remoteIdToSyncId = new Map<string, string>();
    for (const f of rf) {
      if (f.syncId) {
        remoteBySyncId.set(f.syncId as string, f);
        remoteIdToSyncId.set(f._id.toString(), f.syncId as string);
      }
    }

    await this.repairSideParentIds(
      localDb, lf, localBySyncId, remoteBySyncId, remoteIdToSyncId,
      localSnapshot, "local",
    );
    await this.repairSideParentIds(
      remoteDb, rf, remoteBySyncId, localBySyncId, localIdToSyncId,
      remoteSnapshot, "remote",
    );
  }

  private async repairSideParentIds(
    db: ReturnType<MongoClient["db"]>,
    sideFilaments: Document[],
    sideBySyncId: Map<string, Document>,
    otherBySyncId: Map<string, Document>,
    otherIdToSyncId: Map<string, string>,
    /** Pre-sync snapshot of this side's filaments: `_id → updatedAt(ms)`,
     * or null when the row had no recorded updatedAt. The repair only
     * overrides null→expected for rows this cycle actually touched
     * (inserted, or whose updatedAt changed). Untouched rows are user
     * territory — last-write-wins handles real edits on the next pass. */
    snapshot: Map<string, number | null>,
    sideLabel: "local" | "remote",
  ): Promise<void> {
    const validIds = new Set(sideFilaments.map((f) => f._id.toString()));
    let fixed = 0;

    for (const f of sideFilaments) {
      if (!f.syncId) continue;

      const currentParentIdStr: string | null = f.parentId
        ? f.parentId.toString()
        : null;

      // What should parentId be on this side, projected from the other side?
      const counterpart = otherBySyncId.get(f.syncId as string);
      let expected: ObjectId | null = null;
      if (counterpart?.parentId) {
        const parentSyncId = otherIdToSyncId.get(counterpart.parentId.toString());
        if (parentSyncId) {
          const sideParent = sideBySyncId.get(parentSyncId);
          expected = (sideParent?._id as ObjectId | undefined) ?? null;
        }
      }

      const isCurrentDangling =
        currentParentIdStr != null && !validIds.has(currentParentIdStr);
      const expectedStr = expected ? expected.toString() : null;

      // Was this row inserted OR rewritten by THIS sync cycle? If yes,
      // the parentId we see now came from the just-run transform — fair
      // game to repair against the freshly-built syncId maps. If no,
      // leave it alone (intentional detach, or already-correct).
      const id = f._id.toString();
      const snapshotUpdatedAt = snapshot.get(id);
      let wasTouchedThisCycle: boolean;
      if (snapshotUpdatedAt === undefined) {
        // Not in snapshot at all → freshly inserted by this sync's pull
        // (GH #128 fresh-install shape).
        wasTouchedThisCycle = true;
      } else if (snapshotUpdatedAt === null) {
        // Pre-existing but no recorded updatedAt — can't prove it changed.
        // Default to "untouched" so we don't override potentially-intentional state.
        wasTouchedThisCycle = false;
      } else {
        // Pre-existing with a known timestamp: compare against current.
        // syncCollection's update propagates the source updatedAt, so a
        // sync rewrite shows up as a value change here.
        const currentUpdatedAt = SyncService.readUpdatedAt(f);
        wasTouchedThisCycle =
          currentUpdatedAt !== undefined && currentUpdatedAt !== snapshotUpdatedAt;
      }

      // Conservative: only repair the two clear-bug shapes.
      const shouldFix =
        // Null parentId where projection says it should be set, and this
        // row was created or rewritten by this cycle. Covers both the
        // fresh-install pull (#128) and the pre-existing-variant-updated
        // -before-its-parent shape (Codex P1 on PR #131).
        (currentParentIdStr == null && expected != null && wasTouchedThisCycle) ||
        // Stale id pointing at nothing on this side. Always broken state,
        // repair regardless of when the row was inserted.
        (isCurrentDangling && currentParentIdStr !== expectedStr);

      if (!shouldFix) continue;

      await db.collection("filaments").updateOne(
        { _id: f._id },
        { $set: { parentId: expected } },
      );
      fixed++;
    }

    if (fixed > 0) {
      console.log(`repairFilamentParentIds: fixed ${fixed} ${sideLabel} filament(s)`);
    }
  }

  /** Best-effort millisecond conversion of a Mongo `updatedAt` field.
   * Mongoose schemas in this codebase always set Dates, but raw mongo
   * inserts can store strings — handle both, and return undefined for
   * anything we can't read. */
  private static readUpdatedAt(doc: Document): number | undefined {
    const u = doc.updatedAt;
    if (!u) return undefined;
    if (u instanceof Date) return u.getTime();
    if (typeof u === "string") {
      const t = Date.parse(u);
      return Number.isNaN(t) ? undefined : t;
    }
    if (typeof u === "number") return u;
    return undefined;
  }

  /**
   * Remap nozzle ObjectId references in printer documents.
   * installedNozzles need to point to the correct IDs on the target side.
   * Maps use syncId as the stable key (survives renames).
   */
  private remapPrinterRefs(
    doc: Document,
    direction: "toLocal" | "toRemote",
    localNozzleBySyncId: Map<string, ObjectId>,
    remoteNozzleBySyncId: Map<string, ObjectId>,
  ): Document {
    const sourceMap = direction === "toLocal" ? remoteNozzleBySyncId : localNozzleBySyncId;
    const targetMap = direction === "toLocal" ? localNozzleBySyncId : remoteNozzleBySyncId;

    const sourceIdToSyncId = new Map<string, string>();
    for (const [syncId, id] of sourceMap) {
      sourceIdToSyncId.set(id.toString(), syncId);
    }

    if (Array.isArray(doc.installedNozzles)) {
      doc.installedNozzles = doc.installedNozzles
        .map((id: ObjectId) => {
          const syncId = sourceIdToSyncId.get(id.toString());
          return syncId ? targetMap.get(syncId) : null;
        })
        .filter(Boolean);
    }

    return doc;
  }

  /**
   * Build a transform function for filament reference remapping.
   * Precomputes all reverse lookup maps (ID → syncId) once, so the
   * per-document transform is O(1) per reference instead of O(N).
   */
  private buildFilamentRefsTransform(
    localNozzleBySyncId: Map<string, ObjectId>,
    remoteNozzleBySyncId: Map<string, ObjectId>,
    localPrinterBySyncId: Map<string, ObjectId>,
    remotePrinterBySyncId: Map<string, ObjectId>,
    localFilamentBySyncId: Map<string, ObjectId>,
    remoteFilamentBySyncId: Map<string, ObjectId>,
    localLocationBySyncId: Map<string, ObjectId>,
    remoteLocationBySyncId: Map<string, ObjectId>,
    localBedTypeBySyncId: Map<string, ObjectId>,
    remoteBedTypeBySyncId: Map<string, ObjectId>,
  ): (doc: Document, direction: "toLocal" | "toRemote") => Document {
    // Build reverse maps once (source ID → syncId) for both directions
    const buildReverse = (map: Map<string, ObjectId>) => {
      const reverse = new Map<string, string>();
      for (const [syncId, id] of map) {
        reverse.set(id.toString(), syncId);
      }
      return reverse;
    };

    const localNozzleIdToSyncId = buildReverse(localNozzleBySyncId);
    const remoteNozzleIdToSyncId = buildReverse(remoteNozzleBySyncId);
    const localPrinterIdToSyncId = buildReverse(localPrinterBySyncId);
    const remotePrinterIdToSyncId = buildReverse(remotePrinterBySyncId);
    const localFilamentIdToSyncId = buildReverse(localFilamentBySyncId);
    const remoteFilamentIdToSyncId = buildReverse(remoteFilamentBySyncId);
    const localLocationIdToSyncId = buildReverse(localLocationBySyncId);
    const remoteLocationIdToSyncId = buildReverse(remoteLocationBySyncId);
    const localBedTypeIdToSyncId = buildReverse(localBedTypeBySyncId);
    const remoteBedTypeIdToSyncId = buildReverse(remoteBedTypeBySyncId);

    return (doc: Document, direction: "toLocal" | "toRemote"): Document => {
      const sourceNozzleIdToSyncId = direction === "toLocal" ? remoteNozzleIdToSyncId : localNozzleIdToSyncId;
      const targetNozzleMap = direction === "toLocal" ? localNozzleBySyncId : remoteNozzleBySyncId;
      const sourcePrinterIdToSyncId = direction === "toLocal" ? remotePrinterIdToSyncId : localPrinterIdToSyncId;
      const targetPrinterMap = direction === "toLocal" ? localPrinterBySyncId : remotePrinterBySyncId;
      const sourceLocationIdToSyncId = direction === "toLocal" ? remoteLocationIdToSyncId : localLocationIdToSyncId;
      const targetLocationMap = direction === "toLocal" ? localLocationBySyncId : remoteLocationBySyncId;
      const sourceBedTypeIdToSyncId = direction === "toLocal" ? remoteBedTypeIdToSyncId : localBedTypeIdToSyncId;
      const targetBedTypeMap = direction === "toLocal" ? localBedTypeBySyncId : remoteBedTypeBySyncId;

      // Remap compatibleNozzles
      if (Array.isArray(doc.compatibleNozzles)) {
        doc.compatibleNozzles = doc.compatibleNozzles
          .map((id: ObjectId) => {
            const syncId = sourceNozzleIdToSyncId.get(id.toString());
            return syncId ? targetNozzleMap.get(syncId) : null;
          })
          .filter(Boolean);
      }

      // Remap calibrations.nozzle, calibrations.printer, and
      // calibrations.bedType
      if (Array.isArray(doc.calibrations)) {
        doc.calibrations = doc.calibrations
          .map((cal: Document) => {
            if (!cal.nozzle) return cal;
            const nozzleSyncId = sourceNozzleIdToSyncId.get(cal.nozzle.toString());
            const targetNozzleId = nozzleSyncId ? targetNozzleMap.get(nozzleSyncId) : null;
            if (!targetNozzleId) return null; // Drop calibration if nozzle doesn't exist on target

            const remapped: Document = { ...cal, nozzle: targetNozzleId };

            // Remap printer reference if present
            if (cal.printer) {
              const printerSyncId = sourcePrinterIdToSyncId.get(cal.printer.toString());
              const targetPrinterId = printerSyncId ? targetPrinterMap.get(printerSyncId) : null;
              remapped.printer = targetPrinterId || null;
            }

            // Remap bedType reference if present. An unknown bedType on the
            // target side clears to null rather than persisting a wrong-side
            // ObjectId — same model as printer/location.
            if (cal.bedType) {
              const bedTypeSyncId = sourceBedTypeIdToSyncId.get(cal.bedType.toString());
              const targetBedTypeId = bedTypeSyncId ? targetBedTypeMap.get(bedTypeSyncId) : null;
              remapped.bedType = targetBedTypeId || null;
            }

            return remapped;
          })
          .filter(Boolean);
      }

      // Remap parentId (variant → parent relationship)
      if (doc.parentId) {
        const sourceFilamentIdToSyncId = direction === "toLocal" ? remoteFilamentIdToSyncId : localFilamentIdToSyncId;
        const targetFilamentMap = direction === "toLocal" ? localFilamentBySyncId : remoteFilamentBySyncId;

        const parentSyncId = sourceFilamentIdToSyncId.get(doc.parentId.toString());
        const targetParentId = parentSyncId ? targetFilamentMap.get(parentSyncId) : null;
        doc.parentId = targetParentId || null;
      }

      // Remap spools[].locationId. Locations sync as their own collection but
      // the ObjectIds differ across DBs, so each spool's locationId must be
      // translated through the syncId map. Unknown locations clear to null
      // rather than pointing at a wrong location on the target side.
      if (Array.isArray(doc.spools)) {
        doc.spools = doc.spools.map((spool: Document) => {
          if (!spool.locationId) return spool;
          const locSyncId = sourceLocationIdToSyncId.get(spool.locationId.toString());
          const targetLocationId = locSyncId ? targetLocationMap.get(locSyncId) : null;
          return { ...spool, locationId: targetLocationId || null };
        });
      }

      return doc;
    };
  }

  /**
   * Build a transform for printhistories. Remaps printerId and
   * usage[].filamentId via syncId. usage[].spoolId is cleared on
   * insert/update because spool subdocuments don't have stable
   * cross-side identifiers (no spool syncIds yet — separate schema
   * migration). The job's per-filament gram totals are still correct
   * after the remap, but per-spool attribution is lost.
   */
  private buildPrintHistoryTransform(
    localPrinterBySyncId: Map<string, ObjectId>,
    remotePrinterBySyncId: Map<string, ObjectId>,
    localFilamentBySyncId: Map<string, ObjectId>,
    remoteFilamentBySyncId: Map<string, ObjectId>,
  ): (doc: Document, direction: "toLocal" | "toRemote") => Document {
    const buildReverse = (map: Map<string, ObjectId>) => {
      const reverse = new Map<string, string>();
      for (const [syncId, id] of map) reverse.set(id.toString(), syncId);
      return reverse;
    };

    const localPrinterIdToSyncId = buildReverse(localPrinterBySyncId);
    const remotePrinterIdToSyncId = buildReverse(remotePrinterBySyncId);
    const localFilamentIdToSyncId = buildReverse(localFilamentBySyncId);
    const remoteFilamentIdToSyncId = buildReverse(remoteFilamentBySyncId);

    return (doc: Document, direction: "toLocal" | "toRemote"): Document => {
      const sourcePrinterIdToSyncId = direction === "toLocal" ? remotePrinterIdToSyncId : localPrinterIdToSyncId;
      const targetPrinterMap = direction === "toLocal" ? localPrinterBySyncId : remotePrinterBySyncId;
      const sourceFilamentIdToSyncId = direction === "toLocal" ? remoteFilamentIdToSyncId : localFilamentIdToSyncId;
      const targetFilamentMap = direction === "toLocal" ? localFilamentBySyncId : remoteFilamentBySyncId;

      if (doc.printerId) {
        const printerSyncId = sourcePrinterIdToSyncId.get(doc.printerId.toString());
        doc.printerId = (printerSyncId ? targetPrinterMap.get(printerSyncId) : null) || null;
      }

      if (Array.isArray(doc.usage)) {
        doc.usage = doc.usage
          .map((entry: Document) => {
            if (!entry.filamentId) return null; // schema requires filamentId
            const filSyncId = sourceFilamentIdToSyncId.get(entry.filamentId.toString());
            const targetFilId = filSyncId ? targetFilamentMap.get(filSyncId) : null;
            if (!targetFilId) return null; // drop usage entry with unresolvable filament
            return {
              ...entry,
              filamentId: targetFilId,
              // Clear spoolId — no stable cross-side spool ids; per-spool
              // attribution is dropped pending the spool-syncId migration.
              spoolId: null,
            };
          })
          .filter(Boolean);
      }

      return doc;
    };
  }

  /**
   * After the filament sync settles, walk both sides' printers and patch
   * each amsSlots[].filamentId so it points at a filament that actually
   * exists on this side. The forward path is necessary because printer
   * sync runs BEFORE filament sync (to break the calibrations.printer ↔
   * amsSlots.filamentId cycle): on push, the remote target may not yet
   * have the filament id we're handing it; on pull, our local map didn't
   * have the new filament when the printer transform ran.
   *
   * Resolution model:
   *   - filamentId points at a current valid filament on this side → leave.
   *   - filamentId is null → leave (intentional empty slot).
   *   - filamentId is set but dangles → look up by other-side syncId and
   *     swap in the correct local id; if the syncId can't be projected
   *     (filament absent on other side too), clear to null. spoolId
   *     follows the same fate as its parent filamentId — cleared if the
   *     filamentId is repaired or cleared, since per-spool attribution
   *     can't survive a filamentId rewrite without spool syncIds.
   *
   * Does NOT bump updatedAt — same rationale as the other repair passes.
   */
  private async repairPrinterAmsSlots(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
    localFilamentBySyncId: Map<string, ObjectId>,
    remoteFilamentBySyncId: Map<string, ObjectId>,
  ): Promise<void> {
    const localFilIds = new Set(Array.from(localFilamentBySyncId.values()).map((id) => id.toString()));
    const remoteFilIds = new Set(Array.from(remoteFilamentBySyncId.values()).map((id) => id.toString()));

    const localFilIdToSyncId = new Map<string, string>();
    for (const [syncId, id] of localFilamentBySyncId) localFilIdToSyncId.set(id.toString(), syncId);
    const remoteFilIdToSyncId = new Map<string, string>();
    for (const [syncId, id] of remoteFilamentBySyncId) remoteFilIdToSyncId.set(id.toString(), syncId);

    await this.repairSidePrinterAmsSlots(localDb, localFilIds, localFilamentBySyncId, remoteFilIdToSyncId, "local");
    await this.repairSidePrinterAmsSlots(remoteDb, remoteFilIds, remoteFilamentBySyncId, localFilIdToSyncId, "remote");
  }

  private async repairSidePrinterAmsSlots(
    db: ReturnType<MongoClient["db"]>,
    sideValidFilIds: Set<string>,
    sideFilSyncIdToId: Map<string, ObjectId>,
    otherSideFilIdToSyncId: Map<string, string>,
    sideLabel: "local" | "remote",
  ): Promise<void> {
    // Use $elemMatch — the naive "amsSlots.filamentId": { $ne: null } would
    // exclude any printer that has *any* slot with filamentId === null, even
    // if a sibling slot is set (Mongo's array-positional matching makes
    // negated equality match on whole-array, not per-element).
    const printers = await db
      .collection("printers")
      .find({
        _deletedAt: null,
        amsSlots: { $elemMatch: { filamentId: { $ne: null } } },
      })
      .toArray();

    let repaired = 0;
    for (const p of printers) {
      const slots: Document[] = Array.isArray(p.amsSlots) ? p.amsSlots : [];
      let changed = false;
      const newSlots = slots.map((slot) => {
        if (!slot.filamentId) return slot;
        const idStr = slot.filamentId.toString();
        if (sideValidFilIds.has(idStr)) return slot; // already valid

        const syncId = otherSideFilIdToSyncId.get(idStr);
        const correctId = syncId ? sideFilSyncIdToId.get(syncId) : null;
        if (!correctId) {
          changed = true;
          return { ...slot, filamentId: null, spoolId: null };
        }
        if (correctId.toString() === idStr) return slot;
        changed = true;
        // Filament repaired but spool can't be reliably mapped — clear it.
        return { ...slot, filamentId: correctId, spoolId: null };
      });
      if (changed) {
        await db.collection("printers").updateOne(
          { _id: p._id },
          { $set: { amsSlots: newSlots } },
        );
        repaired++;
      }
    }
    if (repaired > 0) {
      console.log(`repairPrinterAmsSlots: fixed ${repaired} ${sideLabel} printer(s)`);
    }
  }

  destroy() {
    this.stopPeriodicSync();
    this.removeAllListeners();
  }
}

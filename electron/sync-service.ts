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
 * Nozzles, printers, and locations are synced first so filaments (and their
 * embedded spools) can have their references remapped onto the target DB's IDs.
 *
 * NOTE: bedtypes, printhistory, and sharedcatalogs are NOT synced yet — they
 * were added in v1.11 alongside locations and have the same gap. They'll need
 * the same treatment when their data starts diverging across desktops.
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

      // Backfill filament syncIds before building maps (syncCollection does this too, but we need maps first)
      await this.backfillSyncIds(localDb.collection("filaments"));
      await this.backfillSyncIds(remoteDb.collection("filaments"));

      // Build filament syncId→ID maps for parentId remapping
      const localFilaments = await localDb.collection("filaments").find({}).toArray();
      const remoteFilaments = await remoteDb.collection("filaments").find({}).toArray();
      const localFilamentBySyncId = new Map(localFilaments.filter(f => f.syncId).map(f => [f.syncId as string, f._id]));
      const remoteFilamentBySyncId = new Map(remoteFilaments.filter(f => f.syncId).map(f => [f.syncId as string, f._id]));

      // Sync filaments with nozzle, printer, parent, and spool-location remapping
      this.updateStatus({ progress: "Syncing filaments..." });
      const filamentTransform = this.buildFilamentRefsTransform(
        localNozzleBySyncId, remoteNozzleBySyncId,
        localPrinterBySyncId, remotePrinterBySyncId,
        localFilamentBySyncId, remoteFilamentBySyncId,
        localLocationBySyncId, remoteLocationBySyncId,
      );
      const filamentResult = await this.syncCollection(
        localDb, remoteDb, "filaments",
        filamentTransform,
      );

      const results = [nozzleResult, printerResult, locationResult, filamentResult];
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
    const localCol = localDb.collection("locations");
    const remoteCol = remoteDb.collection("locations");
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
          console.warn(`reconcileLocationsByName: local syncId conflict for "${local.name}" — skipping`);
          continue;
        }
        await localCol.updateOne({ _id: local._id }, { $set: { syncId: winningSyncId } });
      }
      if (remoteSyncId !== winningSyncId) {
        const conflict = await remoteCol.findOne({ syncId: winningSyncId, _id: { $ne: remote._id } });
        if (conflict) {
          console.warn(`reconcileLocationsByName: remote syncId conflict for "${local.name}" — skipping`);
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

    return (doc: Document, direction: "toLocal" | "toRemote"): Document => {
      const sourceNozzleIdToSyncId = direction === "toLocal" ? remoteNozzleIdToSyncId : localNozzleIdToSyncId;
      const targetNozzleMap = direction === "toLocal" ? localNozzleBySyncId : remoteNozzleBySyncId;
      const sourcePrinterIdToSyncId = direction === "toLocal" ? remotePrinterIdToSyncId : localPrinterIdToSyncId;
      const targetPrinterMap = direction === "toLocal" ? localPrinterBySyncId : remotePrinterBySyncId;
      const sourceLocationIdToSyncId = direction === "toLocal" ? remoteLocationIdToSyncId : localLocationIdToSyncId;
      const targetLocationMap = direction === "toLocal" ? localLocationBySyncId : remoteLocationBySyncId;

      // Remap compatibleNozzles
      if (Array.isArray(doc.compatibleNozzles)) {
        doc.compatibleNozzles = doc.compatibleNozzles
          .map((id: ObjectId) => {
            const syncId = sourceNozzleIdToSyncId.get(id.toString());
            return syncId ? targetNozzleMap.get(syncId) : null;
          })
          .filter(Boolean);
      }

      // Remap calibrations.nozzle and calibrations.printer
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

  destroy() {
    this.stopPeriodicSync();
    this.removeAllListeners();
  }
}

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { MongoClient, ObjectId, Document } from "mongodb";

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
 * Nozzles are synced first so filament references can be remapped.
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
      await client.db("filament-db").command({ ping: 1 });
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
    this.sync().catch(() => {});
    this.intervalId = setInterval(() => {
      this.sync().catch(() => {});
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

      const localDb = local.db("filament-db");
      const remoteDb = remote.db("filament-db");

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

      // Backfill filament syncIds before building maps (syncCollection does this too, but we need maps first)
      await this.backfillSyncIds(localDb.collection("filaments"));
      await this.backfillSyncIds(remoteDb.collection("filaments"));

      // Build filament syncId→ID maps for parentId remapping
      const localFilaments = await localDb.collection("filaments").find({}).toArray();
      const remoteFilaments = await remoteDb.collection("filaments").find({}).toArray();
      const localFilamentBySyncId = new Map(localFilaments.filter(f => f.syncId).map(f => [f.syncId as string, f._id]));
      const remoteFilamentBySyncId = new Map(remoteFilaments.filter(f => f.syncId).map(f => [f.syncId as string, f._id]));

      // Sync filaments with nozzle, printer, and parent reference remapping
      this.updateStatus({ progress: "Syncing filaments..." });
      const filamentResult = await this.syncCollection(
        localDb, remoteDb, "filaments",
        (doc, direction) => this.remapFilamentRefs(doc, direction, localNozzleBySyncId, remoteNozzleBySyncId, localPrinterBySyncId, remotePrinterBySyncId, localFilamentBySyncId, remoteFilamentBySyncId)
      );

      const results = [nozzleResult, printerResult, filamentResult];
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
   * Remap nozzle and printer ObjectId references in filament documents.
   * compatibleNozzles, calibrations.nozzle, and calibrations.printer need
   * to point to the correct IDs on the target side.
   * Maps use syncId as the stable key (survives renames).
   */
  private remapFilamentRefs(
    doc: Document,
    direction: "toLocal" | "toRemote",
    localNozzleBySyncId: Map<string, ObjectId>,
    remoteNozzleBySyncId: Map<string, ObjectId>,
    localPrinterBySyncId: Map<string, ObjectId>,
    remotePrinterBySyncId: Map<string, ObjectId>,
    localFilamentBySyncId: Map<string, ObjectId>,
    remoteFilamentBySyncId: Map<string, ObjectId>,
  ): Document {
    const sourceNozzleMap = direction === "toLocal" ? remoteNozzleBySyncId : localNozzleBySyncId;
    const targetNozzleMap = direction === "toLocal" ? localNozzleBySyncId : remoteNozzleBySyncId;
    const sourcePrinterMap = direction === "toLocal" ? remotePrinterBySyncId : localPrinterBySyncId;
    const targetPrinterMap = direction === "toLocal" ? localPrinterBySyncId : remotePrinterBySyncId;

    // Build source ID → syncId reverse lookups
    const sourceNozzleIdToSyncId = new Map<string, string>();
    for (const [syncId, id] of sourceNozzleMap) {
      sourceNozzleIdToSyncId.set(id.toString(), syncId);
    }
    const sourcePrinterIdToSyncId = new Map<string, string>();
    for (const [syncId, id] of sourcePrinterMap) {
      sourcePrinterIdToSyncId.set(id.toString(), syncId);
    }

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

          const remapped = { ...cal, nozzle: targetNozzleId };

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
      const sourceFilamentMap = direction === "toLocal" ? remoteFilamentBySyncId : localFilamentBySyncId;
      const targetFilamentMap = direction === "toLocal" ? localFilamentBySyncId : remoteFilamentBySyncId;

      const sourceFilamentIdToSyncId = new Map<string, string>();
      for (const [syncId, id] of sourceFilamentMap) {
        sourceFilamentIdToSyncId.set(id.toString(), syncId);
      }

      const parentSyncId = sourceFilamentIdToSyncId.get(doc.parentId.toString());
      const targetParentId = parentSyncId ? targetFilamentMap.get(parentSyncId) : null;
      doc.parentId = targetParentId || null;
    }

    return doc;
  }

  destroy() {
    this.stopPeriodicSync();
    this.removeAllListeners();
  }
}

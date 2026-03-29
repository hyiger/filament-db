import { EventEmitter } from "events";
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

      // Build nozzle name→ID maps for reference remapping
      const localNozzles = await localDb.collection("nozzles").find({ _deletedAt: null }).toArray();
      const remoteNozzles = await remoteDb.collection("nozzles").find({ _deletedAt: null }).toArray();
      const localNozzleByName = new Map(localNozzles.map(n => [n.name, n._id]));
      const remoteNozzleByName = new Map(remoteNozzles.map(n => [n.name, n._id]));

      // Sync printers (filament calibrations reference them)
      this.updateStatus({ progress: "Syncing printers..." });
      const printerResult = await this.syncCollection(
        localDb, remoteDb, "printers",
        (doc, direction) => this.remapPrinterRefs(doc, direction, localNozzleByName, remoteNozzleByName)
      );

      // Build printer name→ID maps for filament calibration reference remapping
      const localPrinters = await localDb.collection("printers").find({ _deletedAt: null }).toArray();
      const remotePrinters = await remoteDb.collection("printers").find({ _deletedAt: null }).toArray();
      const localPrinterByName = new Map(localPrinters.map(p => [p.name, p._id]));
      const remotePrinterByName = new Map(remotePrinters.map(p => [p.name, p._id]));

      // Sync filaments with nozzle and printer reference remapping
      this.updateStatus({ progress: "Syncing filaments..." });
      const filamentResult = await this.syncCollection(
        localDb, remoteDb, "filaments",
        (doc, direction) => this.remapFilamentRefs(doc, direction, localNozzleByName, remoteNozzleByName, localPrinterByName, remotePrinterByName)
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
   * Sync a single collection bidirectionally using name as the natural key.
   */
  private async syncCollection(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
    collectionName: string,
    transformDoc?: (doc: Document, direction: "toLocal" | "toRemote") => Document,
  ): Promise<SyncResult> {
    const localCol = localDb.collection(collectionName);
    const remoteCol = remoteDb.collection(collectionName);

    // Fetch all docs (including soft-deleted) from both sides
    const localDocs = await localCol.find({}).toArray();
    const remoteDocs = await remoteCol.find({}).toArray();

    const localByName = new Map(localDocs.map(d => [d.name as string, d]));
    const remoteByName = new Map(remoteDocs.map(d => [d.name as string, d]));

    const result: SyncResult = { collection: collectionName, pushed: 0, pulled: 0, updated: 0, deleted: 0 };

    // Process all unique names from both sides
    const allNames = new Set([...localByName.keys(), ...remoteByName.keys()]);

    for (const name of allNames) {
      const localDoc = localByName.get(name);
      const remoteDoc = remoteByName.get(name);

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
   * Strip _id and __v for transfer between databases.
   */
  private stripForTransfer(doc: Document): Document {
    const { _id, __v, ...rest } = doc;
    return rest;
  }

  /**
   * Remap nozzle ObjectId references in printer documents.
   * installedNozzles need to point to the correct IDs on the target side.
   */
  private remapPrinterRefs(
    doc: Document,
    direction: "toLocal" | "toRemote",
    localNozzleByName: Map<string, ObjectId>,
    remoteNozzleByName: Map<string, ObjectId>,
  ): Document {
    const sourceMap = direction === "toLocal" ? remoteNozzleByName : localNozzleByName;
    const targetMap = direction === "toLocal" ? localNozzleByName : remoteNozzleByName;

    const sourceIdToName = new Map<string, string>();
    for (const [name, id] of sourceMap) {
      sourceIdToName.set(id.toString(), name);
    }

    if (Array.isArray(doc.installedNozzles)) {
      doc.installedNozzles = doc.installedNozzles
        .map((id: ObjectId) => {
          const name = sourceIdToName.get(id.toString());
          return name ? targetMap.get(name) : null;
        })
        .filter(Boolean);
    }

    return doc;
  }

  /**
   * Remap nozzle and printer ObjectId references in filament documents.
   * compatibleNozzles, calibrations.nozzle, and calibrations.printer need
   * to point to the correct IDs on the target side.
   */
  private remapFilamentRefs(
    doc: Document,
    direction: "toLocal" | "toRemote",
    localNozzleByName: Map<string, ObjectId>,
    remoteNozzleByName: Map<string, ObjectId>,
    localPrinterByName: Map<string, ObjectId>,
    remotePrinterByName: Map<string, ObjectId>,
  ): Document {
    const sourceNozzleMap = direction === "toLocal" ? remoteNozzleByName : localNozzleByName;
    const targetNozzleMap = direction === "toLocal" ? localNozzleByName : remoteNozzleByName;
    const sourcePrinterMap = direction === "toLocal" ? remotePrinterByName : localPrinterByName;
    const targetPrinterMap = direction === "toLocal" ? localPrinterByName : remotePrinterByName;

    // Build source ID → name reverse lookups
    const sourceNozzleIdToName = new Map<string, string>();
    for (const [name, id] of sourceNozzleMap) {
      sourceNozzleIdToName.set(id.toString(), name);
    }
    const sourcePrinterIdToName = new Map<string, string>();
    for (const [name, id] of sourcePrinterMap) {
      sourcePrinterIdToName.set(id.toString(), name);
    }

    // Remap compatibleNozzles
    if (Array.isArray(doc.compatibleNozzles)) {
      doc.compatibleNozzles = doc.compatibleNozzles
        .map((id: ObjectId) => {
          const name = sourceNozzleIdToName.get(id.toString());
          return name ? targetNozzleMap.get(name) : null;
        })
        .filter(Boolean);
    }

    // Remap calibrations.nozzle and calibrations.printer
    if (Array.isArray(doc.calibrations)) {
      doc.calibrations = doc.calibrations
        .map((cal: Document) => {
          if (!cal.nozzle) return cal;
          const nozzleName = sourceNozzleIdToName.get(cal.nozzle.toString());
          const targetNozzleId = nozzleName ? targetNozzleMap.get(nozzleName) : null;
          if (!targetNozzleId) return null; // Drop calibration if nozzle doesn't exist on target

          const remapped = { ...cal, nozzle: targetNozzleId };

          // Remap printer reference if present
          if (cal.printer) {
            const printerName = sourcePrinterIdToName.get(cal.printer.toString());
            const targetPrinterId = printerName ? targetPrinterMap.get(printerName) : null;
            remapped.printer = targetPrinterId || null;
          }

          return remapped;
        })
        .filter(Boolean);
    }

    // Remap parentId — this uses filament names, but we can't easily do it here
    // since we'd need the filament name maps. For now, strip parentId during sync
    // (same as Atlas import behavior). Parent-variant relationships are local.
    delete doc.parentId;

    return doc;
  }

  destroy() {
    this.stopPeriodicSync();
    this.removeAllListeners();
  }
}

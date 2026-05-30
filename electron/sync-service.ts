import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { MongoClient, ObjectId, Document } from "mongodb";

/**
 * Recognise a duplicate-key error specifically on the `syncId` index,
 * so the local-only push / pull paths can treat a concurrent peer
 * winning that race as a no-op (GH #439).
 *
 * Codex follow-up on PR #464: an earlier version accepted ANY
 * E11000 and silently swallowed real conflicts. Every synced
 * collection also has unique indexes on at least one other field
 * — filament `name` / `instanceId`, nozzle `name`, etc. A real
 * collision on those would have left the doc unsynced forever
 * while the cycle still reported success.
 *
 * The MongoDB driver decorates the error with:
 *   - `code: 11000`
 *   - `keyPattern: { <indexedField>: 1 }`  (which index conflicted)
 *   - `keyValue`: { <indexedField>: <colliding value> }
 * Constrain to the `syncId` case by checking `keyPattern.syncId` —
 * a key in the pattern means the violation involved that index.
 * Without a keyPattern (some driver versions surface a bare code on
 * older error shapes), err on the side of NOT swallowing so the
 * cycle still surfaces the conflict.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (e.code !== 11000) return false;
  if (!e.keyPattern || typeof e.keyPattern !== "object") return false;
  return Object.prototype.hasOwnProperty.call(e.keyPattern, "syncId");
}

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

/**
 * Wrap a sync error into a user-facing message, redacting connection
 * strings. When the error is the MongoDB driver's "Unauthorized" shape
 * (raised when the Atlas user lacks `readWrite`), swap the raw driver
 * text for an actionable hint that points the user at the fix —
 * regenerating the connection string from a writable Atlas user.
 *
 * Detects the auth shape two ways: by message regex (matches the driver's
 * `user is not allowed to do action [update] on [db.coll]`) and by code 13
 * (the more reliable signal, but not always populated on every wrapped
 * error path). Either is sufficient. See GH #143.
 */
export function wrapSyncErrorMessage(err: unknown, dbName: string): string {
  const message = err instanceof Error ? err.message : "Sync failed";
  const code =
    err && typeof err === "object" && "code" in err
      ? (err as { code: unknown }).code
      : undefined;

  const isAuthError =
    /user is not allowed to do action/i.test(message) || code === 13;

  if (isAuthError) {
    return `The Atlas user in your connection string only has read permission for "${dbName}". Update the user's role to one that includes readWrite (or change the connection string to one that does), then try again. You can re-enter the connection string in Settings → Connection.`;
  }

  return message.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "mongodb://***");
}

export interface SyncStatus {
  /**
   * "partial" (GH #369) means some collections succeeded and at least one
   * failed in the same cycle. Distinct from "error" — which is reserved
   * for cycle-level failures (connect timeout, post-sync repair throw,
   * every collection failed) — so the renderer can surface partial
   * convergence as recoverable rather than the all-or-nothing red pill
   * the pre-fix code showed.
   */
  state: "idle" | "syncing" | "error" | "offline" | "partial";
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
  /**
   * GH #369: per-collection error. When set, this collection's sync
   * threw and the count fields are zero. Other collections in the same
   * cycle may have succeeded.
   */
  error?: string | null;
}

/**
 * Bidirectional sync engine between local MongoDB and Atlas.
 * Uses last-write-wins conflict resolution based on updatedAt timestamps.
 * Reference-only collections (nozzles, bedtypes, locations) and printers
 * are synced before filaments so filaments (and their embedded spools)
 * can have their references remapped onto the target DB's IDs. Order:
 * nozzles → bedtypes → printers → locations → filaments. bedtypes sync
 * before printers because printers carry installedBedTypes refs.
 * Printhistories and sharedcatalogs sync after filaments.
 *
 * Known limitation: spool subdocuments inside Filament don't have stable
 * cross-side identifiers. Anything that references a spool by id —
 * printer.amsSlots[].spoolId, printhistory.usage[].spoolId — clears that
 * id during cross-side remap. Per-filament gram totals still reconcile;
 * per-spool attribution is dropped pending a spool-syncId migration.
 *
 * GH #438: the SAME caveat applies to OTHER subdoc `_id`s — every
 * `calibrations[]._id` on a Filament and every `amsSlots[]._id` on a
 * Printer is freshly minted by `insertOne`/`$set` on each cross-side
 * write because the subdocs don't carry a stable `syncId`. Today nothing
 * in the codebase references these subdoc ids across sync (URL deep-
 * links, ledger entries, etc. all key by parent doc + offset), so this
 * is documented as a constraint on future features rather than fixed
 * by adding subdoc syncIds. If you add a feature that needs stable
 * cross-side subdoc identity, the fix is to mint a `syncId` on the
 * subdoc and preserve it through `stripForTransfer`.
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

    // GH #369: per-collection error isolation. Wraps a syncCollection call
    // so a single collection failure (transient network blip, schema
    // validation rejection, partial-unique-index collision) reports an
    // errored SyncResult instead of throwing all the way out and discarding
    // the partial-success state from earlier collections.
    //
    // GH #369 (Codex follow-up): dependent collections are SKIPPED rather
    // than run with stale syncId maps. Without this guard a transient
    // nozzle/bedtype failure would let `printers`/`filaments` run anyway —
    // remapPrinterRefs and buildFilamentRefsTransform drop unresolved
    // references to null, so a transient upstream failure became permanent
    // reference loss in downstream documents (Feb 29 of sync bugs). The
    // dependency graph mirrors the explicit "syncs before X" ordering
    // comments throughout this method:
    //   nozzles      → no deps
    //   bedtypes     → no deps
    //   printers     → nozzles, bedtypes  (remapPrinterRefs uses both maps)
    //   locations    → no deps
    //   filaments    → nozzles, printers, bedtypes, locations, filaments-self
    //                  (buildFilamentRefsTransform consumes all four maps)
    //   printhistories → printers, filaments (transitively → all of filaments' deps)
    //   sharedcatalogs → no deps (payload denormalised at publish time)
    //
    // A "skipped" SyncResult names the failing prerequisite so the user
    // knows exactly which collection to re-run.
    const atlasName = getDbNameFromUri(this.atlasUri);
    const results: SyncResult[] = [];
    const trySync = async (
      name: string,
      deps: string[],
      run: () => Promise<SyncResult>,
    ): Promise<SyncResult> => {
      for (const dep of deps) {
        const depResult = results.find(r => r.collection === dep);
        if (depResult?.error) {
          return {
            collection: name,
            pushed: 0,
            pulled: 0,
            updated: 0,
            deleted: 0,
            error: `skipped — prerequisite "${dep}" failed (${depResult.error})`,
          };
        }
      }
      try {
        return await run();
      } catch (err) {
        return {
          collection: name,
          pushed: 0,
          pulled: 0,
          updated: 0,
          deleted: 0,
          error: wrapSyncErrorMessage(err, atlasName),
        };
      }
    };

    try {
      await local.connect();
      await remote.connect();

      const localDb = local.db(getDbNameFromUri(this.localUri));
      const remoteDb = remote.db(getDbNameFromUri(this.atlasUri));

      // Sync nozzles first (filaments and printers reference them)
      this.updateStatus({ progress: "Syncing nozzles..." });
      results.push(await trySync("nozzles", [], () =>
        this.syncCollection(localDb, remoteDb, "nozzles"),
      ));

      // Build nozzle syncId→ID maps for reference remapping
      const localNozzles = await localDb.collection("nozzles").find({ _deletedAt: null }).toArray();
      const remoteNozzles = await remoteDb.collection("nozzles").find({ _deletedAt: null }).toArray();
      const localNozzleBySyncId = new Map(localNozzles.filter(n => n.syncId).map(n => [n.syncId as string, n._id]));
      const remoteNozzleBySyncId = new Map(remoteNozzles.filter(n => n.syncId).map(n => [n.syncId as string, n._id]));

      // Sync bedtypes before printers AND before filaments: printers now
      // carry installedBedTypes refs (and filament calibrations carry
      // calibrations[].bedType), so the bedType docs + syncId maps must
      // exist before either of those collections is remapped. BedType has
      // no outgoing references of its own, so it's safe to sync this
      // early. Same partial-unique-name index trap as locations — bed
      // types existed before sync was added to this collection set, and
      // duplicate names on first sync would E11000 the cycle. Reconcile
      // by name first to unify the syncIds.
      this.updateStatus({ progress: "Syncing bed types..." });
      await this.reconcileBedTypesByName(localDb, remoteDb);
      results.push(await trySync("bedtypes", [], () =>
        this.syncCollection(localDb, remoteDb, "bedtypes"),
      ));

      // Build bedType syncId→ID maps for printer + filament remap
      const localBedTypes = await localDb.collection("bedtypes").find({ _deletedAt: null }).toArray();
      const remoteBedTypes = await remoteDb.collection("bedtypes").find({ _deletedAt: null }).toArray();
      const localBedTypeBySyncId = new Map(localBedTypes.filter(b => b.syncId).map(b => [b.syncId as string, b._id]));
      const remoteBedTypeBySyncId = new Map(remoteBedTypes.filter(b => b.syncId).map(b => [b.syncId as string, b._id]));

      // Sync printers (filament calibrations reference them; printers
      // themselves reference nozzles + bedtypes, both synced above).
      this.updateStatus({ progress: "Syncing printers..." });
      results.push(await trySync("printers", ["nozzles", "bedtypes"], () =>
        this.syncCollection(
          localDb, remoteDb, "printers",
          (doc, direction) => this.remapPrinterRefs(
            doc, direction,
            localNozzleBySyncId, remoteNozzleBySyncId,
            localBedTypeBySyncId, remoteBedTypeBySyncId,
          ),
        ),
      ));

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
      results.push(await trySync("locations", [], () =>
        this.syncCollection(localDb, remoteDb, "locations"),
      ));

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
      //
      // GH #369 (Codex P1 follow-up): gate on locations succeeding AND
      // wrap in try/catch. Pre-fix the repair ran unconditionally with
      // potentially-stale location maps and on failure threw all the way
      // to the outer catch — collapsing the cycle's partial-success
      // results to [] and the state to "error". Now: skip if upstream
      // failed; swallow + log if the repair itself misbehaves
      // (documented as best-effort).
      const collectionErrored = (name: string): boolean =>
        results.find(r => r.collection === name)?.error != null;
      if (!collectionErrored("locations")) {
        try {
          await this.repairDanglingSpoolLocations(
            localDb, remoteDb, localLocationBySyncId, remoteLocationBySyncId,
          );
        } catch (err) {
          console.error("[sync] repairDanglingSpoolLocations failed (best-effort):", err);
        }
      }

      // Backfill filament syncIds before building maps (syncCollection does this too, but we need maps first)
      await this.backfillSyncIds(localDb.collection("filaments"));
      await this.backfillSyncIds(remoteDb.collection("filaments"));

      // Reconcile same-name filaments across DBs before building the
      // syncId maps. Same first-sync trap as locations + bedtypes — two
      // sides that independently created "PC Blend" carry distinct
      // syncIds, so syncCollection's last-write-wins path tries to
      // updateOne the name into the partial-unique-on-non-deleted
      // `name` index and E11000s the whole cycle (cascading to
      // printhistories via the trySync prerequisite chain). Must run
      // AFTER backfill (reconcileByName trusts existing syncIds when
      // present and only mints when both sides are missing one) and
      // BEFORE the maps below so parentId remapping sees the unified
      // syncId on both sides.
      await this.reconcileFilamentsByName(localDb, remoteDb);

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
      results.push(await trySync(
        "filaments",
        ["nozzles", "bedtypes", "printers", "locations"],
        () => this.syncCollection(localDb, remoteDb, "filaments", filamentTransform),
      ));

      // Repair filaments whose parentId was dropped (or stale) when the
      // syncCollection transform ran. The transform builds its target id
      // map BEFORE the sync inserts — so on a fresh install the local map
      // is empty and every variant's parentId gets nulled on first pull
      // (GH #128). Same shape can also happen for any newly-created
      // parent+variant pair pulled in the same cycle. This pass projects
      // the truth from the *other* side via syncId maps that are now
      // built against the post-sync state of both DBs.
      //
      // GH #369 (Codex P1 follow-up): gate on filaments succeeding AND
      // wrap in try/catch — the repair does updateOne writes and a
      // permissions/transient failure would have escaped to the outer
      // catch, discarding the cycle's partial-success results.
      if (!collectionErrored("filaments")) {
        try {
          await this.repairFilamentParentIds(
            localDb, remoteDb,
            localFilamentSnapshot, remoteFilamentSnapshot,
          );
        } catch (err) {
          console.error("[sync] repairFilamentParentIds failed (best-effort):", err);
        }
      }

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
      //
      // GH #369 (Codex P1 follow-up): needs BOTH printers and filaments
      // to have synced — the amsSlots[].filamentId remap reads from the
      // freshly-rebuilt filament map (so filaments must be current) and
      // writes to printer documents (so a broken-printer-sync state
      // shouldn't be further mutated).
      if (!collectionErrored("printers") && !collectionErrored("filaments")) {
        try {
          await this.repairPrinterAmsSlots(
            localDb, remoteDb,
            localFilPostBySyncId, remoteFilPostBySyncId,
          );
        } catch (err) {
          console.error("[sync] repairPrinterAmsSlots failed (best-effort):", err);
        }
      }

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
      results.push(await trySync(
        "printhistories",
        ["printers", "filaments"],
        () => this.syncCollection(localDb, remoteDb, "printhistories", printHistoryTransform),
      ));

      // Sync shared catalogs. Payload is denormalised at publish time so
      // there are no outbound refs to remap — straight syncId-keyed
      // last-write-wins between the two sides.
      this.updateStatus({ progress: "Syncing shared catalogs..." });
      results.push(await trySync("sharedcatalogs", [], () =>
        this.syncCollection(localDb, remoteDb, "sharedcatalogs"),
      ));

      // GH #369: decide the cycle-level state from the per-collection
      // breakdown. All-clean → idle; some-but-not-all errored → partial
      // (recoverable, renderer shows amber); every collection errored →
      // error (likely cycle-level, e.g. auth failure that fired on every
      // collection identically). The `error` field summarises which
      // collections failed so the user knows what to re-run without
      // expanding the tooltip.
      // GH #369 (Codex follow-up): the summary must carry the underlying
      // failure message, not just the collection-name list. The auth-error
      // case (Atlas user missing readWrite) hits every collection with the
      // *same* wrapped, actionable message — dropping it to a count would
      // strand the user with "7 collections failed: ..." and no hint to
      // re-enter the connection string in Settings → Connection.
      //
      // Group errors by message so a homogeneous failure (every collection
      // returning the same wrapped text — auth, network drop, etc.) shows
      // the actionable text ONCE prefixed by all affected collections;
      // heterogeneous failures (one collection broke + others cascade-
      // skipped with prerequisite-named messages) list each group on its
      // own. " | " is the separator because the renderer renders status
      // .error with `break-words` and a single character keeps copy/paste
      // clean for bug reports.
      const erroredResults = results.filter(r => r.error);
      const erroredAll = erroredResults.length === results.length;
      const erroredSome = erroredResults.length > 0;
      let summary: string | null = null;
      if (erroredSome) {
        const byMessage = new Map<string, string[]>();
        for (const r of erroredResults) {
          const list = byMessage.get(r.error!) ?? [];
          list.push(r.collection);
          byMessage.set(r.error!, list);
        }
        summary = Array.from(byMessage.entries())
          .map(([msg, colls]) => `${colls.join(", ")}: ${msg}`)
          .join(" | ");
      }

      this.updateStatus({
        state: erroredAll ? "error" : erroredSome ? "partial" : "idle",
        lastSyncAt: new Date().toISOString(),
        error: summary,
        progress: null,
      });

      if (erroredAll) this.emit("syncError", summary ?? "Sync failed");
      this.emit("syncComplete", results);
      return results;
    } catch (err) {
      const safe = wrapSyncErrorMessage(err, getDbNameFromUri(this.atlasUri));
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
        // Local-only: push to remote.
        //
        // GH #439: catch E11000 on `syncId` and treat as a no-op. Two
        // processes pointed at the same Atlas (desktop client + Docker
        // instance, two desktops sharing an Atlas) can both pass this
        // "local-only" branch concurrently when their first sync
        // cycles overlap. The `syncId` unique index is the right place
        // to serialize them; the loser of the race just observes the
        // doc already exists. Without this branch the second insert
        // bubbled up as a collection-level failure in `trySync` and
        // the whole sync cycle reported "partial".
        const doc = this.stripForTransfer(localDoc);
        const transformed = transformDoc ? transformDoc(doc, "toRemote") : doc;
        try {
          await remoteCol.insertOne({ ...transformed, _id: new ObjectId() });
          result.pushed++;
        } catch (err: unknown) {
          if (!isDuplicateKeyError(err)) throw err;
          // Other process won the race — the doc is already there,
          // future cycles will see it via the existing-on-both branch.
        }
      } else if (!localDoc && remoteDoc) {
        // Remote-only: pull to local. Same E11000 guard symmetry — a
        // concurrent sync from another instance could have already
        // pulled the same doc to a shared local store.
        const doc = this.stripForTransfer(remoteDoc);
        const transformed = transformDoc ? transformDoc(doc, "toLocal") : doc;
        try {
          await localCol.insertOne({ ...transformed, _id: new ObjectId() });
          result.pulled++;
        } catch (err: unknown) {
          if (!isDuplicateKeyError(err)) throw err;
        }
      } else if (localDoc && remoteDoc) {
        // Both exist: handle conflicts
        const localDeleted = localDoc._deletedAt != null;
        const remoteDeleted = remoteDoc._deletedAt != null;
        const localPurged = localDoc._purged === true;
        const remotePurged = remoteDoc._purged === true;

        // `_purged` is the "delete forever" tombstone (see Filament model
        // doc comment). It's a one-way flag — once set on either peer, it
        // wins over any other state, including a remote update that
        // happened after the local purge. Without this branch, a hard
        // delete on one peer was getting resurrected from the other side
        // on the next sync cycle (#213).
        if (localPurged || remotePurged) {
          if (localPurged && !remotePurged) {
            await remoteCol.updateOne(
              { _id: remoteDoc._id },
              { $set: { _purged: true, _deletedAt: localDoc._deletedAt ?? new Date() } },
            );
            result.deleted++;
          } else if (!localPurged && remotePurged) {
            await localCol.updateOne(
              { _id: localDoc._id },
              { $set: { _purged: true, _deletedAt: remoteDoc._deletedAt ?? new Date() } },
            );
            result.deleted++;
          }
          // else: both already purged — nothing to do
          continue;
        }

        if (localDeleted && remoteDeleted) {
          // Both soft-deleted (in trash) — nothing to do
          continue;
        }

        if (localDeleted && !remoteDeleted) {
          // Deleted locally — propagate if the deletion is at least as
          // recent as the remote update. GH #317: `>=` (not `>`) so the
          // delete wins on a timestamp tie — an equal-millisecond
          // delete-right-after-edit must not resurrect the row. NaN-safe
          // via readTimestamp ?? 0.
          const localDeletedAt = SyncService.readTimestamp(localDoc._deletedAt) ?? 0;
          const remoteUpdatedAt = SyncService.readUpdatedAt(remoteDoc) ?? 0;
          if (localDeletedAt >= remoteUpdatedAt) {
            await remoteCol.updateOne({ _id: remoteDoc._id }, { $set: { _deletedAt: localDoc._deletedAt } });
            result.deleted++;
          } else {
            // Remote was updated strictly after local delete — resurrect locally
            const doc = this.stripForTransfer(remoteDoc);
            const transformed = transformDoc ? transformDoc(doc, "toLocal") : doc;
            await localCol.updateOne({ _id: localDoc._id }, { $set: { ...transformed, _deletedAt: null } });
            result.pulled++;
          }
          continue;
        }

        if (!localDeleted && remoteDeleted) {
          // Mirror of the branch above — delete wins on a tie (GH #317).
          const remoteDeletedAt = SyncService.readTimestamp(remoteDoc._deletedAt) ?? 0;
          const localUpdatedAt = SyncService.readUpdatedAt(localDoc) ?? 0;
          if (remoteDeletedAt >= localUpdatedAt) {
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

        // Both active — last-write-wins. GH #317: NaN-safe timestamps so
        // a doc missing `updatedAt` doesn't stall the merge (it sorts as
        // epoch 0 rather than making every comparison false).
        const localTime = SyncService.readUpdatedAt(localDoc) ?? 0;
        const remoteTime = SyncService.readUpdatedAt(remoteDoc) ?? 0;

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
   * Same name-collision resolver, applied to filaments. Filament has the
   * partial-unique-on-non-deleted `name` index too, and the same
   * independent-creation shape ("PC Blend" minted on both desktop and
   * Atlas before they ever talked) lands as different local syncIds —
   * syncCollection then treats them as two rows and either insertOne or
   * updateOne walks into the index and E11000s, aborting the cycle (and
   * cascading-skipping printhistories via the `trySync` prerequisite
   * chain added in #369). Unifying the syncIds here turns the pair into
   * a normal last-write-wins merge.
   */
  private async reconcileFilamentsByName(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
  ): Promise<void> {
    await this.reconcileByName(localDb, remoteDb, "filaments");
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
    return SyncService.readTimestamp(doc.updatedAt);
  }

  /**
   * Parse any timestamp-ish value (Date | ISO string | epoch ms) to
   * epoch milliseconds. Returns undefined for a missing or unparseable
   * value, so callers can apply an explicit fallback.
   *
   * GH #317: the conflict-resolution comparisons used
   * `new Date(value).getTime()` directly — a doc missing `updatedAt`
   * yielded NaN, every `NaN > x` / `NaN >= x` comparison was false, and
   * the row never synced in either direction (a silent stall). Callers
   * now do `readTimestamp(...) ?? 0` so a missing timestamp is treated
   * as "epoch", not NaN.
   */
  private static readTimestamp(value: unknown): number | undefined {
    // GH #317 (Codex review): only `null`/`undefined` counts as
    // "missing". A `!value` check also swallowed a numeric `0` — a
    // legitimate epoch timestamp — making an `updatedAt: 0` row look
    // untimed and altering conflict resolution.
    if (value == null) return undefined;
    if (value instanceof Date) {
      const t = value.getTime();
      return Number.isNaN(t) ? undefined : t;
    }
    if (typeof value === "string") {
      const t = Date.parse(value);
      return Number.isNaN(t) ? undefined : t;
    }
    if (typeof value === "number") {
      return Number.isNaN(value) ? undefined : value;
    }
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
    localBedTypeBySyncId: Map<string, ObjectId>,
    remoteBedTypeBySyncId: Map<string, ObjectId>,
  ): Document {
    // Remap an array of cross-DB ObjectId refs: source-side id → syncId →
    // target-side id. Refs that don't resolve (no syncId, or the target
    // doc isn't synced yet) are dropped — same as the original
    // installedNozzles handling.
    const remapRefArray = (
      ids: unknown,
      sourceMap: Map<string, ObjectId>,
      targetMap: Map<string, ObjectId>,
    ): ObjectId[] | undefined => {
      if (!Array.isArray(ids)) return undefined;
      const sourceIdToSyncId = new Map<string, string>();
      for (const [syncId, id] of sourceMap) {
        sourceIdToSyncId.set(id.toString(), syncId);
      }
      return ids
        .map((id: ObjectId) => {
          const syncId = sourceIdToSyncId.get(id.toString());
          return syncId ? targetMap.get(syncId) : null;
        })
        .filter(Boolean) as ObjectId[];
    };

    const nozzleSource = direction === "toLocal" ? remoteNozzleBySyncId : localNozzleBySyncId;
    const nozzleTarget = direction === "toLocal" ? localNozzleBySyncId : remoteNozzleBySyncId;
    const remappedNozzles = remapRefArray(doc.installedNozzles, nozzleSource, nozzleTarget);
    if (remappedNozzles !== undefined) doc.installedNozzles = remappedNozzles;

    // installedBedTypes — same cross-DB remap as installedNozzles. Bed
    // types are a shared catalog (one bed type, many printers), but the
    // ObjectId still differs per database, so the ref must be translated
    // through syncId just like nozzles. bedtypes are synced before
    // printers (see the sync order in performSync) so the target docs
    // already exist when this runs.
    const bedSource = direction === "toLocal" ? remoteBedTypeBySyncId : localBedTypeBySyncId;
    const bedTarget = direction === "toLocal" ? localBedTypeBySyncId : remoteBedTypeBySyncId;
    const remappedBedTypes = remapRefArray(doc.installedBedTypes, bedSource, bedTarget);
    if (remappedBedTypes !== undefined) doc.installedBedTypes = remappedBedTypes;

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

import mongoose from "mongoose";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  uri: string | null;
  /** GH #898 — the in-flight migration run, so two concurrent first-connects
   *  can't both execute the migration block (the nozzle-split pass would mint
   *  duplicate clones). Null when no run is in progress. */
  migrationsPromise: Promise<void> | null;
  /** Per-migration completion flags. Each migration only runs until it
   * succeeds — a transient failure (network blip, MongoDB busy) won't
   * permanently mark the migration done, so the next request will retry
   * instead of leaving the install stuck on stale data/index state.
   *
   * GH #457 — the `instanceIds` backfill that used to run here was
   * retired in v1.32.x: it predates v1.0 and any production install
   * has been backfilled long ago. The flag was removed from this
   * cache shape; if you ever see legacy callsites referencing
   * `cached.migrations.instanceIds`, they're safe to drop. */
  migrations: {
    instanceIds: boolean;
    /** GH #732 — backfill a per-spool `instanceId` onto every spool that
     * lacks one (the first missing spool adopts the filament's id, the rest
     * get fresh ids). Idempotent: count === 0 on a fresh / already-migrated
     * install and the flag flips on first connect. */
    spoolInstanceIds: boolean;
    sharedCatalogIndexes: boolean;
    /** GH #232 — split nozzles that are referenced by >1 printer into
     * one physical instance per printer. Idempotent: on a clean DB the
     * pass finds no duplicates and the flag is set on first connect. */
    nozzlePhysicalInstances: boolean;
    /** GH #303 — run syncIndexes() on the core models so a pre-existing
     * plain unique `name` (or `instanceId`) index is dropped and rebuilt
     * as the partial-unique-on-non-deleted index the schema declares. */
    coreModelIndexes: boolean;
    /** GH #1004 F1 — re-tombstone "zombie" rows: filaments carrying
     * `_purged: true` while ACTIVE (`_deletedAt: null`). The pre-#1004
     * CSV/XLSX importer could resurrect a purge tombstone without
     * clearing the flag; such rows poison hybrid sync (the engine
     * short-circuits on `_purged` before LWW) and vanish unrecoverably
     * if re-trashed. Their intended state is gone-forever, so restore
     * `_deletedAt`. Idempotent: matches 0 rows on healthy installs. */
    purgedZombies: boolean;
    /** GH #1008 F1 (Codex P1 on #1016) — normalize legacy 100-based
     * `shrinkageXY` values. The pre-#1016 Bambu/Orca importer stored
     * `filament_shrink` RAW, so a stock profile's "98%" (remaining size)
     * persisted as `shrinkageXY: 98` — which the convention-aware export
     * would double-convert into catastrophic compensation ("2% of size").
     * Real 0-based shrinkage is physically ≤ ~10% while legacy remaining-size
     * values are ~90–100, so `>= 50` is an unambiguous separator. Idempotent:
     * a converted value lands in [0, 50] — below the threshold for every real
     * input, and the x = 50 boundary maps to itself (a no-op re-match). */
    legacyShrinkage: boolean;
  };
}

declare global {
  var mongoose: MongooseCache | undefined;
}

/**
 * True for a MongoDB duplicate-key error (E11000). `syncIndexes()` throws this
 * when it tries to build a UNIQUE index on a collection that already holds
 * duplicate values on that key — stale DATA a retry can never fix. Matched by
 * the driver's numeric `code` first, with a message fallback for wrappers that
 * don't surface `.code`. Used by the `coreModelIndexes` migration to treat a
 * dup-key index build as terminal instead of retrying it forever (#955.14).
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === 11000) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /E11000|duplicate key/i.test(message);
}

export default async function dbConnect() {
  const MONGODB_URI = process.env.MONGODB_URI;

  if (!MONGODB_URI) {
    throw new Error(
      "Please define the MONGODB_URI environment variable in .env.local"
    );
  }

  const cached: MongooseCache = global.mongoose ?? {
    conn: null,
    promise: null,
    uri: null,
    migrationsPromise: null,
    migrations: { instanceIds: false, spoolInstanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false, coreModelIndexes: false, purgedZombies: false, legacyShrinkage: false },
  };

  if (!global.mongoose) {
    global.mongoose = cached;
  }

  // If URI changed (e.g., switched from local to Atlas), reconnect — and
  // re-run migrations against the new database.
  if (cached.conn && cached.uri !== MONGODB_URI) {
    await mongoose.disconnect();
    cached.conn = null;
    cached.promise = null;
    cached.uri = null;
    cached.migrationsPromise = null;
    cached.migrations = { instanceIds: false, spoolInstanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false, coreModelIndexes: false, purgedZombies: false, legacyShrinkage: false };
  }

  // GH #312: a cached connection can go dead after a DB outage or an
  // Atlas failover. mongoose.connection.readyState === 1 means
  // "connected"; anything else (0 disconnected, 2 connecting,
  // 3 disconnecting) means the cached handle is stale. Drop it so the
  // reconnect path below runs instead of returning a dead handle.
  if (cached.conn && mongoose.connection.readyState !== 1) {
    cached.conn = null;
    cached.promise = null;
  }

  // Short-circuit only when both the connection AND all migrations are
  // settled. Without checking migrations, a transient failure on first
  // connect would never get retried — the next call would hit this
  // early return and skip the migration block entirely.
  if (
    cached.conn &&
    cached.migrations.instanceIds &&
    cached.migrations.spoolInstanceIds &&
    cached.migrations.sharedCatalogIndexes &&
    cached.migrations.nozzlePhysicalInstances &&
    cached.migrations.coreModelIndexes &&
    cached.migrations.purgedZombies &&
    cached.migrations.legacyShrinkage
  ) {
    return cached.conn;
  }

  if (!cached.conn) {
    if (!cached.promise) {
      cached.uri = MONGODB_URI;
      cached.promise = mongoose.connect(MONGODB_URI).catch((err) => {
        cached.promise = null;
        throw err;
      });
    }
    cached.conn = await cached.promise;
  }

  // GH #898: serialize the migration block behind ONE in-flight promise so two
  // concurrent first-connects can't both run it. The GH#232 nozzle-split pass
  // reads the duplicate set and mints clones; running it twice in parallel
  // creates duplicate "Name #N" clones. The per-migration flags below still make
  // each step idempotent + independently retryable — this only collapses
  // concurrent runs into one. In-process only; a multi-process deployment (two
  // desktops / desktop + Docker on one Atlas DB) would still need a DB-level
  // lock, which is out of scope for #898.
  if (cached.migrationsPromise) {
    await cached.migrationsPromise;
    return cached.conn;
  }
  const runMigrations = async (): Promise<void> => {
  // GH #1004 F1 — repair "zombie" filaments: `_purged: true` while ACTIVE
  // (`_deletedAt: null`). The pre-#1004 CSV/XLSX importer could resurrect a
  // purge tombstone without clearing the flag; the row then renders in the
  // app while hybrid sync treats it as a one-way tombstone (propagating
  // `_purged` onto the peer and never syncing its edits), and a later
  // soft-delete makes it vanish from the trash entirely. Gone-forever is
  // the row's intended state, so restore `_deletedAt`. Idempotent — the
  // filter matches nothing on healthy installs.
  if (!cached.migrations.purgedZombies) {
    try {
      const { default: Filament } = await import("@/models/Filament");
      const res = await Filament.updateMany(
        { _purged: true, _deletedAt: null },
        { $set: { _deletedAt: new Date() } },
      );
      if (res.modifiedCount > 0) {
        console.log(
          `[migration] Re-tombstoned ${res.modifiedCount} purged zombie filament(s) (GH #1004)`,
        );
      }
      cached.migrations.purgedZombies = true;
    } catch (err) {
      console.error(
        "[migration] Failed to repair purged zombie filaments (will retry on next connect):",
        err,
      );
    }
  }

  // GH #1008 F1 (Codex P1 on #1016) — normalize legacy 100-based shrinkageXY.
  // The pre-#1016 Bambu/Orca importer stored `filament_shrink` raw, so a stock
  // profile's "98%" (Orca remaining-size) persisted as `shrinkageXY: 98`; the
  // convention-aware export would double-convert that into "2%" — a
  // shrink-to-2%-of-size compensation. Real 0-based shrinkage is physically
  // ≤ ~10% while legacy remaining-size values sit at ~90–100, so `>= 50`
  // separates them unambiguously (the schema caps the field at 100, so the
  // pipeline result always lands back in [0, 50]). Idempotent: a converted
  // value sits below the threshold for every real input; the x = 50 boundary
  // maps to itself, a no-op re-match.
  if (!cached.migrations.legacyShrinkage) {
    try {
      const { default: Filament } = await import("@/models/Filament");
      // Raw driver call: Mongoose's update-casting layer rejects the
      // aggregation-pipeline form; the driver supports it natively.
      const res = await Filament.collection.updateMany({ shrinkageXY: { $gte: 50 } }, [
        { $set: { shrinkageXY: { $subtract: [100, "$shrinkageXY"] } } },
      ]);
      if (res.modifiedCount > 0) {
        console.log(
          `[migration] Normalized ${res.modifiedCount} legacy 100-based shrinkageXY value(s) (GH #1008)`,
        );
      }
      cached.migrations.legacyShrinkage = true;
    } catch (err) {
      console.error(
        "[migration] Failed to normalize legacy shrinkage values (will retry on next connect):",
        err,
      );
    }
  }

  // GH #732 — the 5-byte hex identity is moving from the filament to the
  // spool. Backfill a per-spool `instanceId` onto every spool that lacks one
  // so existing installs converge on first connect after upgrade. The first
  // id-less spool of each filament adopts the filament's own `instanceId`
  // (keeping already-printed labels / written NFC tags resolvable once the
  // match path looks at spools), the rest get fresh ids. Cheap on fresh /
  // already-migrated installs (count === 0, flag flips immediately); the
  // retry tracking makes a transient blip recoverable on the next request.
  //
  // ORDER MATTERS: this runs BEFORE the filament-level `backfillInstanceIds`
  // below. Carry-over reads each filament's *existing* `instanceId`, so it
  // must see the pre-upgrade value — for a legacy filament that already had a
  // real id (printed on a label / written to a tag) the first spool adopts
  // that real id, while a filament that never had one leaves `doc.instanceId`
  // absent so all its spools get fresh per-spool ids. If the filament backfill
  // ran first it would mint a brand-new filament id and the spool would
  // "carry over" a value that was never on any tag — defeating the point.
  // Both backfills still precede the `coreModelIndexes` syncIndexes() pass.
  if (!cached.migrations.spoolInstanceIds) {
    try {
      const { backfillSpoolInstanceIds } = await import("@/models/Filament");
      const count = await backfillSpoolInstanceIds();
      if (count > 0) {
        console.log(`[migration] Backfilled instanceId for ${count} spool(s)`);
      }
      cached.migrations.spoolInstanceIds = true;
    } catch (err) {
      console.error("[migration] Failed to backfill spool instanceIds (will retry on next connect):", err);
    }
  }

  // GH #457 — RESTORED (Codex P1 on PR #467): the per-startup
  // `backfillInstanceIds` pass cannot be retired safely. The
  // `coreModelIndexes` migration below calls `Filament.syncIndexes()`,
  // and the Filament schema declares a unique partial index on
  // `instanceId`. MongoDB treats missing single-field values in a
  // unique index as `null`, so a DB with >1 active filament missing
  // `instanceId` would E11000 the index build, and the migration
  // would retry forever instead of converging.
  //
  // The backfill is cheap on fresh / already-migrated installs
  // (count === 0, flag flips immediately) and the retry tracking
  // ensures a transient blip is recoverable on the next request.
  //
  // GATED ON spoolInstanceIds (GH #732, Codex P2): this MUST NOT run until the
  // spool backfill above has succeeded. Otherwise, if the spool backfill threw
  // (transient failure, caught above), minting a fresh filament id here would
  // make the next retry's carry-over adopt that brand-new id into the first
  // spool — breaking the guarantee that a legacy filament which never had an id
  // gives its spools FRESH per-spool ids, not an id invented during the upgrade.
  // The dependent coreModelIndexes pass also retries until both succeed.
  if (cached.migrations.spoolInstanceIds && !cached.migrations.instanceIds) {
    try {
      const { backfillInstanceIds } = await import("@/models/Filament");
      const count = await backfillInstanceIds();
      if (count > 0) {
        console.log(`[migration] Backfilled instanceId for ${count} filament(s)`);
      }
      cached.migrations.instanceIds = true;
    } catch (err) {
      console.error("[migration] Failed to backfill instanceIds (will retry on next connect):", err);
    }
  }

  // One-time migrations on first connect after process start. Each
  // migration tracks its own success flag — a transient failure on one
  // doesn't poison the cache for the rest, and the next request retries
  // any that didn't complete instead of skipping the whole block.
  // SharedCatalog's slug index changed from a plain unique index to
  // a partial-unique-on-_deletedAt-null index when soft-delete landed.
  // MongoDB won't mutate existing index options in-place, so on
  // existing installs the old `slug_1` index keeps enforcing global
  // uniqueness (including over tombstoned rows). syncIndexes() drops
  // indexes that don't match the current schema and recreates them
  // with the new options — idempotent on fresh databases (the indexes
  // already match), corrective on upgraded ones.
  if (!cached.migrations.sharedCatalogIndexes) {
    try {
      const SharedCatalog = (await import("@/models/SharedCatalog")).default;
      const dropped = await SharedCatalog.syncIndexes();
      if (dropped.length > 0) {
        console.log(`[migration] Rebuilt SharedCatalog indexes (dropped: ${dropped.join(", ")})`);
      }
      cached.migrations.sharedCatalogIndexes = true;
    } catch (err) {
      console.error("[migration] Failed to sync SharedCatalog indexes (will retry on next connect):", err);
    }
  }

  // GH #303: Filament / Location / BedType / Nozzle / Printer all declare
  // a partial-unique index on `name` (and Filament also on `instanceId`,
  // GH #302). Mongoose's autoIndex builds *missing* indexes but will not
  // drop a pre-existing plain unique index and replace it with the
  // partial one. On any DB whose `name` index predates the partial-index
  // change, the soft-delete name-reuse feature silently fails with
  // E11000. syncIndexes() drops mismatched indexes and recreates them —
  // idempotent on fresh DBs, corrective on upgraded ones. Same
  // retry-tracked pattern as the SharedCatalog block above.
  //
  // GATED ON BOTH instanceId backfills (#955.14, Codex re-review): this MUST NOT
  // run until every active filament has an `instanceId`. Building the
  // partial-unique `instanceId` index over legacy rows the backfill hasn't
  // filled yet E11000s on the SHARED null value — but that's exactly what the
  // backfill repairs, so it's transient, NOT terminal. If the backfills throw
  // transiently (leaving their flags false) and this ran anyway, the terminal
  // E11000 handling below would mark the flag done and PERMANENTLY skip the
  // rebuild even after the backfill later succeeds — until a process restart.
  // Gating means that once we DO run, a remaining E11000 can only be genuine
  // duplicate ACTIVE rows (dup name or dup real instanceId), which is terminal.
  // In the common single-pass connect both backfills succeed just above, so the
  // gate is already satisfied and this runs in the same pass.
  if (
    cached.migrations.spoolInstanceIds &&
    cached.migrations.instanceIds &&
    !cached.migrations.coreModelIndexes
  ) {
    try {
      const models = await Promise.all([
        import("@/models/Filament"),
        import("@/models/Location"),
        import("@/models/BedType"),
        import("@/models/Nozzle"),
        import("@/models/Printer"),
      ]);
      // #955.14: sync each model INDEPENDENTLY, and treat a duplicate-key
      // (E11000) failure as TERMINAL rather than retryable. Because this block is
      // gated on the instanceId backfills above, a syncIndexes() E11000 here can
      // only be genuine duplicate active rows on a unique field (`name` / a real
      // `instanceId`) — a DATA problem no retry can fix. Before this,
      // that error escaped the shared try, left `coreModelIndexes` false, and
      // the whole block re-ran on EVERY subsequent request — re-throwing and
      // re-logging forever, and doing wasted index work per request. Now a
      // dup-key error is caught per model, logged ONCE with actionable
      // guidance, and the loop moves on so the flag still converges to true
      // (the block never re-enters ⇒ the log fires once). A TRANSIENT
      // (non-E11000) failure is re-thrown to the outer catch, which leaves the
      // flag unset so the next connect genuinely retries.
      for (const mod of models) {
        const model = mod.default;
        try {
          const dropped = await model.syncIndexes();
          if (dropped.length > 0) {
            console.log(
              `[migration] Rebuilt ${model.modelName} indexes (dropped: ${dropped.join(", ")})`,
            );
          }
        } catch (err) {
          if (isDuplicateKeyError(err)) {
            console.error(
              `[migration] ${model.modelName}: cannot build a unique index — the collection has duplicate ACTIVE rows on a unique field (name/instanceId). A retry can't fix stale data, so this index is being SKIPPED (other migrations continue). Resolve the duplicates (rename or trash one of each colliding pair) and restart to build it.`,
              err,
            );
            // Terminal — fall through to the next model. Do NOT re-throw:
            // re-throwing would leave the flag false and loop forever.
          } else {
            // Transient (network blip, DB busy) — a retry may succeed, so bubble
            // to the outer catch which leaves the flag unset.
            throw err;
          }
        }
      }
      // Reached only when every model either succeeded or hit a terminal E11000
      // — never after a transient throw. Converge so the block stops running.
      cached.migrations.coreModelIndexes = true;
    } catch (err) {
      console.error("[migration] Failed to sync core model indexes (will retry on next connect):", err);
    }
  }

  // GH #232 — split nozzles referenced by >1 printer into one physical
  // instance per printer. The pre-#232 UI let users check the same
  // nozzle on multiple printer forms, treating a Nozzle row as a "spec"
  // when the field name (`installedNozzles`) actually means "physical
  // object currently in this printer." We now enforce one-printer-per-
  // nozzle at the API layer; this migration cleans up upgraded installs
  // that already accumulated duplicates so the new constraint doesn't
  // refuse every subsequent edit.
  //
  // Strategy:
  //   1. Walk all active printers, build a map of nozzleId → printers[]
  //      that reference it.
  //   2. For any nozzle referenced by more than one printer, keep the
  //      FIRST printer's reference unchanged (preserves URLs and any
  //      existing calibration history that points at the nozzle id),
  //      and clone the nozzle into a fresh row for every other printer.
  //   3. Each clone gets a "Name #N" suffix so the user can see the
  //      split happened. Existing peer suffixes are scanned so we don't
  //      collide ("Name #2" already exists → use #3).
  //
  // Idempotent on a clean DB (no duplicates → no writes); resumable on
  // partial failure (the flag isn't set until the pass completes).
  if (!cached.migrations.nozzlePhysicalInstances) {
    try {
      const Printer = (await import("@/models/Printer")).default;
      const Nozzle = (await import("@/models/Nozzle")).default;
      const { nextCloneName, clonePeerNamePattern } = await import("@/lib/nozzleConflicts");

      const printers = await Printer.find({ _deletedAt: null })
        .select("_id name installedNozzles")
        .lean();

      // nozzleId → [{printerId, printerName}]
      const refCount = new Map<
        string,
        { printerId: string; printerName: string }[]
      >();
      for (const p of printers) {
        for (const nid of p.installedNozzles || []) {
          const key = String(nid);
          const list = refCount.get(key) ?? [];
          list.push({ printerId: String(p._id), printerName: p.name });
          refCount.set(key, list);
        }
      }

      let clonesCreated = 0;
      for (const [nozzleId, refs] of refCount.entries()) {
        if (refs.length <= 1) continue;
        // Hydrate the source nozzle once.
        const source = await Nozzle.findOne({
          _id: nozzleId,
          _deletedAt: null,
        }).lean();
        if (!source) continue; // soft-deleted between count and read; skip

        // Existing peer names (for "Name #N" collision avoidance).
        // GH #298: the pattern is anchored at both ends, so it matches
        // only the base name + its numbered clones — not unrelated
        // siblings that merely share a prefix.
        const peers = (await Nozzle.find({
          _deletedAt: null,
          name: { $regex: clonePeerNamePattern(source.name) },
        })
          .select("name")
          .lean()) as { name: string }[];
        const peerNames = peers.map((p) => p.name);

        // First printer keeps the original ref. For every other
        // printer, mint a clone and swap the reference.
        //
        // Codex P1 review on PR #233: the swap must be atomic at the
        // printer-document level. A naive `$pull` followed by
        // `$addToSet` would lose the assignment if the second write
        // fails (transient DB error, process restart) — and the next
        // migration retry wouldn't recover because the nozzle is no
        // longer duplicated in `refCount`. Fix: build the new
        // installedNozzles array client-side and write the whole array
        // back with a single `$set`. If THAT write fails before
        // success, delete the clone so the next retry starts clean
        // (otherwise we'd accumulate orphaned "Name #N" rows on every
        // failed run).
        for (let i = 1; i < refs.length; i++) {
          const printerId = refs[i].printerId;
          const newName = nextCloneName(source.name, peerNames);
          peerNames.push(newName); // reserve the slot for the next iteration
          const clone = await Nozzle.create({
            name: newName,
            diameter: source.diameter,
            type: source.type,
            highFlow: source.highFlow,
            hardened: source.hardened,
            notes: source.notes,
          });

          try {
            // Read the printer's current installedNozzles fresh, build
            // the swapped array, write it back atomically. Done as a
            // single $set so the on-disk state never sees the
            // intermediate "nozzle removed, clone not yet attached"
            // window the split-update version had.
            const fresh = await Printer.findById(printerId)
              .select("installedNozzles")
              .lean();
            if (!fresh) {
              throw new Error(
                `printer ${printerId} disappeared mid-migration`,
              );
            }
            const installed: (mongoose.Types.ObjectId | string)[] =
              fresh.installedNozzles || [];
            const swapped = installed.map((nid) =>
              String(nid) === String(source._id) ? clone._id : nid,
            );
            await Printer.updateOne(
              { _id: printerId },
              { $set: { installedNozzles: swapped } },
            );
            clonesCreated++;
          } catch (swapErr) {
            // The atomic-swap write failed (or the printer was deleted
            // out from under us). Roll back the clone we just minted
            // so the next migration retry sees the original duplicate
            // state and re-tries from scratch — otherwise the
            // collection accumulates an orphan "Name #N" with no
            // printer holding it.
            await Nozzle.deleteOne({ _id: clone._id }).catch(() => {
              // Best-effort cleanup. If the cleanup also fails, the
              // orphan is visible in /nozzles and the user can prune;
              // surfacing the original swap error is more important.
            });
            throw swapErr;
          }
        }
      }

      if (clonesCreated > 0) {
        console.log(
          `[migration] Split duplicated nozzles across printers — created ${clonesCreated} clone(s)`,
        );
      }
      cached.migrations.nozzlePhysicalInstances = true;
    } catch (err) {
      console.error(
        "[migration] Failed to split duplicated nozzles (will retry on next connect):",
        err,
      );
    }
  }
  }; // end runMigrations

  cached.migrationsPromise = runMigrations();
  try {
    await cached.migrationsPromise;
  } finally {
    // Clear the in-flight handle so a future connect can re-attempt any
    // migration whose flag didn't flip (each step's own try/catch leaves its
    // flag false on failure); completed steps short-circuit on the retry.
    cached.migrationsPromise = null;
  }

  return cached.conn;
}

import mongoose from "mongoose";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  uri: string | null;
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
    sharedCatalogIndexes: boolean;
    /** GH #232 — split nozzles that are referenced by >1 printer into
     * one physical instance per printer. Idempotent: on a clean DB the
     * pass finds no duplicates and the flag is set on first connect. */
    nozzlePhysicalInstances: boolean;
    /** GH #303 — run syncIndexes() on the core models so a pre-existing
     * plain unique `name` (or `instanceId`) index is dropped and rebuilt
     * as the partial-unique-on-non-deleted index the schema declares. */
    coreModelIndexes: boolean;
  };
}

declare global {
  var mongoose: MongooseCache | undefined;
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
    migrations: { instanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false, coreModelIndexes: false },
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
    cached.migrations = { instanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false, coreModelIndexes: false };
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
    cached.migrations.sharedCatalogIndexes &&
    cached.migrations.nozzlePhysicalInstances &&
    cached.migrations.coreModelIndexes
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
  if (!cached.migrations.instanceIds) {
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
  if (!cached.migrations.coreModelIndexes) {
    try {
      const models = await Promise.all([
        import("@/models/Filament"),
        import("@/models/Location"),
        import("@/models/BedType"),
        import("@/models/Nozzle"),
        import("@/models/Printer"),
      ]);
      for (const mod of models) {
        const model = mod.default;
        const dropped = await model.syncIndexes();
        if (dropped.length > 0) {
          console.log(
            `[migration] Rebuilt ${model.modelName} indexes (dropped: ${dropped.join(", ")})`,
          );
        }
      }
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

  return cached.conn;
}

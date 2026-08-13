import { EventEmitter } from "events";
import { createHash, randomBytes, randomUUID } from "crypto";
import { MongoClient, ObjectId, Document, type Db } from "mongodb";
import { ConnectionString } from "mongodb-connection-string-url";
import {
  clearLegacyNozzleConditionsOnce,
  deriveLegacyNozzleCondition,
  LEGACY_NOZZLE_CONDITION_RE,
  type MinimalDb,
} from "../src/lib/legacyNozzleConditions";
import {
  trimEntityNames,
  describeTrimResult,
  type MinimalTrimDb,
} from "../src/lib/trimEntityNames";
import {
  isGeneratedPlaceholder,
  isStagingPlaceholder,
  placeholderRestoreTarget,
  STAGING_PREFIX,
  placeholderFor,
  planRenameStaging,
  pendingRenameCanFreeName,
  strandedPlaceholderNotice,
  withStrandingNotice,
  strandingNoticeOf,
  CAUSE_LEAD,
} from "../src/lib/renameStaging";
import {
  repairMalformedTombstones,
  TOMBSTONE_COLLECTIONS,
  type MinimalTombstoneCollection,
} from "../src/lib/malformedTombstones";
import {
  retombstonePurgedZombies,
  type MinimalZombieCollection,
} from "../src/lib/purgedZombies";

/** GH #1021 r25/r26: one pending legacy-condition transit clear — direction,
 * syncId, the observed condition + updatedAt (the conditional-write filter),
 * and the provenance to revalidate on every attempt (own refs, else the
 * source parentId). Persisted in the local `_migrations` queue. */
interface LegacyTransitEntry {
  d: "toLocal" | "toRemote";
  s: string;
  c: string;
  u: unknown;
  p: unknown;
  r: unknown[] | null;
}

/** GH #1153: one durable staging-restore record — written BEFORE a row is
 * moved aside, so a later cycle can put it back no matter how this one ends.
 * Lives in the `_migrations` doc `_id: "renameStagingRestores"` on the SAME
 * database as the staged row (each DB's queue describes its own rows).
 * c=collection, i=String(_id), o=originalName, p=placeholderName. */
interface RenameStagingRestoreKey {
  c: string;
  i: string;
  o: string;
  p: string;
}

interface RenameStagingRestoreEntry extends RenameStagingRestoreKey {
  /** Enqueue time. The sweep refuses to touch entries younger than
   * `SWEEP_MIN_AGE_MS` — see that constant for the two races this closes. */
  at: Date;
}

/**
 * How old a restore entry must be before another pass's sweep may act on it
 * (GH #1153, Codex P2). Two services can share one database — the desktop
 * client and a Docker instance against the same Atlas is the documented
 * GH #439 reality — and an entry is durable BEFORE its row is staged. In that
 * enqueue-to-update window the row still holds its original name, so a
 * concurrent sweep read the record as resolved and DRAINED it; the owning
 * pass then staged and could crash without the durable record this queue
 * exists to guarantee. The same blindness let a sweep restore a placeholder
 * an active pass was still using. Age is the discriminator: a pass's own
 * staging-to-settlement span is seconds, so an entry older than this bound
 * belongs to a DEAD pass. Fifteen minutes dwarfs both any plausible pass and
 * cross-service clock skew (the stamp is written by one service's clock and
 * compared by another's); the cost is that a genuine stranding waits one
 * bound before healing — it already waited at least a full cycle.
 */
const SWEEP_MIN_AGE_MS = 15 * 60 * 1000;

const RESTORE_QUEUE_ID = "renameStagingRestores";

/** Structural validation for queue entries read back from disk — a malformed
 * entry is dropped rather than allowed to abort its collection's sweep. */
function isRestoreEntry(value: unknown): value is RenameStagingRestoreEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.c === "string" &&
    typeof e.i === "string" &&
    ObjectId.isValid(e.i) &&
    typeof e.o === "string" &&
    e.o !== "" &&
    typeof e.p === "string" &&
    isStagingPlaceholder(e.p) &&
    e.at instanceof Date &&
    !Number.isNaN(e.at.getTime())
  );
}

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
 * A duplicate-key violation on the unique `name` index (GH #1142).
 *
 * Distinct from `isDuplicateKeyError`, which deliberately matches only
 * `syncId` — that one means "another process already inserted this row", a
 * benign race. A `name` violation means two DIFFERENT records want one name,
 * which needs the staging path rather than a shrug.
 */
export function isNameDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (e.code !== 11000) return false;
  if (!e.keyPattern || typeof e.keyPattern !== "object") return false;
  return Object.prototype.hasOwnProperty.call(e.keyPattern, "name");
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
 *
 * GH #1071: parse with the driver's own `ConnectionString` (from
 * `mongodb-connection-string-url`, a direct dependency of `mongodb`),
 * NOT `new URL()` on a scheme-swapped string. A standard multi-host URI
 * (`mongodb://u:p@h1:27017,h2:27017/mydb?replicaSet=rs0` — a self-hosted
 * replica set, or Atlas's non-SRV form) has a comma in the authority,
 * which made the WHATWG URL parser throw — so the old implementation
 * silently fell back to "filament-db" and hybrid sync targeted the WRONG
 * database (the connectivity check is db-agnostic, so it still reported
 * success). ConnectionString handles multi-host, SRV, percent-encoded
 * credentials and query strings identically to MongoClient. The
 * try/catch stays for genuinely malformed URIs.
 */
export function getDbNameFromUri(uri: string): string {
  try {
    const db = new ConnectionString(uri).pathname.replace(/^\//, "");
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
 * Detects the auth shape by structured code first (GH #1154): a present
 * numeric code is authoritative — 13 is mongod's Unauthorized, whose message
 * never matches the regex anyway — and the message regex decides only for
 * code-less errors and for AtlasError 8000, whose shared-tier proxy authors
 * the "user is not allowed to do action" text itself. Any OTHER numeric code
 * suppresses the regex, because value-echoing server errors (E11000 and
 * friends) quote stored data verbatim, and stored data must not be able to
 * steer this message. See GH #143 for the hint itself.
 *
 * ## Composed errors: classify the CAUSE, re-attach the notice (GH #1142)
 *
 * Two things break when a caller wraps a driver error in its own Error, which
 * `strandedPlaceholderError` does:
 *
 *  1. `new Error(msg, {cause})` does NOT inherit `code`, so the "more reliable
 *     signal" above silently disappears — a genuine `code: 13` whose text does
 *     not match the regex used to produce the hint and now produces nothing.
 *     So classification reads through `cause` when there is one.
 *  2. The auth branch REPLACES the whole message, discarding anything the
 *     caller put in it. Ordering cannot save a composed message — the function
 *     never reads the original. So a stranding notice is re-attached at the
 *     END, outside the auth/redact decision, where no present or future
 *     rewriting branch can drop it.
 *
 * The notice is cause-free by construction (see `strandedPlaceholderNotice`),
 * so re-attaching it cannot itself trip the regex on the next pass.
 */
export function wrapSyncErrorMessage(err: unknown, dbName: string): string {
  // Classify the CAUSE when the error carries one — that is where the driver's
  // own message and `code` survive.
  const cause = err instanceof Error && err.cause !== undefined ? err.cause : err;
  const message =
    cause instanceof Error ? cause.message : err instanceof Error ? err.message : "Sync failed";
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? (cause as { code: unknown }).code
      : undefined;

  // A present NUMERIC code is authoritative; the regex decides only for
  // code-less errors and for AtlasError 8000 (GH #1154). The old `regex ||
  // code` sniffed a string that already contains user-controlled data — an
  // E11000 echoes the offending value verbatim, so a row literally named
  // "user is not allowed to do action" turned a name collision into the
  // Atlas-permissions hint. Every value-echoing server error carries a
  // numeric code (11000, BadValue, FailedToParse…), so gating the regex on
  // the code being absent-or-8000 removes the only route by which stored
  // data can steer the message. The 8000 allowance is load-bearing: Atlas's
  // shared-tier proxy raises unauthorized writes as AtlasError 8000 with a
  // message IT authors (never echoing document values), so a literal
  // "code-first, regex only when absent" would silently drop the hint
  // exactly where GH #143 needed it — and CI would stay green, because the
  // existing tests model auth errors as code-less.
  const numericCode = typeof code === "number" ? code : null;
  const isAuthError =
    numericCode === 13 ||
    ((numericCode === null || numericCode === 8000) &&
      /user is not allowed to do action/i.test(message));

  const body = isAuthError
    ? `The Atlas user in your connection string only has read permission for "${dbName}". Update the user's role to one that includes readWrite (or change the connection string to one that does), then try again. You can re-enter the connection string in Settings → Connection.`
    : message;

  // A stranded row needs manual recovery and is announced exactly once, so it
  // survives whichever branch ran above.
  const notice = strandingNoticeOf(err);
  const full = notice ? `${notice} ${CAUSE_LEAD}${body}` : body;

  // Redact LAST, over the WHOLE string: the notice quotes user-typed entity
  // names, and the body may carry a connection string.
  return full.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "mongodb://***");
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
   * GH #369: per-collection error. Other collections in the same cycle may
   * have succeeded, and `trySync` cascade-skips this collection's dependents.
   *
   * Usually the sync THREW and the count fields are zero. GH #1116 adds a
   * second, deliberate producer: a collection whose trim was SKIPPED copies
   * paired rows only, so the counts are NON-zero while some rows were held
   * back. That still has to read as a failed prerequisite — a dependent
   * copied against a partial mapping silently drops the references it could
   * not resolve.
   */
  error?: string | null;
  /**
   * GH #1142: rows whose name could not be applied because a row this pass is
   * NOT moving already holds it. Reported rather than forced — writing anyway
   * would clobber a record the user still wants. Non-fatal for the collection
   * by itself; see the paired/unpaired split where this is consumed.
   */
  nameConflicts?: number;
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
  /** GH #1021 r26: candidates whose durable enqueue failed — carried across
   * cycles in memory so the enqueue is retried until it lands (an
   * equal-timestamp pair never re-copies, so the transform alone cannot
   * rediscover them). Cleared once the batch enqueue succeeds. */
  private pendingLegacyCandidates: LegacyTransitEntry[] = [];
  // #823: set by destroy() so an in-flight cycle stops converging both DBs
  // after the user switches connection mode. Checked before each collection
  // step and each repair pass; the collection already executing finishes (its
  // writes were already in flight), but no subsequent collection/repair runs.
  private aborted = false;

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
    this.aborted = false; // fresh cycle — clear any prior abort (#823)
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
      // #823: a mode switch (destroy()) mid-cycle aborts the rest so we stop
      // writing to a DB the user just abandoned.
      if (this.aborted) {
        return {
          collection: name,
          pushed: 0,
          pulled: 0,
          updated: 0,
          deleted: 0,
          error: "skipped — sync aborted (connection mode changed)",
        };
      }
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

      // GH #1021 (Codex P1 ×2 on #1022): neither database can be assumed clean
      // here. The REMOTE never runs dbConnect at all, and the LOCAL one may not
      // have either — resolveMongoUri() starts this sync via initSyncService()
      // BEFORE the Next server (and its dbConnect migrations) comes up. If a
      // legacy machine-derived nozzle condition rides a NEWER doc on either
      // side, LWW copies it over the cleaned side, and since the cleanup
      // preserves updatedAt the divergence then sticks at equal timestamps
      // forever. So: run the marker-guarded cleanup on BOTH DBs before any
      // collection sync, and treat a failure as a PREREQUISITE failure — abort
      // the cycle (throw → the outer catch reports it; the next cycle retries)
      // rather than syncing stale values around the one-shot cleanup.
      // Codex P2 r18/r19: destroy() can land while the two clients were still
      // connecting — or while the FIRST side's cleanup is awaiting — so the
      // abort flag is re-checked before EACH side's destructive cleanup,
      // matching the mode-switch contract every later step honors (the
      // abandoned databases must not be touched by any subsequent operation).
      for (const [side, dbHandle] of [["local", localDb], ["remote", remoteDb]] as const) {
        if (this.aborted) break;
        const res = await clearLegacyNozzleConditionsOnce(dbHandle as unknown as MinimalDb);
        if (res.ran && res.cleared > 0) {
          console.log(
            `[sync] Cleared ${res.cleared} legacy machine-derived nozzle condition(s) on the ${side} DB (GH #1021)`,
          );
        }
      }

      /**
       * Collections where a name couldn't be trimmed on one side or the
       * other, so the two peers may now disagree about identity.
       *
       * This gates `reconcileByName` ONLY — deliberately NOT `syncCollection`
       * (adversarial audit, and the narrower reading of the original P1).
       * `reconcileByName` is the sole path that matches on the raw `name`
       * string, so it is the sole path that can stamp one record's syncId
       * onto another and fuse two distinct rows; that is the outcome worth
       * blocking. `syncCollection` is purely syncId-keyed.
       *
       * Blocking the COPY as well made the guard self-perpetuating: in
       * hybrid mode the app writes only to the LOCAL database, so a user who
       * does exactly what the error says — rename the duplicate — clears the
       * local conflict while the REMOTE pair stays active, and the union
       * below still names the collection on every later cycle. Locations,
       * filaments and print history would never sync again, and the one
       * thing that could have propagated the fix (a syncId-keyed LWW copy of
       * the renamed row onto Atlas) was the thing being blocked.
       *
       * The residual case the copy gate did cover — one side trimmed, the
       * other not, distinct syncIds, so an INSERT hits the unique index — now
       * surfaces as an E11000 through `trySync`: loud, per-collection,
       * retried every cycle, and cleared by the next successful trim. A
       * recoverable failure beats a permanent one.
       */
      const conflictedCollections = new Set<string>();
      /**
       * Per-collection set of NAMES that must not be paired by name.
       *
       * The gate used to be keyed by COLLECTION while the conflicts are
       * per-ROW, so one untrimmable whitespace pair disabled
       * `reconcileByName` for every name in the collection — including a
       * genuinely unpaired same-name row created independently on both peers,
       * which is the v1.11.3 case that helper exists to fix. That row's
       * insert then hit the unique name index, and because the module's
       * `isDuplicateKeyError` only recognizes a `syncId` violation, the
       * failure propagated: locations errored, filaments and print history
       * cascade-skipped, every cycle, with the surfaced error naming the
       * INNOCENT row. A second audit reproduced it end to end against two
       * live databases.
       *
       * The fusion hazard is confined to the conflicting name and its
       * trimmed form, so that is what gets blocked.
       */
      const conflictedNames = new Map<string, Set<string>>();

      // GH #1116 — normalize entity names on BOTH sides before any copy.
      //
      // The copy path is the raw driver (`insertOne`/`replaceOne`), so it
      // bypasses the `trim: true` setter entirely: an untrimmed name on a
      // PRE-UPGRADE peer lands here verbatim, and Mongoose then can't find it
      // by name at ALL (a String schema setter applies to query values too,
      // so `{ name: "X " }` casts to `"X"` and misses the stored row). The
      // same-name reconcilers compare raw names, so `"X"` and `"X "` would
      // also propagate as two separate records — the exact duplicate this
      // issue is about, manufactured by sync instead of by CSV.
      //
      // dbConnect's pass can't cover this: the REMOTE never runs it, and a
      // pre-upgrade peer keeps producing untrimmed names after any one-shot.
      // So it runs every cycle, on both sides, ahead of every copy — the same
      // posture (and the same both-sides placement) as the #1021 cleanup
      // above, including the per-side abort re-check.
      //
      // Per-ROW conflicts are non-fatal — a name that can't be trimmed
      // because trimming would collide is reported and the cycle continues,
      // since that pair needs a human either way. A THROWN failure is
      // different and aborts, for the reason in the loop below.
      for (const [side, dbHandle] of [["local", localDb], ["remote", remoteDb]] as const) {
        if (this.aborted) break;
        // A THROW here aborts the cycle (Codex P1). Swallowing it and syncing
        // anyway is the worst outcome available: the two spellings are still
        // different, so `reconcileByName` doesn't pair them, `syncCollection`
        // copies BOTH to BOTH databases, and the next cycle's trim then finds
        // a genuine collision on each side and leaves the duplicate
        // permanently. Failing the cycle costs one retry; continuing costs a
        // pair of rows a human has to merge by hand. (Per-row conflicts are
        // still non-fatal — those are REPORTED, not thrown; see
        // `trimEntityNames`.)
        // BEFORE the trim, on BOTH peers (GH #1116, Codex P1). A purge zombie
        // (`_purged: true` with `_deletedAt: null`) is ACTIVE as far as
        // MongoDB is concerned, so it OCCUPIES the partial unique name index —
        // and nothing else ever repairs it on the remote, which never runs
        // `dbConnect` and whose both-purged sync branch is a documented no-op.
        //
        // The trim deliberately refuses to let a hidden zombie GATE a sync (a
        // user cannot resolve a row the UI does not show), so a local `"X "`
        // is free to become `"X"` while a remote zombie still holds `"X"` —
        // after which every `replaceOne` of that filament onto the remote
        // fails E11000, permanently, taking filaments and print-history with
        // it down the dependency chain. Suppressing the gate was only half the
        // answer; this is the other half, and it puts the row into the state
        // it should have been in all along.
        const zombies = await retombstonePurgedZombies(
          dbHandle.collection("filaments") as unknown as MinimalZombieCollection,
        );
        if (zombies > 0) {
          console.log(
            `[sync] ${side}: re-tombstoned ${zombies} purged zombie filament(s) (GH #1004)`,
          );
        }
        // GH #1152: heal unreadable tombstones (the raw-driver `_deletedAt:
        // ""` shape) on BOTH peers before any copy. The write-site guards
        // below stop the engine from spreading the value; this removes what
        // already exists — without it, a peer still carrying the shape
        // re-copies it forward on the next whole-document LWW transfer. Every
        // synced collection can hold a tombstone, unlike `_purged`, which is
        // a filaments-only concept. Epoch stamp: LWW-arithmetic-preserving —
        // see the helper's docblock for why NOT `new Date()` and NOT null.
        for (const collectionName of TOMBSTONE_COLLECTIONS) {
          // Re-checked per iteration (Codex P2): destroy() can flip `aborted`
          // while an awaited repair is in flight, and the service contract is
          // that only the operation already in flight may finish — not six
          // more repairs against a database the user just switched away from.
          if (this.aborted) break;
          const healed = await repairMalformedTombstones(
            dbHandle.collection(collectionName) as unknown as MinimalTombstoneCollection,
          );
          if (healed > 0) {
            console.log(
              `[sync] ${side}: repaired ${healed} unreadable tombstone(s) in ${collectionName} (GH #1152)`,
            );
          }
        }
        // Re-check AFTER the zombie repair (Codex P2). `destroy()` can set
        // `aborted` while that await is in flight, and the trim is a SEPARATE
        // destructive migration — it creates indexes and rewrites names across
        // five collections. Resuming into it would work on a database the user
        // just abandoned by switching connection mode, contrary to the
        // surrounding contract that only the operation already in flight may
        // finish.
        if (this.aborted) break;
        const trimResult = await trimEntityNames(dbHandle as unknown as MinimalTrimDb);
        const line = describeTrimResult(trimResult);
        if (line) console.log(`[sync] ${side}: ${line}`);
        // A per-row conflict is non-fatal for the CYCLE but it is fatal for
        // ITS OWN COLLECTION (Codex P1). One side can succeed where the other
        // couldn't — local holds A="X" and B="X " so B can't be trimmed,
        // while the remote holds only B and trims it to "X". The two sides
        // now disagree about which row "X" is, and `reconcileByName` would
        // pair remote B with local A by NAME and stamp A's syncId onto B:
        // two distinct records fused into one, after which LWW overwrites
        // one with the other. Record the affected collections and refuse to
        // reconcile or sync them until a human separates the pair.
        // ACTIVE conflicts only (Codex P1). An untrimmable name on a
        // soft-deleted row is permanent, can't collide in the partial index
        // and is never seen by `reconcileByName` — gating on it would block
        // that collection's sync forever with no user-accessible fix, since a
        // purged filament isn't even visible in the trash. It still gets
        // logged; it just doesn't stop anything.
        for (const c of trimResult.conflicts) {
          if (!c.active) continue;
          // Block the NAMES, not the collection (second adversarial audit).
          // Both spellings: the stored one and the trimmed one it would have
          // become — a pairing can be attempted under either.
          const set = conflictedNames.get(c.collection) ?? new Set<string>();
          set.add(c.name);
          set.add(c.name.trim());
          conflictedNames.set(c.collection, set);
        }
        // A collection the pass SKIPPED has un-normalized names by
        // definition, and it doesn't know WHICH — so that one really is
        // collection-wide.
        for (const sk of trimResult.skipped) conflictedCollections.add(sk.collection);
      }

      // GH #1021 (Codex P2 r23 / r25 / r26 / r27): drain the durable
      // transit-clear queues on BOTH databases (a failed local enqueue falls
      // back to the remote queue, r27). A prior cycle's pair-clear that
      // failed halfway left its entry queued; re-attempt it every cycle and
      // dequeue once neither side matches the observed state. Every replay
      // REVALIDATES the provenance persisted with the entry (r26) —
      // parent/nozzle drift since the enqueue drops the entry after
      // reconciling any partial clear (r27) rather than replaying blind.
      if (!this.aborted) {
        for (const queueDb of [localDb, remoteDb]) {
          if (this.aborted) break;
          let pending: unknown[] = [];
          try {
            const pendingDoc = await queueDb.collection("_migrations").findOne(
              { _id: "legacyTransitClears" as never },
            );
            pending = Array.isArray(pendingDoc?.entries) ? (pendingDoc!.entries as unknown[]) : [];
          } catch (err) {
            console.error("[sync] Transit-clear queue read failed (retried next cycle):", err);
            continue;
          }
          for (const raw of pending) {
            if (this.aborted) break;
            if (
              !raw || typeof raw !== "object" ||
              typeof (raw as { s?: unknown }).s !== "string" ||
              typeof (raw as { c?: unknown }).c !== "string" ||
              typeof (raw as { d?: unknown }).d !== "string"
            ) {
              // Malformed entry — drop it rather than retry it forever.
              await queueDb.collection("_migrations").updateOne(
                { _id: "legacyTransitClears" as never },
                { $pull: { entries: raw } } as never,
              ).catch(() => {});
              continue;
            }
            const entry = raw as { d: string; s: string; c: string; u: unknown; p: unknown; r: unknown };
            try {
              if (
                await this.attemptTransitClearPair(localDb, remoteDb, {
                  d: entry.d as "toLocal" | "toRemote",
                  s: entry.s,
                  c: entry.c,
                  u: entry.u,
                  p: entry.p ?? null,
                  r: Array.isArray(entry.r) ? entry.r : null,
                })
              ) {
                await queueDb.collection("_migrations").updateOne(
                  { _id: "legacyTransitClears" as never },
                  { $pull: { entries: entry } } as never,
                );
              }
            } catch (err) {
              console.error("[sync] Transit-clear retry failed (stays queued):", err);
            }
          }
        }
      }

      // Sync nozzles first (filaments and printers reference them)
      this.updateStatus({ progress: "Syncing nozzles..." });
      // GH #1116 (Codex P1): reconcile by name FIRST, like bedtypes,
      // locations and filaments already do. Nozzle and Printer carry the same
      // partial-unique `name` index, and the trim above can make two rows
      // NEWLY equal — one peer's `"0.4 "` and the other's `"0.4"` normalize to
      // the same name under different syncIds. Without reconciliation
      // syncCollection treats them as two rows and inserts one beside the
      // other, straight into the index; that E11000 is not a syncId collision
      // so it isn't swallowed, and the nozzle failure cascade-skips printers,
      // filaments and print history on EVERY cycle. Independent creation of
      // the same nozzle on two desktops has the same shape and was already
      // possible — the trim just makes it reachable without a typo.
      if (!this.aborted && !conflictedCollections.has("nozzles")) {
        await this.reconcileNozzlesByName(localDb, remoteDb, conflictedNames.get("nozzles"));
      }
      results.push(await trySync("nozzles", [], () =>
        this.syncCollection(localDb, remoteDb, "nozzles", undefined, conflictedCollections.has("nozzles")),
      ));

      // Build nozzle syncId→ID maps for reference remapping.
      // GH #511: project to {_id, syncId} so we don't pull the full doc
      // payload across the wire just to build a 100-byte id map.
      const localNozzles = await localDb.collection("nozzles").find({ _deletedAt: null }, { projection: { _id: 1, syncId: 1 } }).toArray();
      const remoteNozzles = await remoteDb.collection("nozzles").find({ _deletedAt: null }, { projection: { _id: 1, syncId: 1 } }).toArray();
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
      // GH #904: gate the inline reconcile on the abort flag, like trySync and
      // the repair passes — after a #823 abort it must stop writing syncId
      // metadata to the about-to-be-abandoned DB.
      if (!this.aborted && !conflictedCollections.has("bedtypes")) {
        await this.reconcileBedTypesByName(localDb, remoteDb, conflictedNames.get("bedtypes"));
      }
      results.push(await trySync("bedtypes", [], () =>
        this.syncCollection(localDb, remoteDb, "bedtypes", undefined, conflictedCollections.has("bedtypes")),
      ));

      // Build bedType syncId→ID maps for printer + filament remap.
      // GH #511: project to {_id, syncId} — see nozzles comment above.
      const localBedTypes = await localDb.collection("bedtypes").find({ _deletedAt: null }, { projection: { _id: 1, syncId: 1 } }).toArray();
      const remoteBedTypes = await remoteDb.collection("bedtypes").find({ _deletedAt: null }, { projection: { _id: 1, syncId: 1 } }).toArray();
      const localBedTypeBySyncId = new Map(localBedTypes.filter(b => b.syncId).map(b => [b.syncId as string, b._id]));
      const remoteBedTypeBySyncId = new Map(remoteBedTypes.filter(b => b.syncId).map(b => [b.syncId as string, b._id]));

      // Sync printers (filament calibrations reference them; printers
      // themselves reference nozzles + bedtypes, both synced above).
      this.updateStatus({ progress: "Syncing printers..." });
      // GH #1116 (Codex P1): same reasoning as nozzles above.
      if (!this.aborted && !conflictedCollections.has("printers")) {
        await this.reconcilePrintersByName(localDb, remoteDb, conflictedNames.get("printers"));
      }
      results.push(await trySync("printers", ["nozzles", "bedtypes"], () =>
        this.syncCollection(
          localDb, remoteDb, "printers",
          (doc, direction) => this.remapPrinterRefs(
            doc, direction,
            localNozzleBySyncId, remoteNozzleBySyncId,
            localBedTypeBySyncId, remoteBedTypeBySyncId,
          ),
          conflictedCollections.has("printers"),
        ),
      ));

      // Build printer syncId→ID maps for filament calibration reference remapping.
      // GH #511: project to {_id, syncId} — see nozzles comment above.
      const localPrinters = await localDb.collection("printers").find({ _deletedAt: null }, { projection: { _id: 1, syncId: 1 } }).toArray();
      const remotePrinters = await remoteDb.collection("printers").find({ _deletedAt: null }, { projection: { _id: 1, syncId: 1 } }).toArray();
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
      if (!this.aborted && !conflictedCollections.has("locations")) {
        await this.reconcileLocationsByName(localDb, remoteDb, conflictedNames.get("locations")); // GH #904
      }
      results.push(await trySync("locations", [], () =>
        this.syncCollection(localDb, remoteDb, "locations", undefined, conflictedCollections.has("locations")),
      ));

      // Build location syncId→ID maps for spool reference remapping.
      // GH #511: project to {_id, syncId} — see nozzles comment above.
      const localLocations = await localDb.collection("locations").find({ _deletedAt: null }, { projection: { _id: 1, syncId: 1 } }).toArray();
      const remoteLocations = await remoteDb.collection("locations").find({ _deletedAt: null }, { projection: { _id: 1, syncId: 1 } }).toArray();
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
      if (!this.aborted && !collectionErrored("locations")) {
        try {
          await this.repairDanglingSpoolLocations(
            localDb, remoteDb, localLocationBySyncId, remoteLocationBySyncId,
          );
        } catch (err) {
          console.error("[sync] repairDanglingSpoolLocations failed (best-effort):", err);
        }
      }

      // Backfill filament syncIds before building maps (syncCollection does this too, but we need maps first)
      // GH #904: skip the inline backfill writes after an abort.
      if (!this.aborted) {
        await this.backfillSyncIds(localDb.collection("filaments"));
        await this.backfillSyncIds(remoteDb.collection("filaments"));
      }

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
      if (!this.aborted && !conflictedCollections.has("filaments")) {
        await this.reconcileFilamentsByName(localDb, remoteDb, conflictedNames.get("filaments")); // GH #904
      }

      // Build filament syncId→ID maps for parentId remapping.
      // GH #511: project to {_id, syncId, updatedAt} — filament rows carry
      // base64 photoDataUrl blobs in spools[] that we'd otherwise stream
      // across the wire just to build a 100-byte id map. updatedAt is kept
      // for the snapshot construction immediately below.
      const localFilaments = await localDb.collection("filaments").find({}, { projection: { _id: 1, syncId: 1, updatedAt: 1 } }).toArray();
      const remoteFilaments = await remoteDb.collection("filaments").find({}, { projection: { _id: 1, syncId: 1, updatedAt: 1 } }).toArray();
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
      // GH #1021 r22/r25: legacy-condition candidates are NOT stripped in
      // transit at all — the transform only RECORDS them (a parent row lives
      // in the very collection being synced, so any pre-fetched provenance
      // can go stale mid-pass; and own-tick nozzle docs are re-read fresh
      // later for the same reason, r16). Everything is judged AFTER the
      // collection sync against the CURRENT source-side state (see below).
      const deferredLegacyChecks: Array<{
        direction: "toLocal" | "toRemote";
        syncId: string;
        observed: string;
        observedUpdatedAt: unknown;
        parentId: unknown;
        ownRefs: unknown[] | null;
      }> = [];
      const filamentTransform = this.buildFilamentRefsTransform(
        localNozzleBySyncId, remoteNozzleBySyncId,
        localPrinterBySyncId, remotePrinterBySyncId,
        localFilamentBySyncId, remoteFilamentBySyncId,
        localLocationBySyncId, remoteLocationBySyncId,
        localBedTypeBySyncId, remoteBedTypeBySyncId,
        deferredLegacyChecks,
      );
      results.push(await trySync(
        "filaments",
        ["nozzles", "bedtypes", "printers", "locations"],
        () =>
          this.syncCollection(
            localDb,
            remoteDb,
            "filaments",
            filamentTransform,
            conflictedCollections.has("filaments"),
          ),
      ));

      // GH #1021 (Codex r17–r25): the LWW copy is itself an ingestion
      // boundary — a pre-#1022 peer can push a NEWER doc carrying the
      // stamped machine condition after both one-shot markers completed,
      // with no migration left to catch it. The remedy is FIELD-LEVEL and
      // timestamp-honest (r25): both sides of the pair get a CONDITIONAL
      // single-field clear (exact syncId + exact condition + exact
      // updatedAt → set the condition to "" and NOTHING else, timestamps
      // untouched). No synthetic stamp ever makes the copied snapshot
      // authoritative (r24) and no tie with a genuine later edit can exist
      // (r25) — a user edit on either side bumps that row's updatedAt, its
      // filter simply misses, and normal LWW propagates the edit over the
      // cleared side. Partial completion (r23 P2) is handled by a DURABLE
      // queue: the pending pair is recorded in the local `_migrations`
      // collection BEFORE the clears and dequeued only once NEITHER side
      // matches the observed state anymore; every later cycle re-drains the
      // queue (see the top of sync()), so a transient failure of either
      // write can never freeze the pair at equal timestamps.
      // Codex P2 r26: no destructive write before DURABLE intent. All of this
      // cycle's candidates — merged with any carried over from a cycle whose
      // enqueue failed — are written to the queue in ONE batch first. If that
      // single write fails, every clear is SKIPPED this cycle and the
      // candidates are kept in memory (`pendingLegacyCandidates`) so the next
      // cycle retries the enqueue: an equal-timestamp pair never re-copies,
      // so the transform alone could not rediscover a candidate an enqueue
      // failure dropped. Each queue entry persists its PROVENANCE (own refs /
      // parentId) so every later attempt — this cycle's or a drain replay —
      // revalidates before clearing.
      const candidateEntries: LegacyTransitEntry[] = deferredLegacyChecks.map((entry) => ({
        d: entry.direction,
        s: entry.syncId,
        c: entry.observed,
        u: entry.observedUpdatedAt ?? null,
        p: entry.parentId ?? null,
        r: entry.ownRefs,
      }));
      const entryKey = (e: { d: string; s: string; c: string; u: unknown }) =>
        `${e.d}|${e.s}|${e.c}|${SyncService.readTimestamp(e.u) ?? "null"}`;
      const merged = new Map<string, LegacyTransitEntry>();
      for (const e of [...this.pendingLegacyCandidates, ...candidateEntries]) {
        merged.set(entryKey(e), e);
      }
      const toEnqueue = Array.from(merged.values());
      let enqueued = toEnqueue.length === 0;
      let queueDbUsed: Db = localDb;
      // Codex P2 r28: the enqueue is deliberately NOT abort-gated. It
      // persists the cleanup INTENT for copies the (already completed)
      // filament sync made this cycle — skipping it on a late destroy()
      // would strand equal-timestamp pairs that no replacement service could
      // ever rediscover through LWW. Only the destructive CLEARS below honor
      // the abort; this is bookkeeping for writes that already happened.
      if (toEnqueue.length > 0) {
        // Codex P2 r27: durable intent must survive SERVICE RECREATION, not
        // just this process — try the local queue, then fall back to the
        // REMOTE db's queue (the drain reads both). Only when BOTH databases
        // refuse the write do the candidates stay in memory — and both DBs
        // just accepted the whole collection sync moments earlier, so a
        // double refusal means the cycle itself is failing.
        for (const dbh of [localDb, remoteDb]) {
          try {
            await dbh.collection("_migrations").updateOne(
              { _id: "legacyTransitClears" as never },
              { $addToSet: { entries: { $each: toEnqueue } } },
              { upsert: true },
            );
            enqueued = true;
            queueDbUsed = dbh;
            this.pendingLegacyCandidates = [];
            break;
          } catch (err) {
            console.error("[sync] Legacy-condition candidate enqueue failed on one side:", err);
          }
        }
        if (!enqueued) {
          this.pendingLegacyCandidates = toEnqueue;
          console.error(
            "[sync] Legacy-condition candidate enqueue failed on BOTH databases — clears skipped this cycle, candidates carried over in memory",
          );
        }
      }
      if (enqueued && !this.aborted) {
        for (const queued of toEnqueue) {
          if (this.aborted) break;
          try {
            if (await this.attemptTransitClearPair(localDb, remoteDb, queued)) {
              await queueDbUsed.collection("_migrations").updateOne(
                { _id: "legacyTransitClears" as never },
                { $pull: { entries: queued } } as never,
              );
            }
          } catch (err) {
            console.error(
              "[sync] Deferred legacy-condition transit check failed (stays queued):",
              err,
            );
          }
        }
      }

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
      if (!this.aborted && !collectionErrored("filaments")) {
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
      // GH #511: project to {_id, syncId} — only used to rebuild the
      // syncId→id maps below.
      const lFilPost = await localDb.collection("filaments").find({}, { projection: { _id: 1, syncId: 1 } }).toArray();
      const rFilPost = await remoteDb.collection("filaments").find({}, { projection: { _id: 1, syncId: 1 } }).toArray();
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
      if (!this.aborted && !collectionErrored("printers") && !collectionErrored("filaments")) {
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
        () =>
          this.syncCollection(
            localDb,
            remoteDb,
            "printhistories",
            printHistoryTransform,
            conflictedCollections.has("printhistories"),
          ),
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
      // GH #623: close the two clients independently. The earlier
      // sequential `await local.close(); await remote.close();` meant a
      // rejected local close skipped the remote close entirely, leaking
      // the Atlas client/pool once per failed cycle — unbounded over a
      // long session on the 5-minute sync interval.
      await Promise.allSettled([local.close(), remote.close()]);
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
    transformDoc?: (
      doc: Document,
      direction: "toLocal" | "toRemote",
      targetSpoolIds?: (string | undefined)[],
    ) => Document,
    /**
     * GH #1116 (Codex P1): restrict this collection to syncIds present on BOTH
     * peers, skipping every unpaired INSERT.
     *
     * Set when the trim pass SKIPPED the collection — no protective unique
     * name index could be established, so nothing was normalized. In that
     * state `reconcileByName` is also disabled (it compares raw names and
     * would fuse two records that merely look alike), and disabling it WITHOUT
     * restricting the copy is worse than not gating at all: the pairing that
     * used to fuse an identically-named pair no longer happens, and the
     * unpaired inserts below then manufacture the duplicate on the target.
     *
     * Paired updates still flow, so repairs — including a later successful
     * trim — propagate normally. That is what keeps this from becoming the
     * self-perpetuating freeze an earlier revision hit by blocking the copy
     * outright, which would have stalled locations, filaments and print
     * history permanently.
     */
    pairedOnly = false,
  ): Promise<SyncResult> {
    const localCol = localDb.collection(collectionName);
    const remoteCol = remoteDb.collection(collectionName);

    // Backfill: assign syncId to any docs that don't have one yet
    await this.backfillSyncIds(localCol);
    await this.backfillSyncIds(remoteCol);

    // GH #511: fetch only the fields the diff loop below actually reads —
    // syncId, _deletedAt, _purged, updatedAt (+ the always-present _id).
    // The full document body (which for the filaments collection includes
    // base64 photoDataUrl blobs, unbounded usageHistory[], calibrations[],
    // etc.) is pulled across the wire ONLY for the docs that actually need
    // to transfer, via the hydrateLocal/hydrateRemote helpers below.
    // Pre-fix `find({})` streamed every full doc on both sides every
    // cycle (default every 5 min) just to compare four metadata fields —
    // on an Atlas hybrid install with photo-attached spools that's tens
    // to hundreds of MB of metered egress per cycle.
    // GH #1142 adds `name`: the rename-staging predicate has to know whether a
    // blocker's own copy would rewrite its name on THIS side, which means
    // comparing the two sides' names. It is a short string, so it does not
    // reopen the GH #511 egress problem — that was about pulling full bodies
    // (base64 photoDataUrl blobs, unbounded usageHistory[], calibrations[])
    // for every row on every cycle, which the hydrate helpers still avoid.
    // ── GH #1153: sweep leftover placeholders BEFORE the pass reads names ──
    //
    // Three histories leave a row named `__sync-staging-…` past its own cycle:
    // settlement's `taken` branch, settlement's catch, and a process death
    // between staging and settlement. The durable queue written at staging
    // time carries the original name; this sweep restores it once the name is
    // free again — BEFORE the slim reads below, so a restored name
    // participates in this pass's LWW graph and staging plan rather than the
    // placeholder doing so.
    //
    // A stranding that STILL cannot be restored (name permanently taken) is
    // counted and named every cycle, and — per the #1142 posture, "a
    // reported, recoverable stall beats an invisible one" — fails the
    // collection below, cascade-skipping its dependents until a human
    // renames one of the two rows.
    //
    // The GRAMMAR BACKSTOP covers rows with no queue entry (pre-#1153
    // strandings, and placeholders a pre-#1142 copy propagated to the other
    // peer): the restore target is derived from the syncId-paired peer's
    // name, which is what the staged row's own write would have delivered.
    // `placeholderRestoreTarget` (pure, tested) owns that decision table; a
    // row it cannot answer for is reported, never guessed — inventing a name
    // is a product decision this machinery is not allowed to make.
    const sweptConflicts: string[] = [];
    /** SyncIds of rows left holding an UNRESOLVED placeholder (Codex P2).
     * Reporting is not enough: the row still entered the row loop, and a user
     * edit bumping its `updatedAt` while stranded made the placeholder the
     * LWW winner — copying `__sync-staging-…` over the peer's legitimate
     * name. A stranded row is QUARANTINED from this cycle's transfer instead:
     * its syncId is skipped entirely (both directions — copying the peer's
     * side inward is equally wrong while the local truth is a placeholder),
     * and the pair converges on the first cycle after the placeholder
     * resolves. */
    const quarantinedSyncIds = new Set<string>();
    const sweepSide = async (
      db: Db,
      col: ReturnType<Db["collection"]>,
      peerCol: ReturnType<Db["collection"]>,
    ): Promise<void> => {
      const migrations = db.collection("_migrations");
      // A failed read THROWS (Codex P2, and its sibling one page down): the
      // sweep's whole contract is "no unresolved placeholder syncs", and a
      // read converted to an empty result silently waives it — queued
      // placeholders would go unquarantined into the LWW loop while the
      // cycle reads green. A throw fails the collection through trySync,
      // dependents cascade-skip, and the next cycle retries: the same
      // thrown-failure posture the trim established.
      const queueDoc = await migrations.findOne({
        _id: RESTORE_QUEUE_ID as unknown as ObjectId,
      });
      const rawEntries: unknown[] = Array.isArray(queueDoc?.entries) ? queueDoc.entries : [];
      const entries = rawEntries.filter(isRestoreEntry).filter((e) => e.c === collectionName);
      // Drop malformed entries outright — one bad record must not abort the
      // sweep, and it can never become restorable.
      for (const bad of rawEntries.filter(
        (e) => !isRestoreEntry(e) && (e as RenameStagingRestoreEntry)?.c === collectionName,
      )) {
        await migrations
          .updateOne(
            { _id: RESTORE_QUEUE_ID as unknown as ObjectId },
            { $pull: { entries: bad } as Document },
          )
          .catch(() => {});
      }

      const coveredIds = new Set(entries.map((e) => e.i));
      for (const entry of entries) {
        // The AGE GATE defers JUDGMENT, not inspection (Codex P1, second
        // pass). A young entry may belong to a pass alive on another service
        // — possibly still between its enqueue and its staging write — so no
        // young entry may be DRAINED or RESTORED. But a young entry whose row
        // already HOLDS the recorded placeholder is a live stranding either
        // way (a settlement-taken row re-reported five minutes later sits
        // well under the fifteen-minute bound), and skipping it entirely left
        // its syncId unquarantined: an edit while stranded then let LWW copy
        // the placeholder to the peer — the exact corruption the quarantine
        // exists to prevent. So the row is always READ; youth only forbids
        // the destructive verbs.
        //
        // The observed syncId lives OUTSIDE the try (Codex P2): the catch
        // also receives failures from the taken-lookup and the restore
        // update, AFTER the row was seen holding its placeholder — and
        // discarding the observation there let the row enter the loop
        // unquarantined on precisely the cycles where something is already
        // wrong.
        let strandedSyncId: string | null = null;
        const young = Date.now() - entry.at.getTime() < SWEEP_MIN_AGE_MS;
        try {
          const row = await col.findOne(
            { _id: new ObjectId(entry.i) },
            { projection: { name: 1, syncId: 1, _deletedAt: 1, _purged: 1 } },
          );
          if (!row || row.name !== entry.p) {
            // Gone, landed, or human-renamed — nothing to recover. Only an
            // AGED entry may be drained (young + not-holding is exactly the
            // enqueue-to-update window), and the drain is versioned on the
            // observed stamp: the owner may have re-asserted since this
            // sweep's snapshot.
            if (!young) await dequeueRestoreOn(migrations, entry, entry.at);
            continue;
          }
          // RESOLVED BY DELETION (Codex P2): a user may deal with a stranded
          // row by trashing or purging it. The name no longer needs
          // restoration — a tombstoned row is outside the partial index, and
          // a placeholder name in the trash is cosmetic — and quarantining it
          // would block the one thing that still matters: the TOMBSTONE
          // propagating to the peer. So: never quarantine, never restore,
          // never report; drain the entry once aged (a young entry defers to
          // its owner, as everywhere else). The loop's own predicates decide
          // tombstoned-ness, per the #1146 rule.
          if (row._deletedAt != null || row._purged === true) {
            if (!young) await dequeueRestoreOn(migrations, entry, entry.at);
            continue;
          }
          if (typeof row.syncId === "string") strandedSyncId = row.syncId;
          if (young) {
            // Holding, but the entry is fresh — quarantine and report without
            // touching row or record; the owning pass (or the next aged
            // sweep) resolves it.
            sweptConflicts.push(
              strandedPlaceholderNotice({
                collection: collectionName,
                id: entry.i,
                originalName: entry.o,
                placeholderName: entry.p,
              }),
            );
            if (strandedSyncId) quarantinedSyncIds.add(strandedSyncId);
            continue;
          }
          const taken = await col.findOne(
            { name: entry.o, _deletedAt: null, _id: { $ne: row._id } },
            { projection: { _id: 1 } },
          );
          if (taken) {
            sweptConflicts.push(
              strandedPlaceholderNotice({
                collection: collectionName,
                id: entry.i,
                originalName: entry.o,
                placeholderName: entry.p,
              }),
            );
            if (strandedSyncId) quarantinedSyncIds.add(strandedSyncId);
            continue; // keep queued — retried next cycle
          }
          const restored = await col.updateOne(
            { _id: row._id, name: entry.p },
            { $set: { name: entry.o } },
          );
          await dequeueRestoreOn(migrations, entry, entry.at);
          if (restored.modifiedCount) {
            console.log(
              `[sync] ${collectionName}: restored ${JSON.stringify(entry.o)} onto ${entry.i} (GH #1153)`,
            );
          } else if (strandedSyncId) {
            // The conditional restore no-matched — someone moved the row
            // between our read and the write. Unknown state: hold it back
            // this cycle rather than let a possibly-still-stranded row sync.
            quarantinedSyncIds.add(strandedSyncId);
          }
        } catch (err) {
          // Keep the entry; next cycle retries. One bad row must not abort
          // the collection's sweep — but a row OBSERVED holding its
          // placeholder must not sync just because a later step failed.
          if (strandedSyncId) {
            quarantinedSyncIds.add(strandedSyncId);
            sweptConflicts.push(
              strandedPlaceholderNotice({
                collection: collectionName,
                id: entry.i,
                originalName: entry.o,
                placeholderName: entry.p,
              }),
            );
          }
          console.warn(`[sync] ${collectionName}: staging-restore sweep failed for ${entry.i}.`, err);
        }
      }

      // Grammar backstop. STAGING_PREFIX is `__sync-staging-` — word chars
      // and hyphens only, safe as a literal anchored regex.
      // Same rule as the queue read above: a failed SCAN is not "no strays".
      const strays = await col
        .find(
          { name: { $regex: `^${STAGING_PREFIX}` } },
          { projection: { name: 1, syncId: 1, _deletedAt: 1, _purged: 1 } },
        )
        .toArray();
      for (const stray of strays) {
        // STRICT grammar, not the prefix (Codex P2). The backstop ACTS on
        // recognition alone — it rewrites the name to the peer's, or fails
        // the collection every cycle when it cannot — and entity names are
        // free-form: a user's own `__sync-staging-custom` matched the prefix
        // find above and would have been silently renamed to its peer's
        // value. Only the complete generated shape (8-hex nonce, 24-hex id)
        // is treated as an artifact; anything else is presumed a user's name
        // and left entirely alone — not even reported.
        if (!isGeneratedPlaceholder(stray.name)) continue;
        // Tombstoned = resolved by deletion — same rule as the queue path:
        // let the tombstone sync; the name in the trash is cosmetic.
        if (stray._deletedAt != null || stray._purged === true) continue;
        if (coveredIds.has(String(stray._id))) continue; // queue already handled it
        try {
          // FRESH re-check (Codex P2): the queue snapshot above predates this
          // find, and enqueue-before-stage means any placeholder minted since
          // then already has a durable entry — owned by a live pass the
          // backstop must not race. The residual window is the milliseconds
          // between an enqueue landing and this read observing it; even
          // there, the backstop's conditional update only touches a row
          // still holding the placeholder, so the worst case is the owning
          // pass's retry colliding and REPORTING — never silent loss.
          const nowCovered = await migrations.findOne(
            { _id: RESTORE_QUEUE_ID as unknown as ObjectId },
            { projection: { entries: 1 } },
          );
          const freshEntries: unknown[] = Array.isArray(nowCovered?.entries)
            ? nowCovered.entries
            : [];
          if (
            freshEntries.some(
              // Scoped to THIS collection (Codex P2) — _id uniqueness is
              // per-collection, so an entry for a same-id row in a DIFFERENT
              // collection must not mask this stray's backstop, potentially
              // forever when that entry is retained for a taken name. The
              // `coveredIds` snapshot above already scopes this way.
              (e) => isRestoreEntry(e) && e.c === collectionName && e.i === String(stray._id),
            )
          ) {
            continue;
          }
          const peer =
            typeof stray.syncId === "string"
              ? await peerCol.findOne({ syncId: stray.syncId }, { projection: { name: 1 } })
              : null;
          const target = placeholderRestoreTarget(stray.name, null, peer?.name);
          if (target === null) {
            sweptConflicts.push(
              `${collectionName} ${String(stray._id)} holds the temporary name ` +
                `${JSON.stringify(stray.name)} and its original name could not be determined. ` +
                `Rename it manually.`,
            );
            if (typeof stray.syncId === "string") quarantinedSyncIds.add(stray.syncId);
            continue;
          }
          const taken = await col.findOne(
            { name: target, _deletedAt: null, _id: { $ne: stray._id } },
            { projection: { _id: 1 } },
          );
          if (taken) {
            sweptConflicts.push(
              strandedPlaceholderNotice({
                collection: collectionName,
                id: String(stray._id),
                originalName: target,
                placeholderName: String(stray.name),
              }),
            );
            if (typeof stray.syncId === "string") quarantinedSyncIds.add(stray.syncId);
            continue;
          }
          const healed = await col.updateOne(
            { _id: stray._id, name: stray.name },
            { $set: { name: target } },
          );
          if (healed.modifiedCount) {
            console.log(
              `[sync] ${collectionName}: adopted the peer name ${JSON.stringify(target)} onto ` +
                `${String(stray._id)} (GH #1153 backstop)`,
            );
          }
        } catch (err) {
          // Same rule as the queue path's catch (Codex P2, both halves): a
          // row recognized as a generated placeholder must not sync because a
          // later step failed — and the failure must reach the USER, not just
          // the console, or the cycle reads green while the placeholder
          // stands indefinitely.
          if (typeof stray.syncId === "string") quarantinedSyncIds.add(stray.syncId);
          sweptConflicts.push(
            `${collectionName} ${String(stray._id)} holds the temporary name ` +
              `${JSON.stringify(stray.name)} and could not be recovered this cycle. ` +
              `Rename it manually if this persists.`,
          );
          console.warn(
            `[sync] ${collectionName}: placeholder backstop failed for ${String(stray._id)}.`,
            err,
          );
        }
      }
    };
    /** `$pull` one entry from an already-resolved migrations collection.
     *
     * Two drain modes, and the asymmetry is the point (Codex P2):
     *  - the OWNER (settlement, the zero-match branch) drains by KEY alone —
     *    it owns the row's fate, and the re-assert may have refreshed the
     *    stamp it never tracked, so a versioned drain would leak the entry;
     *  - a SWEEPER passes the `at` it OBSERVED, versioning the drain against
     *    an in-flight re-assert: it judged a snapshot, and the owner may have
     *    staged and re-stamped between that snapshot and this $pull — an
     *    unversioned drain would remove the FRESH record and leave a later
     *    owner crash with a placeholder and no authoritative original name.
     *    `$eq` keeps the observed value literal, per this module's rule. */
    const dequeueRestoreOn = async (
      migrations: ReturnType<Db["collection"]>,
      entry: RenameStagingRestoreKey,
      observedAt?: Date,
    ): Promise<void> => {
      const match: Document = { c: entry.c, i: entry.i, o: entry.o, p: entry.p };
      if (observedAt !== undefined) match.at = { $eq: observedAt };
      await migrations
        .updateOne(
          { _id: RESTORE_QUEUE_ID as unknown as ObjectId },
          { $pull: { entries: match } as Document },
        )
        .catch((err: unknown) => {
          console.warn(`[sync] ${entry.c}: could not dequeue a staging-restore entry.`, err);
        });
    };
    await sweepSide(localDb, localCol, remoteCol);
    await sweepSide(remoteDb, remoteCol, localCol);

    const SLIM_PROJECTION = { syncId: 1, _deletedAt: 1, _purged: 1, updatedAt: 1, name: 1 };
    const localDocs = await localCol.find({}, { projection: SLIM_PROJECTION }).toArray();
    const remoteDocs = await remoteCol.find({}, { projection: SLIM_PROJECTION }).toArray();

    const localBySyncId = new Map(localDocs.filter(d => d.syncId).map(d => [d.syncId as string, d]));
    const remoteBySyncId = new Map(remoteDocs.filter(d => d.syncId).map(d => [d.syncId as string, d]));

    // Hydrate the full document only when a branch actually needs the body
    // (push / pull / update / resurrect). Returns null if the doc vanished
    // between the slim read and now (physical delete — doesn't happen in
    // this app's soft-delete-only model, but guard defensively so a null
    // can't be spread into an insert/update).
    const hydrateLocal = (slim: Document): Promise<Document | null> =>
      localCol.findOne({ _id: slim._id });
    const hydrateRemote = (slim: Document): Promise<Document | null> =>
      remoteCol.findOne({ _id: slim._id });

    // GH #732: on a filament UPDATE the whole spools array is overwritten by
    // the source. If the source spool lacks an instanceId (a pre-#732 peer) we
    // must reuse the TARGET's already-assigned spool id (matched by position)
    // rather than minting a new one — otherwise an id-less-source edit would
    // rotate the durable spool id the target already backfilled (and that a
    // label/NFC/match may key on). Returns the target's spool instanceIds by
    // position; only the filaments collection has spools, so skip the extra
    // read elsewhere.
    const fetchTargetSpoolIds = async (
      col: ReturnType<ReturnType<MongoClient["db"]>["collection"]>,
      id: ObjectId,
    ): Promise<(string | undefined)[] | undefined> => {
      if (collectionName !== "filaments") return undefined;
      const d = await col.findOne({ _id: id }, { projection: { "spools.instanceId": 1 } });
      if (!d || !Array.isArray(d.spools)) return undefined;
      return d.spools.map((s: Document) =>
        typeof s.instanceId === "string" && s.instanceId ? s.instanceId : undefined,
      );
    };

    // ── GH #1142: stage a contended rename instead of deadlocking ────────
    //
    // Every entity collection has a partial-unique `name` index, and this loop
    // writes each row's whole document straight at the target with no
    // awareness that the name it is about to write is currently held by a
    // DIFFERENT row the same pass is about to move. Three shapes:
    //
    //   cycle  — local A="X" B="Y", remote A="Y" B="X". No ordering works;
    //            reversing only changes which row fails.
    //   chain  — A wants the name B is about to vacate.
    //   unsat  — two rows genuinely want one name and neither is moving.
    //
    // The failure is permanent, not transient: it repeats every cycle, and via
    // `trySync` a failure in `locations` cascade-skips filaments and print
    // history, so one swapped pair stalls most of sync.
    //
    // Handled REACTIVELY rather than by a pre-pass, deliberately: a pre-pass
    // would have to recompute every row's LWW outcome before the loop, which
    // means a second copy of the decision logic that can drift from the real
    // one. Here the real write is attempted, and only an actual name collision
    // triggers staging — so the healthy path is untouched and there is no
    // second decision to keep in step.
    const stagedRenames: {
      col: typeof localCol;
      id: ObjectId;
      originalName: string;
      placeholderName: string;
    }[] = [];
    /** Rows this pass left holding a placeholder, for the result message. */
    const strandedNotices: string[] = [...sweptConflicts];
    /**
     * SyncIds whose loop iteration has started (and, since iterations are
     * sequential, has finished for every id but the current one). The one
     * fact about a blocker that neither the plan nor any name can encode
     * (Codex P1, seventh pass): whether its write is still COMING. Names
     * cannot, because a third party renaming the target after the iteration
     * completed breaks the equality that detects a landed write — the fresh
     * source still differs from the perturbed target, staging looks
     * legitimate, and no write remains to replace the placeholder.
     */
    const processedSyncIds = new Set<string>();
    const stagingNonce = new ObjectId().toHexString().slice(-8);

    /**
     * Run a write that sets `name`; on a name collision, move the blocking row
     * aside and retry ONCE.
     *
     * Staging is legitimate ONLY when the blocker's own LWW outcome writes to
     * THIS target with a different name — then its real name lands moments
     * later. Anything else is the unsatisfiable case: report it and leave both
     * peers alone rather than clobbering a record the user still wants.
     *
     * "Paired" is NOT that condition, and the gap is the whole hazard (Codex
     * P1). A paired row's LWW can copy in the OPPOSITE direction, or do
     * nothing on an equal timestamp — in either case nothing rewrites its name
     * on this target, so the placeholder is stranded, and a later copy in the
     * other direction can propagate `__sync-staging-…` to the other peer. By
     * then cleanup cannot restore it either, because the row it made way for
     * owns its original name.
     */
    /**
     * The name this pass will write for `syncId` on `col`, or null when it
     * writes nothing there.
     *
     * Re-derives only the DIRECTION of the LWW decision — a small, total
     * comparison — rather than the whole branch tree, which is what would
     * drift. Deliberately conservative: every branch it cannot model (a purge,
     * a delete, a resurrect, an equal timestamp, a missing side) answers null,
     * which downgrades the case to "unsatisfiable, reported" rather than
     * risking a stranded placeholder.
     *
     * ## The property this actually has (Codex P1, second pass)
     *
     * Not "it mirrors the loop exactly" — it does not, and claiming so is how
     * the previous version drifted. The true, scoped claim is: FOR A ROW THAT
     * IS LIVE ON `col` — the only rows `stageableOn` can ask about, since its
     * filter is the index predicate — the only branch that rewrites the name
     * is the both-active LWW one. The purge branch writes flags only;
     * delete-propagation writes `_deletedAt` only; and both resurrect arms
     * write on the DELETED side, which that same filter excludes.
     *
     * The guards below therefore have to use the LOOP's classifications, not
     * lookalikes: `_purged === true` and `_deletedAt != null`, matching the
     * `localPurged`/`localDeleted` derivations further down. Truthiness
     * disagrees with `!= null` on exactly one stored value — the empty string,
     * which the driver writes verbatim and Mongoose never casts — and there
     * the loop takes the DELETE branch (resurrecting on the other side) while
     * the predictor was claiming a rename on this one. The blocker was then
     * staged for a write that never came, and the fresh `hydrateRemote` read
     * could copy `__sync-staging-…` to the other peer before settlement ever
     * noticed.
     *
     * The cost of being wrong in the safe direction is one reported cycle: a
     * delete or purge frees the name in the same pass without renaming, so
     * treating that pair as a permanent holder stalls the collection once
     * (and cascade-skips its dependents) before converging cleanly. That is
     * the trade this function was always making; it is not free.
     */
    const desiredNameOn = (col: typeof localCol, syncId: string): string | null => {
      const localDoc = localBySyncId.get(syncId);
      const remoteDoc = remoteBySyncId.get(syncId);
      if (!localDoc || !remoteDoc) return null; // unpaired: nothing writes it here
      // Purge first, mirroring the loop's branch order — its purge arm is
      // tested before either delete arm and writes no name at all.
      if (localDoc._purged === true || remoteDoc._purged === true) return null;
      if (localDoc._deletedAt != null || remoteDoc._deletedAt != null) return null;

      const localTime = SyncService.readUpdatedAt(localDoc) ?? 0;
      const remoteTime = SyncService.readUpdatedAt(remoteDoc) ?? 0;
      if (localTime === remoteTime) return null;

      const targetIsRemote = localTime > remoteTime;
      if (targetIsRemote !== (col === remoteCol)) return null; // writes the OTHER side
      const source = targetIsRemote ? localDoc : remoteDoc;
      return typeof source.name === "string" ? source.name : null;
    };

    /**
     * Which rows may be moved aside on `col`, computed ONCE per target.
     *
     * Delegated to the pure planner because the answer needs the whole rename
     * GRAPH, not one hop (Codex P1). Checking only that the immediate blocker
     * will be rewritten strands it whenever its own destination is itself
     * blocked: with A->B, B->C and C standing still, A takes B's name and B can
     * then never take C — and settlement cannot restore B, because A owns its
     * original name. The planner runs unsatisfiability backwards to a fixpoint,
     * so a blocked far end refuses the whole chain while a true cycle still
     * resolves.
     */
    const stagingPlans = new Map<typeof localCol, Set<string>>();
    const stageableOn = (col: typeof localCol): Set<string> => {
      const cached = stagingPlans.get(col);
      if (cached) return cached;
      const docs = col === remoteCol ? remoteDocs : localDocs;
      const intents = docs
        // INDEXED rows only (Codex P1, twice). The unique index is partial on
        // `_deletedAt: null`, so a trashed row named "X" does NOT occupy that
        // slot — GH #213 name reuse depends on it. Letting one into the graph
        // made it the "holder" whenever it sorted first, and a trashed row
        // never vacates, so the fixpoint declared the whole chain immovable
        // and refused a swap that was perfectly resolvable — every cycle.
        //
        // The predicate is MongoDB's own, not JS truthiness. `{_deletedAt:
        // null}` matches null AND missing and nothing else, so a raw
        // `_deletedAt: ""` — which Mongoose casts to null on a Date path but
        // the driver stores verbatim, the shape `trimEntityNames` documents at
        // its own `== null` test — is OUTSIDE the index. `!d._deletedAt` let
        // that row in as a holder, reintroducing the immovable-chain stall for
        // a row that could never have blocked the write in the first place.
        .filter((d) => d._deletedAt == null && typeof d.name === "string")
        .map((d) => {
          const syncId = typeof d.syncId === "string" ? d.syncId : null;
          const desired = syncId ? desiredNameOn(col, syncId) : null;
          return {
            id: String(d._id),
            currentName: d.name as string,
            desiredName: desired ?? (d.name as string),
            willWrite: desired !== null,
          };
        });
      const plan = planRenameStaging(intents, stagingNonce);
      const ids = new Set(plan.staged.map((st) => st.id));
      stagingPlans.set(col, ids);
      return ids;
    };

    const writeWithRenameStaging = async (
      col: typeof localCol,
      targetId: ObjectId,
      desiredName: unknown,
      write: () => Promise<unknown>,
    ): Promise<boolean> => {
      try {
        await write();
        return true;
      } catch (err) {
        if (!isNameDuplicateKeyError(err) || typeof desiredName !== "string") throw err;

        const blocker = await col.findOne(
          { name: desiredName, _deletedAt: null },
          { projection: { _id: 1, syncId: 1, name: 1 } },
        );
        if (!blocker || String(blocker._id) === String(targetId)) throw err;

        const blockerSyncId = typeof blocker.syncId === "string" ? blocker.syncId : null;
        const blockerName = typeof blocker.name === "string" ? blocker.name : null;
        const refuseStaging = () => {
          result.nameConflicts = (result.nameConflicts ?? 0) + 1;
          console.warn(
            `[sync] ${collectionName}: cannot apply name ${JSON.stringify(desiredName)} — ` +
              `held by a row this pass will not rewrite on this side. Rename one of them.`,
          );
          return false;
        };
        if (
          !blockerSyncId ||
          !blockerName ||
          !stageableOn(col).has(String(blocker._id)) ||
          // The blocker's own iteration must still be AHEAD (Codex P1). Once
          // it has run, no write remains this pass, and the name checks below
          // can no longer prove it: a third party renaming the target
          // afterwards re-opens the gap between fresh source and fresh target
          // that normally means "rename pending". Set membership is the only
          // signal that survives arbitrary concurrent renames.
          processedSyncIds.has(blockerSyncId)
        ) {
          return refuseStaging();
        }

        // The plan is a SNAPSHOT; staging additionally needs FRESH proof that
        // the blocker's own pending write will rename it away (Codex P1, twice
        // over). The first version of this check compared the blocker's fresh
        // name against its SNAPSHOT desired name — half-fresh, and the half
        // matters: the pending write hydrates the CURRENT source document at
        // write time, so a source renamed after the snapshot (a user reverting
        // a name mid-pass) diverges from `desiredNameOn`, and staging was
        // authorized for a rename that was no longer coming. Settlement could
        // not restore the placeholder, because the name it would restore had
        // been taken by the retry this staging enabled.
        //
        // So read the SAME document the pending write will hydrate — the
        // blocker's source-side pair, by the `_id` the snapshot map carries —
        // and judge against what it says NOW. The decision table (landed
        // write, no-op rename, mid-pass revert, vanished source, placeholder
        // contagion) lives in `pendingRenameCanFreeName`, pure and tested.
        // This also subsumes the previous check: a landed write makes the
        // fresh source name equal the blocker's fresh name. The planner still
        // covers what only IT can see (contested destinations, immovable
        // chains); this covers what only fresh state can.
        const sourceSnap = (col === remoteCol ? localBySyncId : remoteBySyncId).get(
          blockerSyncId,
        );
        const sourceFresh = sourceSnap
          ? await (col === remoteCol ? localCol : remoteCol).findOne(
              { _id: sourceSnap._id },
              { projection: { name: 1 } },
            )
          : null;
        if (!pendingRenameCanFreeName(sourceFresh?.name, blockerName)) {
          return refuseStaging();
        }

        // DURABLE RECORD FIRST (GH #1153) — the same
        // observation-before-destructive-write ordering the #1021 runner uses.
        // Settlement can restore a placeholder only while the pass that staged
        // it is alive; a crash, a thrown cycle, or a taken name used to leave
        // the row named `__sync-staging-…` with the original name existing
        // NOWHERE durable. The queue entry is what a later cycle's sweep
        // restores from. If the enqueue itself fails, staging is refused —
        // a reported name conflict beats an unrecoverable placeholder.
        const placeholder = placeholderFor(String(blocker._id), stagingNonce);
        const entry: RenameStagingRestoreEntry = {
          c: collectionName,
          i: String(blocker._id),
          o: blockerName,
          p: placeholder,
          at: new Date(),
        };
        const sideDb = col === remoteCol ? remoteDb : localDb;
        try {
          await sideDb
            .collection("_migrations")
            .updateOne(
              { _id: RESTORE_QUEUE_ID as unknown as ObjectId },
              { $push: { entries: entry } as Document },
              { upsert: true },
            );
        } catch (enqueueErr) {
          console.error(
            `[sync] ${collectionName}: could not record the staging-restore entry; refusing to stage.`,
            enqueueErr,
          );
          return refuseStaging();
        }

        // CONDITIONAL on what was observed (Codex P1). Between the findOne and
        // this update another app or syncer can rename or delete the blocker;
        // an `_id`-only filter would overwrite that concurrent change with a
        // placeholder, the retry would then take a name its owner had just
        // released, and cleanup could never restore the original because it is
        // now occupied. A zero-match means the world moved — report rather
        // than force.
        const staged = await col.updateOne(
          { _id: blocker._id, name: blockerName, _deletedAt: null },
          { $set: { name: placeholder } },
        );
        if (!staged.modifiedCount) {
          // Nothing was written, and settlement never sees this row (it is
          // pushed to `stagedRenames` only below) — so the entry comes out
          // HERE. A failed dequeue is harmless: the sweep re-examines the row
          // next cycle, finds no placeholder, and drops the entry itself.
          await dequeueRestoreOn(sideDb.collection("_migrations"), entry);
          result.nameConflicts = (result.nameConflicts ?? 0) + 1;
          console.warn(
            `[sync] ${collectionName}: the row holding ${JSON.stringify(desiredName)} changed ` +
              `while being moved aside; leaving both rows alone this cycle.`,
          );
          return false;
        }
        // RE-ASSERT the record now that the placeholder actually EXISTS
        // (Codex P2). Age alone cannot distinguish a dead pass from a
        // SUSPENDED one: a laptop sleeping fifteen minutes between the
        // enqueue above and this point lets another service's sweep read the
        // aged entry against a row still holding its original name, judge it
        // resolved, and drain it — after which this resumed pass would stage
        // without the durable protection the queue exists to give. So the
        // record is refreshed the moment the vulnerable state begins: drop
        // any surviving copy, push a fresh one stamped NOW, which also
        // restarts the sweep's age window at the moment it matters. A crash
        // between the two writes leaves a placeholder with no record — the
        // grammar backstop's case, covered. A refresh failure is logged and
        // tolerated: the subsequent copy write shares the same connection
        // and will surface the real problem itself.
        try {
          await sideDb
            .collection("_migrations")
            .updateOne(
              { _id: RESTORE_QUEUE_ID as unknown as ObjectId },
              { $pull: { entries: { c: entry.c, i: entry.i, o: entry.o, p: entry.p } } as Document },
            );
          await sideDb
            .collection("_migrations")
            .updateOne(
              { _id: RESTORE_QUEUE_ID as unknown as ObjectId },
              { $push: { entries: { ...entry, at: new Date() } } as Document },
              { upsert: true },
            );
        } catch (refreshErr) {
          console.warn(
            `[sync] ${collectionName}: could not refresh the staging-restore entry for ${entry.i}.`,
            refreshErr,
          );
        }

        // Remember it so an unsettled placeholder can be restored below — a
        // row left named `__sync-staging-…` is visible in the UI and worse
        // than the collision we were avoiding.
        stagedRenames.push({
          col,
          id: blocker._id as ObjectId,
          originalName: blockerName,
          placeholderName: placeholder,
        });
        try {
          await write();
        } catch (retryErr) {
          // ROLL BACK IMMEDIATELY (Codex P2). A throw here used to exit
          // `syncCollection` through `trySync`, skipping settlement entirely,
          // so the row would keep the temporary name indefinitely. Settlement
          // now runs on that path too (see the loop's catch), which makes this
          // the fast path rather than the only chance.
          //
          // Deliberately NOT composing a stranding message here. The blocker is
          // still in `stagedRenames`, and settlement is the SINGLE place that
          // reports what it could not restore — reporting in both named the
          // same row twice, and named only this row while a late failure
          // strands every row moved aside earlier in the pass as well.
          await col
            .updateOne({ _id: blocker._id, name: placeholder }, { $set: { name: blockerName } })
            .catch((rollbackErr: unknown) => {
              console.error(
                `[sync] ${collectionName}: could not roll ${String(blocker._id)} back to ` +
                  `${JSON.stringify(blockerName)}; leaving it to settlement.`,
                rollbackErr,
              );
              return null;
            });
          throw retryErr;
        }
        return true;
      }
    };

    const result: SyncResult = { collection: collectionName, pushed: 0, pulled: 0, updated: 0, deleted: 0 };
    // GH #1153: a stranding the sweep could not restore FAILS the collection
    // (the #1142 posture — a reported, recoverable stall beats an invisible
    // one). The notices are already seeded into `strandedNotices` above, so
    // they ride the same rendering as a fresh stranding.
    if (sweptConflicts.length > 0) {
      result.nameConflicts = (result.nameConflicts ?? 0) + sweptConflicts.length;
    }

    // GH #1142: settle any placeholder whose real write never landed.
    //
    // A row is moved aside on the expectation that its own write follows
    // moments later. If that write did not happen — its branch threw, the row
    // was skipped, the LWW went the other way — it is left named
    // `__sync-staging-…`, which is VISIBLE in the UI and worse than the
    // collision being avoided. Restore the original name when it is free
    // again; if it is not, leave the placeholder and report, because
    // overwriting the row that took it would destroy real data.
    //
    // A FUNCTION, called on EVERY exit from the row loop (Codex P1). Inline
    // after the loop, it was skipped entirely whenever the loop threw — and
    // `stagedRenames` accumulates ACROSS iterations, so one late failure
    // abandoned every row moved aside earlier in the pass, silently and with
    // no later-cycle sweep to catch it.
    const settleStagedRenames = async (): Promise<void> => {
      // Drained, so a second call cannot re-report or re-restore.
      const pending = stagedRenames.splice(0, stagedRenames.length);
      for (const staged of pending) {
        // GH #1153: settlement is where the durable queue drains for every
        // resolved outcome — it visits every staged row on every exit path
        // and is the one place that knows how each ended. The entry stays
        // queued ONLY on `taken` and on the catch below, which are exactly
        // the strandings the next cycle's sweep exists to retry.
        // A KEY, not a full entry: the dequeue matcher matches on {c,i,o,p}
        // (query subset semantics), and settlement does not know — and does
        // not need — the enqueue timestamp.
        const stagedEntry: RenameStagingRestoreKey = {
          c: collectionName,
          i: String(staged.id),
          o: staged.originalName,
          p: staged.placeholderName,
        };
        const stagedDb = staged.col === remoteCol ? remoteDb : localDb;
        try {
          const row = await staged.col.findOne(
            { _id: staged.id },
            { projection: { name: 1 } },
          );
          if (!row || !isStagingPlaceholder(row.name)) {
            // Its write landed (or a rollback restored it, or a human renamed
            // it) — no placeholder remains, nothing to recover later.
            await dequeueRestoreOn(stagedDb.collection("_migrations"), stagedEntry);
            continue;
          }
          const taken = await staged.col.findOne(
            { name: staged.originalName, _deletedAt: null, _id: { $ne: staged.id } },
            { projection: { _id: 1 } },
          );
          if (taken) {
            // NAME the row, do not just count it (Codex P1). This branch and the
            // catch below are the two REACHABLE producers of a permanent
            // placeholder — no race, no privilege change — and until now their
            // only trace was a console line plus a counter whose rendering could
            // be overwritten entirely (see the `heldBack` note at the end).
            result.nameConflicts = (result.nameConflicts ?? 0) + 1;
            strandedNotices.push(
              strandedPlaceholderNotice({
                collection: collectionName,
                id: String(staged.id),
                originalName: staged.originalName,
                placeholderName: staged.placeholderName,
              }),
            );
            console.warn(
              `[sync] ${collectionName}: left a staging placeholder on ${String(staged.id)} — ` +
                `${JSON.stringify(staged.originalName)} was taken while it was moved aside.`,
            );
            continue;
          }
          // CONDITIONAL on the placeholder we actually put there (Codex P1).
          // Another app or syncer can write this row between the read above and
          // here; an `_id`-only filter would overwrite that newer real name with
          // the old one — and because the concurrent write may already have
          // copied its `updatedAt`, the peers could end up with different names
          // at an EQUAL timestamp, which LWW then never repairs.
          const restored = await staged.col.updateOne(
            { _id: staged.id, name: staged.placeholderName },
            { $set: { name: staged.originalName } },
          );
          // Restored, or someone else moved it on — either way no placeholder
          // remains under this entry's name, so it drains.
          await dequeueRestoreOn(stagedDb.collection("_migrations"), stagedEntry);
          if (!restored.modifiedCount) continue;
        } catch (settleErr) {
          // SURFACE it (Codex P1). Swallowing left the collection reporting
          // success with a placeholder still stored, and nothing scans for stale
          // placeholders on a later cycle — worse, a row staged after its own
          // write landed shares its source's `updatedAt`, so LWW does no copy
          // and never repairs it either.
          result.nameConflicts = (result.nameConflicts ?? 0) + 1;
          strandedNotices.push(
            strandedPlaceholderNotice({
              collection: collectionName,
              id: String(staged.id),
              originalName: staged.originalName,
              placeholderName: staged.placeholderName,
            }),
          );
          console.error(
            `[sync] ${collectionName}: could not restore ${JSON.stringify(staged.originalName)} ` +
              `on ${String(staged.id)}; it still holds a staging placeholder.`,
            settleErr,
          );
        }
      }
    };

    // Process all unique syncIds from both sides — BOTH-SIDES ROWS FIRST.
    //
    // GH #1116 (Codex P1): an INSERT can collide on the partial unique name
    // index with a row whose own UPDATE would have freed that name. Concrete
    // shape: local A "X" and local B "Y" (B was just renamed), remote holds
    // only B, still named "X". Reaching A first inserts "X" beside remote B's
    // "X" and E11000s, aborting the collection before B's rename is copied —
    // and the same ordering repeats every cycle, so locations never converge
    // and filaments + print history stay cascade-skipped. Copying B's rename
    // first frees the name and A inserts cleanly.
    //
    // Ordering only: each row's own LWW decision is unchanged, and the two
    // groups are independent of each other.
    const paired: string[] = [];
    const unpaired: string[] = [];
    for (const syncId of new Set([...localBySyncId.keys(), ...remoteBySyncId.keys()])) {
      (localBySyncId.has(syncId) && remoteBySyncId.has(syncId) ? paired : unpaired).push(syncId);
    }
    const allSyncIds = pairedOnly ? paired : [...paired, ...unpaired];
    const heldBack = pairedOnly ? unpaired.length : 0;
    if (heldBack > 0) {
      console.warn(
        `[sync] ${collectionName}: trim skipped this collection — copying ` +
          `${paired.length} paired record(s) only, holding back ` +
          `${heldBack} unpaired one(s) until names can be normalized`,
      );
    }

    // Wrapped so SETTLEMENT ALWAYS RUNS (Codex P1) — see the note above it.
    try {
      for (const syncId of allSyncIds) {
        // GH #1153 (Codex P2): a row the sweep left holding an unresolved
        // placeholder is excluded from transfer this cycle — see the
        // quarantine set's docblock. Marked processed anyway, so a blocker
        // check treats it as "no write coming", which is the truth.
        if (quarantinedSyncIds.has(syncId)) {
          processedSyncIds.add(syncId);
          continue;
        }
        // Marked at the TOP, not the bottom: the body is full of `continue`s
        // and a trailing add would be skipped by every one of them. Including
        // the CURRENT id is harmless — `syncId` is unique per collection, so
        // a blocker (a different _id on the same col) can never carry it.
        processedSyncIds.add(syncId);
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
          const full = await hydrateLocal(localDoc);
          if (!full) continue;
          const doc = this.stripForTransfer(full);
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
          const full = await hydrateRemote(remoteDoc);
          if (!full) continue;
          const doc = this.stripForTransfer(full);
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
                // GH #1152: `??` passed a raw `_deletedAt: ""` straight
                // through — the fallback means "stamp a tombstone when there
                // is not one", and an unreadable value is not one. The purge
                // tombstone's timestamp never participates in LWW (the purge
                // branch precedes both delete arms and both-purged is a
                // no-op), so `new Date()` is inert here and matches
                // retombstonePurgedZombies' stamp.
                {
                  $set: {
                    _purged: true,
                    _deletedAt:
                      SyncService.readTimestamp(localDoc._deletedAt) != null
                        ? localDoc._deletedAt
                        : new Date(),
                  },
                },
              );
              result.deleted++;
            } else if (!localPurged && remotePurged) {
              await localCol.updateOne(
                { _id: localDoc._id },
                // GH #1152 — mirror of the local arm above.
                {
                  $set: {
                    _purged: true,
                    _deletedAt:
                      SyncService.readTimestamp(remoteDoc._deletedAt) != null
                        ? remoteDoc._deletedAt
                        : new Date(),
                  },
                },
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
              // GH #1152: same verbatim-write class as the purge sites, but
              // the fallback here is EPOCH, not `new Date()` — this tombstone
              // DOES participate in LWW (the branch above compared it), and it
              // won with an effective timestamp of 0. Stamping now would
              // promote it into a fresh delete that beats older live edits on
              // future cycles; epoch preserves the arithmetic that just ran.
              await remoteCol.updateOne(
                { _id: remoteDoc._id },
                {
                  $set: {
                    _deletedAt:
                      SyncService.readTimestamp(localDoc._deletedAt) != null
                        ? localDoc._deletedAt
                        : new Date(0),
                  },
                },
              );
              result.deleted++;
            } else {
              // Remote was updated strictly after local delete — resurrect locally
              const full = await hydrateRemote(remoteDoc);
              if (full) {
                const doc = this.stripForTransfer(full);
                const targetSpoolIds = transformDoc ? await fetchTargetSpoolIds(localCol, localDoc._id) : undefined;
                const transformed = transformDoc ? transformDoc(doc, "toLocal", targetSpoolIds) : doc;
                // GH #1004 F3: replaceOne, not $set. A whole-doc LWW copy must
                // also DELETE fields the source no longer has — the $unset
                // un-pinning flows (#951/#969/#971 un-pin a variant override so
                // GH #106 inheritance resumes) leave a field absent on the
                // source; $set can't remove it, and the equal-updatedAt result
                // then freezes the divergence forever. `transformed` is the
                // stripped source (no _id/__v), so replaceOne keeps the target
                // _id. Targeted flag $sets above stay $set (they mutate one key).
                // GH #1142: a resurrect sets a name too, and can contend.
                if (
                  await writeWithRenameStaging(localCol, localDoc._id as ObjectId, transformed.name, () =>
                    localCol.replaceOne({ _id: localDoc._id }, { ...transformed, _deletedAt: null }),
                  )
                ) {
                  result.pulled++;
                }
              }
            }
            continue;
          }

          if (!localDeleted && remoteDeleted) {
            // Mirror of the branch above — delete wins on a tie (GH #317).
            const remoteDeletedAt = SyncService.readTimestamp(remoteDoc._deletedAt) ?? 0;
            const localUpdatedAt = SyncService.readUpdatedAt(localDoc) ?? 0;
            if (remoteDeletedAt >= localUpdatedAt) {
              // GH #1152 — mirror of the toRemote arm; epoch for the same reason.
              await localCol.updateOne(
                { _id: localDoc._id },
                {
                  $set: {
                    _deletedAt:
                      SyncService.readTimestamp(remoteDoc._deletedAt) != null
                        ? remoteDoc._deletedAt
                        : new Date(0),
                  },
                },
              );
              result.deleted++;
            } else {
              const full = await hydrateLocal(localDoc);
              if (full) {
                const doc = this.stripForTransfer(full);
                const targetSpoolIds = transformDoc ? await fetchTargetSpoolIds(remoteCol, remoteDoc._id) : undefined;
                const transformed = transformDoc ? transformDoc(doc, "toRemote", targetSpoolIds) : doc;
                // GH #1004 F3: replaceOne so a whole-doc copy also drops fields
                // the source no longer carries (see the toLocal branch above).
                // GH #1142: see the toLocal resurrect above.
                if (
                  await writeWithRenameStaging(remoteCol, remoteDoc._id as ObjectId, transformed.name, () =>
                    remoteCol.replaceOne({ _id: remoteDoc._id }, { ...transformed, _deletedAt: null }),
                  )
                ) {
                  result.pushed++;
                }
              }
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
            const full = await hydrateLocal(localDoc);
            if (full) {
              const doc = this.stripForTransfer(full);
              const targetSpoolIds = transformDoc ? await fetchTargetSpoolIds(remoteCol, remoteDoc._id) : undefined;
              const transformed = transformDoc ? transformDoc(doc, "toRemote", targetSpoolIds) : doc;
              // GH #1004 F3: replaceOne so the LWW copy drops fields the source
              // deleted (un-pin $unset flows); $set would freeze the divergence.
              // GH #1142: a rename may want a name another row still holds.
              if (
                await writeWithRenameStaging(remoteCol, remoteDoc._id as ObjectId, transformed.name, () =>
                  remoteCol.replaceOne({ _id: remoteDoc._id }, transformed),
                )
              ) {
                result.updated++;
              }
            }
          } else if (remoteTime > localTime) {
            // Remote is newer — pull to local
            const full = await hydrateRemote(remoteDoc);
            if (full) {
              const doc = this.stripForTransfer(full);
              const targetSpoolIds = transformDoc ? await fetchTargetSpoolIds(localCol, localDoc._id) : undefined;
              const transformed = transformDoc ? transformDoc(doc, "toLocal", targetSpoolIds) : doc;
              // GH #1004 F3: replaceOne (see the toRemote branch above).
              // GH #1142: see the toRemote branch above.
              if (
                await writeWithRenameStaging(localCol, localDoc._id as ObjectId, transformed.name, () =>
                  localCol.replaceOne({ _id: localDoc._id }, transformed),
                )
              ) {
                result.updated++;
              }
            }
          }
          // Equal timestamps — no action needed
        }
      }

    } catch (loopErr) {
      await settleStagedRenames();
      // `trySync` discards this result object and keeps only the message, so
      // on THIS path the stranding has to ride the error instead.
      if (strandedNotices.length > 0) {
        throw withStrandingNotice(loopErr, strandedNotices.join(" "));
      }
      throw loopErr;
    }

    await settleStagedRenames();

    // GH #1116 (Codex P1): a HELD-BACK collection must read as a FAILED
    // prerequisite, or `trySync` lets its dependents run against a partial
    // mapping. Concretely: hold back an unpaired location, and
    // `buildFilamentRefsTransform` cannot resolve a referencing spool's
    // `locationId` on the target, writes null, and stamps the copy with the
    // SOURCE timestamp — after which the repair pass (which ignores null
    // refs) never restores it. Syncing that location on a later cycle does
    // not undo the loss. A blocked, reported cycle is recoverable; a nulled
    // reference is not.
    //
    // The counts above stay real — the paired copies DID happen, so a user's
    // rename still propagates and the collection can converge. Only the
    // dependents wait.
    // GH #1142 (Codex P1): a name conflict has to reach the user.
    //
    // Incrementing a counter nothing reads left `trySync` treating the
    // collection as successful and the cycle reporting `idle`, while a
    // whole-document update was silently skipped and would fail identically
    // every cycle — permanent divergence with no signal at all.
    //
    // This is deliberately stricter than the paired/unpaired split agreed for
    // the SWAP case: a swap now RESOLVES, so anything still counted here is
    // the unsatisfiable kind — a row that will never sync until a human
    // renames one of the two. Cascade-skipping dependents is over-strict for
    // that (both rows exist on both peers, so refs still resolve), but a
    // reported, recoverable stall beats an invisible one.
    if ((result.nameConflicts ?? 0) > 0 && !result.error) {
      result.error =
        `${result.nameConflicts} name conflict(s) could not be applied — two rows want ` +
        `the same name and neither can give it up. Rename one of them.`;
    }
    // A row left holding `__sync-staging-…` needs a HUMAN, and nothing scans
    // for stale placeholders on a later cycle — the equal-`updatedAt` case
    // documented above is never repaired by LWW either. So name the rows, do
    // not merely count them.
    if (strandedNotices.length > 0) {
      result.error = `${result.error ? `${result.error} ` : ""}${strandedNotices.join(" ")}`;
    }

    if (heldBack > 0) {
      // APPEND (Codex P1). This used to ASSIGN, so a held-back collection that
      // also stranded a placeholder reported only the hold-back — and that text
      // blames the trim pass, sending the user somewhere the actual problem is
      // not. Both facts are true at once and both need saying.
      const held =
        `held back ${heldBack} unpaired record(s) — the trim pass skipped this ` +
        `collection, so its names cannot be matched safely yet`;
      result.error = result.error ? `${result.error} Also: ${held}` : held;
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
   * GH #1021 r25: attempt the FIELD-LEVEL, timestamp-honest clear of one
   * legacy-condition pair on both databases. Each write's filter re-asserts
   * the exact syncId + condition + updatedAt the transit observed and sets
   * ONLY the condition to "" — a row the user has since edited misses its
   * filter and normal LWW then owns the pair. Returns true once NEITHER side
   * matches the observed state anymore (converged or user-superseded), which
   * is the dequeue condition for the durable retry queue.
   */
  private async attemptTransitClearPair(
    localDb: Db,
    remoteDb: Db,
    entry: { d: string; s: string; c: string; u: unknown; p: unknown; r: unknown },
  ): Promise<boolean> {
    const sourceDb = entry.d === "toLocal" ? remoteDb : localDb;
    const targetDb = entry.d === "toLocal" ? localDb : remoteDb;
    // Codex P2 r26: REVALIDATE the provenance persisted with the entry on
    // EVERY attempt — including drain-time replays. A parent tick edit or a
    // referenced nozzle's diameter edit between the enqueue and this replay
    // leaves the child row byte-identical (filters would still match) while
    // a fresh derivation now classifies the value as a user pin. Unverifiable
    // or drifted provenance DROPS the entry without touching either row —
    // whatever value still sits there is preserved as a possible pin.
    let refs: unknown[] | null = Array.isArray(entry.r) && entry.r.length > 0 ? entry.r : null;
    if (!refs && entry.p != null) {
      const parentNow = await sourceDb.collection("filaments").findOne(
        { _id: entry.p as ObjectId, _deletedAt: null },
        { projection: { compatibleNozzles: 1 } },
      );
      refs = Array.isArray(parentNow?.compatibleNozzles)
        ? (parentNow!.compatibleNozzles as unknown[])
        : null;
    }
    if (!refs || refs.length === 0) {
      // Nothing provable → drop, but reconcile a partial clear first (r27).
      await this.reconcilePartialTransitPair(sourceDb, targetDb, entry);
      return true;
    }
    const nozzleDocs = await sourceDb.collection("nozzles")
      .find({ _id: { $in: refs as ObjectId[] } }, { projection: { _id: 1, diameter: 1 } })
      .toArray();
    if (deriveLegacyNozzleCondition(nozzleDocs) !== entry.c) {
      // Drifted → the value is a possible pin → drop, after reconciling.
      await this.reconcilePartialTransitPair(sourceDb, targetDb, entry);
      return true;
    }

    const filter = {
      syncId: entry.s,
      "settings.compatible_printers_condition": entry.c,
      updatedAt: (entry.u ?? null) as Date | null,
    };
    const update = { $set: { "settings.compatible_printers_condition": "" } };
    await targetDb.collection("filaments").updateOne(filter, update);
    await sourceDb.collection("filaments").updateOne(filter, update);
    const stillTarget = await targetDb.collection("filaments").findOne(filter, { projection: { _id: 1 } });
    const stillSource = await sourceDb.collection("filaments").findOne(filter, { projection: { _id: 1 } });
    return !stillTarget && !stillSource;
  }

  /**
   * GH #1021 r27: before DROPPING a queue entry whose provenance is now
   * unverifiable or drifted, undo any PARTIAL clear an earlier attempt left:
   * one side cleared ("" at exactly the observed updatedAt — our clears
   * preserve timestamps, so this is our own signature) while the other still
   * holds the observed value. Restore the surviving value onto the cleared
   * side so both sides carry the possible pin again — otherwise the pair
   * would sit divergent at equal timestamps, which LWW skips forever. A row
   * the user has since edited misses these exact-updatedAt filters entirely.
   * Failures propagate so the entry stays queued and the reconcile retries.
   */
  private async reconcilePartialTransitPair(
    sourceDb: Db,
    targetDb: Db,
    entry: { s: string; c: string; u: unknown },
  ): Promise<void> {
    const observedFilter = {
      syncId: entry.s,
      "settings.compatible_printers_condition": entry.c,
      updatedAt: (entry.u ?? null) as Date | null,
    };
    const clearedFilter = {
      syncId: entry.s,
      "settings.compatible_printers_condition": "",
      updatedAt: (entry.u ?? null) as Date | null,
    };
    const restore = { $set: { "settings.compatible_printers_condition": entry.c } };
    const sourceHolds = await sourceDb.collection("filaments").findOne(observedFilter, { projection: { _id: 1 } });
    const targetHolds = await targetDb.collection("filaments").findOne(observedFilter, { projection: { _id: 1 } });
    if (sourceHolds && !targetHolds) {
      await targetDb.collection("filaments").updateOne(clearedFilter, restore);
    } else if (targetHolds && !sourceHolds) {
      await sourceDb.collection("filaments").updateOne(clearedFilter, restore);
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
    blockedNames?: ReadonlySet<string>,
  ): Promise<void> {
    await this.reconcileByName(localDb, remoteDb, "locations", blockedNames);
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
    blockedNames?: ReadonlySet<string>,
  ): Promise<void> {
    await this.reconcileByName(localDb, remoteDb, "bedtypes", blockedNames);
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
    blockedNames?: ReadonlySet<string>,
  ): Promise<void> {
    await this.reconcileByName(localDb, remoteDb, "filaments", blockedNames);
  }

  /**
   * Same name-collision resolver, applied to nozzles (GH #1116). Nozzle has
   * the partial-unique-on-non-deleted `name` index, and the entity-name trim
   * that now runs before every cycle can make two independently-created rows
   * NEWLY equal — so this has to run before the nozzle sync, or the insert
   * walks into the index and the failure cascade-skips everything downstream.
   */
  private async reconcileNozzlesByName(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
    blockedNames?: ReadonlySet<string>,
  ): Promise<void> {
    await this.reconcileByName(localDb, remoteDb, "nozzles", blockedNames);
  }

  /** Same, for printers — identical index and identical exposure. */
  private async reconcilePrintersByName(
    localDb: ReturnType<MongoClient["db"]>,
    remoteDb: ReturnType<MongoClient["db"]>,
    blockedNames?: ReadonlySet<string>,
  ): Promise<void> {
    await this.reconcileByName(localDb, remoteDb, "printers", blockedNames);
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
    /** Names whose normalization is unresolved, so pairing them by name is
     *  unsafe. Scoped to those names — a conflict elsewhere in the collection
     *  must not stop unrelated rows from being unified. */
    blockedNames?: ReadonlySet<string>,
  ): Promise<void> {
    const localCol = localDb.collection(collectionName);
    const remoteCol = remoteDb.collection(collectionName);
    const localActive = await localCol.find({ _deletedAt: null }).toArray();
    const remoteActive = await remoteCol.find({ _deletedAt: null }).toArray();

    const remoteByName = new Map(remoteActive.map((d) => [d.name as string, d]));

    for (const local of localActive) {
      const remote = remoteByName.get(local.name as string);
      if (!remote) continue;
      if (blockedNames?.has(local.name as string)) continue;

      const localSyncId = local.syncId as string | undefined;
      const remoteSyncId = remote.syncId as string | undefined;

      if (localSyncId && remoteSyncId && localSyncId === remoteSyncId) continue;

      // GH #1116 (Codex P1): a row whose syncId ALREADY resolves on the other
      // peer is paired, and a name match must never override that.
      //
      // This helper exists for rows created INDEPENDENTLY on the two sides
      // before sync reached the collection — neither has a counterpart, so
      // matching by name is the only way to pair them. Once a counterpart
      // exists, the name is transient: it can differ simply because the last
      // rename hasn't been copied across yet. That is exactly what the trim
      // work makes reachable — local A "X" and local B renamed to "Y", while
      // remote B still carries the trimmed "X". Pairing by name then hands A
      // and B the same syncId and LWW overwrites one with the other; spool
      // locationId maps would resolve to the wrong row on top of that.
      //
      // Cheap to check, and it strictly narrows the helper to its own stated
      // purpose: the first-sync case has no counterparts on either side and
      // is unaffected.
      if (localSyncId && (await remoteCol.findOne({ syncId: localSyncId, _id: { $ne: remote._id } }))) {
        console.warn(
          `reconcileByName(${collectionName}): "${local.name}" already has a remote counterpart by syncId — not pairing by name`,
        );
        continue;
      }
      if (remoteSyncId && (await localCol.findOne({ syncId: remoteSyncId, _id: { $ne: local._id } }))) {
        console.warn(
          `reconcileByName(${collectionName}): "${local.name}" — the remote row already has a local counterpart by syncId; not pairing by name`,
        );
        continue;
      }

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
    // GH #511: project to {_id, syncId, parentId, updatedAt}. The repair
    // loops only read parentId + updatedAt off each doc; full doc payload
    // (incl. spools[].photoDataUrl base64) is irrelevant here.
    const lf = await localDb.collection("filaments").find({}, { projection: { _id: 1, syncId: 1, parentId: 1, updatedAt: 1 } }).toArray();
    const rf = await remoteDb.collection("filaments").find({}, { projection: { _id: 1, syncId: 1, parentId: 1, updatedAt: 1 } }).toArray();

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
    deferredLegacyChecks: Array<{
      direction: "toLocal" | "toRemote";
      syncId: string;
      observed: string;
      observedUpdatedAt: unknown;
      parentId: unknown;
      ownRefs: unknown[] | null;
    }>,
  ): (
    doc: Document,
    direction: "toLocal" | "toRemote",
    targetSpoolIds?: (string | undefined)[],
  ) => Document {
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

    return (
      doc: Document,
      direction: "toLocal" | "toRemote",
      targetSpoolIds?: (string | undefined)[],
    ): Document => {
      const sourceNozzleIdToSyncId = direction === "toLocal" ? remoteNozzleIdToSyncId : localNozzleIdToSyncId;
      const targetNozzleMap = direction === "toLocal" ? localNozzleBySyncId : remoteNozzleBySyncId;
      const sourcePrinterIdToSyncId = direction === "toLocal" ? remotePrinterIdToSyncId : localPrinterIdToSyncId;
      const targetPrinterMap = direction === "toLocal" ? localPrinterBySyncId : remotePrinterBySyncId;
      const sourceLocationIdToSyncId = direction === "toLocal" ? remoteLocationIdToSyncId : localLocationIdToSyncId;
      const targetLocationMap = direction === "toLocal" ? localLocationBySyncId : remoteLocationBySyncId;
      const sourceBedTypeIdToSyncId = direction === "toLocal" ? remoteBedTypeIdToSyncId : localBedTypeIdToSyncId;
      const targetBedTypeMap = direction === "toLocal" ? localBedTypeBySyncId : remoteBedTypeBySyncId;

      // GH #1021 (Codex P1 r17): the LWW copy is itself an INGESTION boundary.
      // A pre-#1022 peer in a mixed-version hybrid pair can push a NEWER doc
      // still carrying the stamped machine condition AFTER both sides'
      // one-shot markers completed — and the copy would replicate it verbatim,
      // resurrecting the hidden-preset bug with no migration left to run. So
      // every copied filament gets the same provenance-matched treatment as
      // the slicer/import boundaries, resolved against the SOURCE side (whose
      // ticks are the world the stamp was made in). Runs BEFORE the ref remap
      // below (it needs the source-side ids). Missing provenance (dangling
      // refs, no parent) strips nothing — the conservative direction.
      //
      // GH #1021 r25: NOTHING is stripped in transit — the copy rides
      // verbatim (honest timestamps, the snapshot is never authoritative).
      // The transform only RECORDS syntactic candidates, capturing the
      // source-side provenance ids BEFORE the remaps below; sync() judges
      // them after the collection sync against fresh source-side state and
      // applies field-level conditional clears to both sides.
      const condition = (doc.settings as Record<string, unknown> | undefined)?.compatible_printers_condition;
      if (
        typeof condition === "string" &&
        LEGACY_NOZZLE_CONDITION_RE.test(condition) &&
        typeof doc.syncId === "string" &&
        doc.syncId
      ) {
        const ownRefs = Array.isArray(doc.compatibleNozzles) && doc.compatibleNozzles.length > 0
          ? ([...(doc.compatibleNozzles as unknown[])])
          : null;
        if (ownRefs || doc.parentId != null) {
          deferredLegacyChecks.push({
            direction,
            syncId: doc.syncId,
            observed: condition,
            observedUpdatedAt: doc.updatedAt ?? null,
            parentId: ownRefs ? null : doc.parentId,
            ownRefs,
          });
        }
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
      //
      // GH #732: also normalize spools[].instanceId. Synced docs are written
      // with raw insertOne/updateOne, which bypass BOTH the Mongoose schema
      // default and the dbConnect() backfill — so a spool pulled from a
      // pre-#732 peer would otherwise arrive with no instanceId, leaving the
      // "every spool has a 5-byte hex id" invariant false on the hybrid-sync
      // path. Existing ids are preserved; only missing/empty ones are minted.
      //
      // The minted id is DERIVED from the source spool's `_id` (not random) so
      // it is STABLE across re-syncs of the same spool: if the id-less peer
      // wins a later last-write-wins cycle, re-normalizing yields the SAME id
      // rather than rotating it — which would otherwise invalidate any
      // label/NFC/match that saved the prior value. Full cross-side
      // convergence (both peers agreeing on one id for the same physical spool)
      // still requires stable cross-side spool identity — the deferred
      // spool-syncId migration, the same limitation that clears
      // amsSlots[].spoolId / usage[].spoolId on cross-side remap.
      if (Array.isArray(doc.spools)) {
        doc.spools = doc.spools.map((spool: Document, idx: number) => {
          // Precedence: the source spool's own id wins (it's the authoritative
          // last-write-wins value); else REUSE the target's existing id at this
          // position so an id-less source doesn't rotate an id the target
          // already backfilled; else derive a stable id from the source spool
          // _id (so re-syncs don't churn); else random as a last resort.
          const instanceId =
            (typeof spool.instanceId === "string" && spool.instanceId
              ? spool.instanceId
              : undefined) ??
            targetSpoolIds?.[idx] ??
            (spool._id
              ? createHash("sha1").update(String(spool._id)).digest("hex").slice(0, 10)
              : randomBytes(5).toString("hex"));
          if (!spool.locationId) return { ...spool, instanceId };
          const locSyncId = sourceLocationIdToSyncId.get(spool.locationId.toString());
          const targetLocationId = locSyncId ? targetLocationMap.get(locSyncId) : null;
          return { ...spool, instanceId, locationId: targetLocationId || null };
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
    // #823: signal an in-flight cycle to stop after its current collection so
    // it doesn't keep converging a DB the caller is about to abandon (mode
    // switch / quit). Returns immediately — the running collection's writes
    // were already issued, but no further collection or repair pass runs.
    this.aborted = true;
    this.stopPeriodicSync();
    this.removeAllListeners();
  }
}

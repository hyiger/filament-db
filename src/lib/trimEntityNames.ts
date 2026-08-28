/**
 * One-time normalization of edge whitespace on entity names (GH #1116).
 *
 * ## The bug
 *
 * Nothing normalized a name on write. `Drybox #1 ` and `Drybox #1` were two
 * distinct rows that render identically everywhere in the app, and the CSV
 * round-trip manufactured the second one: `csvCell` didn't quote a value with
 * edge whitespace, `parseCsv` strips whitespace from an UNQUOTED field, so the
 * exported name came back trimmed, matched nothing, and the spool importer
 * auto-created a duplicate location and moved every re-imported spool onto it
 * — the original silently dropping to zero spools. The same root cause made
 * every spool row of a filament named `PLA Basic ` fail with
 * `No filament named "PLA Basic"`.
 *
 * The schema now carries `trim: true` on `name`, which fixes it going forward.
 * This pass fixes what is already stored.
 *
 * ## Why it refuses to merge
 *
 * When both `X` and `X ` exist, trimming the second collides with the first on
 * the partial unique index. Merging them is NOT a migration's decision: a
 * Location merge has to re-point every `spools[].locationId`, a Filament merge
 * has to reconcile two independent spool arrays and calibration sets. Both
 * deserve a human. So a colliding row is LEFT ALONE and reported by name, and
 * the caller surfaces it — a visible, editable duplicate beats a silent
 * automatic merge of records the user may not consider the same thing.
 *
 * ## Why driver-level — this one is not a preference
 *
 * Mongoose applies a String schema setter to QUERY values, not just writes.
 * So the moment `name` carries `trim: true`, `Filament.findOne({ name: "X " })`
 * casts to `"X"` and a stored `"X "` becomes **unreachable through Mongoose by
 * name at all** — verified against a real connection, not assumed. The rows
 * this pass exists to repair are exactly those rows.
 *
 * A Mongoose-level migration therefore could not even SELECT its targets. The
 * raw driver does no casting, which is the only reason this works. (It also
 * means the collision surfaces as a genuine E11000 rather than a cast error,
 * and that the write's intent stays readable.)
 *
 * The same property is why the pass runs EARLY in `dbConnect`: until it
 * finishes, any name-addressed lookup — the importers, the slicer sync, the
 * match endpoint — silently misses an untrimmed row.
 *
 * ## And why hybrid sync runs it too, every cycle
 *
 * `electron/sync-service.ts` copies whole documents with the raw driver, so
 * it bypasses the setter completely: an untrimmed name on a PRE-UPGRADE peer
 * lands verbatim on the other side, unreachable by name for the reason above,
 * and the same-name reconcilers compare raw names so `"X"` and `"X "` would
 * propagate as two separate records. `dbConnect`'s pass can't cover that —
 * the REMOTE never runs it, and a pre-upgrade peer keeps producing untrimmed
 * names after any one-shot. So the sync runs this on BOTH databases ahead of
 * every copy, best-effort (a collision is reported, never fatal: refusing to
 * sync at all would be worse than one stale name).
 *
 * Taking a minimal driver-shaped `db` (the shape `legacyNozzleConditions`
 * established) additionally lets it unit-test without a live connection.
 */

/** Every collection whose `name` is an identity key with a unique index. */
export const TRIMMABLE_COLLECTIONS = [
  "filaments",
  "nozzles",
  "printers",
  "bedtypes",
  "locations",
] as const;

export type TrimmableCollection = (typeof TRIMMABLE_COLLECTIONS)[number];

/**
 * Every character `String.prototype.trim` strips: ECMA-262's WhiteSpace and
 * LineTerminator productions, plus U+FEFF.
 *
 * Spelled out because the MongoDB pre-filter has to select the SAME set.
 * Mongo's `\s` is PCRE's — ASCII-only in practice — so a name
 * ending in U+00A0 or U+3000 was never returned by the query, and the JS
 * re-check below never got the chance to repair it. Which is the worst
 * possible failure here: the schema setter WOULD trim that name on the
 * document's next save, so the two halves of the fix disagreed about what a
 * name is, and the row stayed a silent duplicate until something happened to
 * touch it.
 */
export const JS_TRIM_CHARS =
  "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680" +
  "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A" +
  "\u2028\u2029\u202F\u205F\u3000\uFEFF";

/** The selector for "name has edge whitespace", in MongoDB regex syntax. */
export const EDGE_WHITESPACE_PATTERN = `^[${JS_TRIM_CHARS}]|[${JS_TRIM_CHARS}]$`;

/** A name with leading or trailing whitespace, in any of the forms JS's
 *  `String.prototype.trim` recognizes. `trim()` is what the schema setter
 *  uses, so this is the authoritative test — `EDGE_WHITESPACE_PATTERN` is
 *  only a pre-filter, and `tests/trimEntityNames.test.ts` pins that the two
 *  agree character for character. */
export function hasEdgeWhitespace(name: string): boolean {
  return name !== name.trim();
}

export interface TrimNameConflict {
  collection: TrimmableCollection;
  /** The stored name, untouched. */
  name: string;
  /**
   * Was the row ACTIVE — i.e. something a human could actually resolve?
   *
   * Every conflict is worth LOGGING, but only an active one can actually
   * make two databases disagree about identity in a way someone can fix,
   * which is what gates the hybrid sync. A soft-deleted or
   * `_purged` row with a whitespace-only name is untrimmable and always will
   * be, and it is invisible in the UI — so treating it as a gate would block
   * that collection's sync forever with no user-accessible resolution.
   */
  active: boolean;
  /**
   * The blocked row's `_id` (GH #1149). The row is unreachable by NAME
   * through Mongoose — the schema's trim setter casts query values — so the
   * id is the ONLY handle a resolution surface can act through (the
   * id-addressed PUT/DELETE routes are unaffected by the setter).
   */
  id: string;
  /** What the name would trim to; null when trimming empties it. */
  trimsTo: string | null;
  /** Why the row was left alone. */
  reason: "collision" | "empty-name";
  /**
   * The active row already holding the trimmed name, when the pre-write
   * clash check saw it. Null on the empty-name case (nothing to collide
   * with) and on the E11000 race catch (the winner isn't re-queried — by
   * the time a surface renders this, the next pass's scan names it).
   */
  collidesWith: { id: string; name: string } | null;
}

export interface TrimEntityNamesResult {
  /** How many documents were rewritten. */
  trimmed: number;
  /**
   * Collections left ENTIRELY untouched because the protective unique index
   * could not be established.
   *
   * Writing without it is not "best effort", it is unsafe: the check and the
   * write are not atomic, so two writers — the app's dbConnect and the
   * Electron sync service, on the same local database over separate
   * connections — can each see a clear target and normalize two distinct rows
   * to the same name, MANUFACTURING the duplicate this pass exists to remove.
   * Doing nothing is strictly better; the caller keeps the migration
   * unsettled so it retries once the blocking duplicates are resolved.
   */
  skipped: { collection: TrimmableCollection; reason: string }[];
  /** Rows left alone because trimming them would collide with an existing
   *  row, or would empty the required field. */
  conflicts: TrimNameConflict[];
  /**
   * Rows whose trim failed for a reason that WILL resolve on its own, so the
   * caller must keep the migration unsettled and retry.
   *
   * The one producer: a peer still carrying the pre-#303 LEGACY plain unique
   * `name_1`, which — unlike the partial index this repo intends — also covers
   * DELETED rows. Two trashed rows named `"X"` and `"X "` are legal under the
   * intended index but collide under the legacy one, so the trim E11000s.
   *
   * That conflict is classified INACTIVE (both rows are deleted, so no active
   * row is involved), and inactive conflicts deliberately do not block — which
   * meant the migration SETTLED on it. `coreModelIndexes` then replaces the
   * legacy index with the partial one later in the very same connect, making
   * the write safe, but nothing ever retried it: the untrimmed tombstone stayed
   * untrimmed forever, and restoring it (which only touches `_deletedAt`) made
   * an untrimmed name ACTIVE and unreachable through Mongoose name queries —
   * GH #1116 itself, resurrected, on a database that had already "completed"
   * the migration.
   *
   * Kept separate from `skipped` on purpose: `skipped` also tells the sync
   * service to stop reconciling that collection BY NAME, which is a real cost
   * (an unrelated same-name pair then E11000s every cycle, the v1.11.3 bug).
   * Nothing here is unsafe to sync — the row simply needs another pass.
   */
  deferred: { collection: TrimmableCollection; reason: string }[];
}

interface MinimalCursor {
  toArray(): Promise<
    { _id: unknown; name?: unknown; _deletedAt?: unknown; _purged?: unknown }[]
  >;
}

interface MinimalCollection {
  /** Optional: absent on the unit-test fakes, which have no index to build. */
  createIndex?(
    spec: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  /** Optional: used only to accept an ALREADY-adequate index when
   *  `createIndex` refuses because one exists with different options. */
  indexes?(): Promise<{ key?: unknown; unique?: unknown }[]>;
  find(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): MinimalCursor;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount?: number } | unknown>;
}

export interface MinimalTrimDb {
  collection(name: string): MinimalCollection;
}

/**
 * Convert a legacy NON-unique `name_1` into the partial-unique index this
 * repo intends, returning whether the collection now has adequate protection.
 *
 * Ordering is the whole safety argument: build the replacement under an
 * explicit distinct name FIRST, and drop the legacy index only once it
 * exists. The collection is therefore never left without a name index, and a
 * failure at any step leaves the pre-existing state untouched.
 *
 * (The original attempt collides only because both indexes want the
 * auto-generated name `name_1` — MongoDB permits the same key pattern under
 * different names when the options differ.)
 *
 * Best-effort by construction: if the data still holds duplicate active names
 * the build throws, we report false, and the caller takes the ordinary skip
 * with its actionable message.
 */
const ACTIVE_UNIQUE_NAME_INDEX = "name_active_unique";

async function replaceInadequateNameIndex(collection: {
  createIndex?(
    spec: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  dropIndex?(name: string): Promise<unknown>;
  indexes?(): Promise<
    { name?: unknown; key?: unknown; unique?: unknown }[]
  >;
}): Promise<boolean> {
  if (!collection.createIndex || !collection.dropIndex || !collection.indexes) {
    return false;
  }
  try {
    const existing = await collection.indexes();
    // Only a PLAIN `{name: 1}` that is not unique qualifies. A compound index
    // is someone else's, and a unique one would already have been accepted.
    const legacy = existing.find((i) => {
      const key = i.key as Record<string, unknown> | undefined;
      if (!key || Object.keys(key).length !== 1 || key.name !== 1) return false;
      return i.unique !== true;
    });
    if (!legacy || typeof legacy.name !== "string") return false;

    await collection.createIndex(
      { name: 1 },
      {
        unique: true,
        partialFilterExpression: { _deletedAt: null },
        name: ACTIVE_UNIQUE_NAME_INDEX,
      },
    );
    // Only now is it safe to remove the old one.
    await collection.dropIndex(legacy.name);
    return true;
  } catch {
    // Duplicate active names, insufficient privileges on Atlas, a concurrent
    // builder — all end the same way: no conversion, ordinary skip.
    return false;
  }
}

/**
 * Does a unique index on `name` already exist?
 *
 * Any unique `{name: 1}` index serializes the writes this pass makes — the
 * legacy plain one from before GH #303 is strictly stricter than the partial
 * one the models now declare, since it also covers soft-deleted rows. The
 * partialFilterExpression is deliberately NOT compared: this asks "am I
 * serialized", not "is the index the one I would have built".
 */
async function hasUniqueNameIndex(collection: {
  indexes?(): Promise<
    { key?: unknown; unique?: unknown; partialFilterExpression?: unknown }[]
  >;
}): Promise<boolean> {
  if (!collection.indexes) return false;
  try {
    const existing = await collection.indexes();
    return existing.some((i) => {
      if (i.unique !== true) return false;

      // The key must be EXACTLY `{name: 1}`. A compound
      // `{name: 1, vendor: 1}` is unique over the PAIR and serializes nothing
      // about `name` on its own.
      const key = i.key as Record<string, unknown> | undefined;
      if (!key || key.name !== 1 || Object.keys(key).length !== 1) return false;

      // And it must cover every row this pass treats as active. No partial
      // filter at all is the legacy plain index — strictly stricter, fine.
      // Otherwise only the exact filter the models declare qualifies: a
      // narrower one (say `{_deletedAt: {$exists: true}}`, which misses
      // legacy rows where the field is absent) would leave precisely the
      // rows being trimmed unserialized, which is the whole hazard.
      const filter = i.partialFilterExpression as
        | Record<string, unknown>
        | undefined;
      if (filter === undefined || filter === null) return true;
      const keys = Object.keys(filter);
      return keys.length === 1 && keys[0] === "_deletedAt" && filter._deletedAt === null;
    });
  } catch {
    return false;
  }
}

/** MongoDB's duplicate-key error, however the driver surfaces it. */
function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 11000 || code === 11001) return true;
  // Some wrapped/serialized errors lose `.code` but keep the text — the same
  // belt-and-braces `coreModelIndexes` already applies.
  return /E11000|duplicate key/i.test(String((err as { message?: unknown }).message ?? ""));
}

/** What one candidate row should become. The write loop acts on it; the
 *  read-only scan collects the `conflict` arm. ONE decision point, so the
 *  GH #1149 surface and the migration cannot classify a row differently —
 *  `tests/trimEntityNames.test.ts` pins scan-vs-migrate parity on shared
 *  fixtures. */
type TrimCandidateDecision =
  | { kind: "skip" }
  | { kind: "conflict"; conflict: TrimNameConflict }
  | { kind: "trimmable"; next: string; active: boolean };

async function classifyTrimCandidate(
  collection: MinimalCollection,
  collectionName: TrimmableCollection,
  doc: { _id: unknown; name?: unknown; _deletedAt?: unknown; _purged?: unknown },
  isHidden: (row: { _purged?: unknown }) => boolean,
): Promise<TrimCandidateDecision> {
  if (typeof doc.name !== "string") return { kind: "skip" };
  if (!hasEdgeWhitespace(doc.name)) return { kind: "skip" };
  // A `_purged` row is NOT active for gating purposes, even when its
  // `_deletedAt` is still null.
  //
  // The previous version leaned on the `purgedZombies` migration having
  // re-tombstoned it — which is precisely the assumption
  // `SyncService.sync()` documents as unsafe: the REMOTE never runs
  // `dbConnect` at all, and the local side may sync before it does. So an
  // Atlas zombie (`_purged: true`, `_deletedAt: null`) with an
  // untrimmable name would permanently block filament and print-history
  // sync — the same unrecoverable, invisible failure the `active` flag
  // was introduced to prevent, reached by another door.
  //
  // A purge marker is a one-way tombstone the sync engine already
  // special-cases and the UI hides, so a human cannot resolve it. If such
  // a row is still in the partial index the worst case is a loud,
  // retryable E11000 on that collection — recoverable, and repaired by
  // the zombie migration on the next connect. Being blocked forever with
  // no signal is not.
  const active = doc._deletedAt == null && !isHidden(doc);
  const next = doc.name.trim();
  if (next === "") {
    // `name` is `required`, so a whitespace-only name can't be trimmed
    // into a legal value. Report it rather than writing "" and making the
    // document fail validation on its owner's next save.
    return {
      kind: "conflict",
      conflict: {
        collection: collectionName,
        name: doc.name,
        active,
        id: String(doc._id),
        trimsTo: null,
        reason: "empty-name",
        collidesWith: null,
      },
    };
  }
  // Check the target name BEFORE writing, rather than relying on the
  // unique index to report the collision. On a database whose
  // partial index is missing or stale — precisely the case `dbConnect`'s
  // `coreModelIndexes` pass exists to repair, and it runs AFTER this one
  // — both `"X"` and `"X "` would write through as `"X"`, and that later
  // pass would then hit E11000, deliberately skip rebuilding the index,
  // and leave two indistinguishable active rows with no uniqueness
  // enforcement at all. Worse than the duplicate this migration exists to
  // prevent.
  //
  // Only ACTIVE rows collide: every one of these indexes is partial on
  // `_deletedAt: null`, so a trashed row may freely share a name (GH #213
  // name reuse). The E11000 catch in the write loop stays as the race
  // guard for a conflicting row created between this check and the write.
  if (doc._deletedAt == null) {
    const clash = await collection
      .find({ name: next, _deletedAt: null }, { projection: { _id: 1, name: 1, _purged: 1 } })
      .toArray();
    const others = clash.filter((c) => String(c._id) !== String(doc._id));
    if (others.length > 0) {
      // The clash is real either way — the index covers `_deletedAt: null`
      // rows including a purge zombie, so the write genuinely can't
      // succeed. But whether it may GATE A SYNC depends on the CLASHING
      // row too, not just the candidate: if the only thing in the way is a hidden
      // untombstoned zombie, the user has nothing to act on — it isn't in
      // the trash, and the remote never runs the migration that would
      // repair it — so gating would block that collection forever.
      const resolvableByAHuman = others.some((c) => !isHidden(c));
      // Prefer naming a VISIBLE twin (a hidden zombie's id is nothing a
      // surface can render an action for).
      const visible = others.find((c) => !isHidden(c)) ?? others[0];
      return {
        kind: "conflict",
        conflict: {
          collection: collectionName,
          name: doc.name,
          active: active && resolvableByAHuman,
          id: String(doc._id),
          trimsTo: next,
          reason: "collision",
          collidesWith: {
            id: String(visible._id),
            name: typeof (visible as { name?: unknown }).name === "string"
              ? ((visible as { name?: unknown }).name as string)
              : next,
          },
        },
      };
    }
  }
  return { kind: "trimmable", next, active };
}

/**
 * GH #1149 — the READ-ONLY twin of `trimEntityNames`: same candidate query,
 * same per-row decision (`classifyTrimCandidate` is shared, so the two
 * cannot drift), but NO index build and NO writes — safe to serve from an
 * API route on demand. Returns every conflict the next migration pass would
 * report; rows the migration would trim are simply not conflicts and are
 * omitted.
 *
 * Unlike the migration it takes no index precautions, because it takes no
 * writes for an index to serialize.
 */
export async function scanTrimConflicts(db: MinimalTrimDb): Promise<TrimNameConflict[]> {
  const conflicts: TrimNameConflict[] = [];
  for (const collectionName of TRIMMABLE_COLLECTIONS) {
    const collection = db.collection(collectionName);
    const honorsPurged = collectionName === "filaments";
    const isHidden = (row: { _purged?: unknown }) =>
      honorsPurged && row._purged === true;
    const docs = await collection
      .find(
        { name: { $regex: EDGE_WHITESPACE_PATTERN } },
        { projection: { name: 1, _deletedAt: 1, _purged: 1 } },
      )
      .toArray();
    // The migration's clash checks see its OWN mid-pass writes: with " X"
    // and "X " and no stored "X", it trims the first and the second then
    // collides against the freshly-written "X". A per-row classification
    // against un-mutated state misses that pair entirely, so the scan
    // EMULATES the writes — same candidate order, and every name an earlier
    // ACTIVE trimmable row would have claimed counts as taken. (What it
    // cannot emulate is a mid-pass write FAILING under a legacy index — the
    // migration defers those rather than conflicting, so the scan stays
    // faithful for everything it reports.)
    const claimed = new Map<string, { id: string; name: string; hidden: boolean }>();
    for (const doc of docs) {
      const decision = await classifyTrimCandidate(collection, collectionName, doc, isHidden);
      if (decision.kind === "conflict") {
        conflicts.push(decision.conflict);
        continue;
      }
      if (decision.kind !== "trimmable") continue;
      const earlier = claimed.get(decision.next);
      if (earlier) {
        // The migration's clash lookup would find the earlier row already
        // holding the trimmed name. Same activeness rule as the real clash
        // branch: a conflict gates only when the thing in the way is
        // something a human can see (`resolvableByAHuman`) — a hidden
        // zombie claimer makes it inactive.
        conflicts.push({
          collection: collectionName,
          name: doc.name as string,
          active: decision.active && !earlier.hidden,
          id: String(doc._id),
          trimsTo: decision.next,
          reason: "collision",
          collidesWith: { id: earlier.id, name: earlier.name },
        });
        continue;
      }
      // Only a write the migration would actually make claims the name for
      // later clash checks: it writes tombstoned candidates too, but those
      // are OUTSIDE the partial index and the clash lookup queries
      // `_deletedAt: null` — so only rows IN the partial index claim
      // (which includes a hidden zombie: null `_deletedAt`, `_purged`).
      if (doc._deletedAt == null) {
        claimed.set(decision.next, {
          id: String(doc._id),
          name: decision.next,
          hidden: isHidden(doc),
        });
      }
    }
  }
  return conflicts;
}

/**
 * Trim edge whitespace off every stored entity name.
 *
 * Idempotent: the selector only matches rows that still have edge whitespace,
 * so a second run over a healthy database does nothing. Per-row writes rather
 * than one bulk pipeline, because a single collision must cost one row, not
 * the whole collection.
 */
export async function trimEntityNames(
  db: MinimalTrimDb,
): Promise<TrimEntityNamesResult> {
  let trimmed = 0;
  const conflicts: TrimNameConflict[] = [];
  const skipped: TrimEntityNamesResult["skipped"] = [];
  const deferred: TrimEntityNamesResult["deferred"] = [];

  for (const collectionName of TRIMMABLE_COLLECTIONS) {
    const collection = db.collection(collectionName);
    // `_purged` is a Filament-only concept. The other four schemas
    // don't declare it, so strict mode strips it and their APIs expose rows on
    // `_deletedAt: null` alone — a row carrying a stray `_purged` from legacy
    // or raw-synced data is still VISIBLE there, therefore still resolvable by
    // a human, therefore still a legitimate gate. Treating it as hidden would
    // let hybrid sync proceed with two visible colliding names, which ends in
    // E11000 or cross-peer identity divergence. Same scoping the snapshot
    // precheck already applies via `honorsPurged`.
    const honorsPurged = collectionName === "filaments";
    const isHidden = (row: { _purged?: unknown }) =>
      honorsPurged && row._purged === true;

    // Establish the constraint this pass RELIES on, before relying on it.
    // The pre-write clash check exists precisely because the
    // index may be missing on an upgrading database — but a check and a
    // write are not atomic, and nothing else serializes them. Two writers
    // (the app's dbConnect and the Electron sync service both run this, on
    // the same local DB, over separate connections) can each see a clear
    // target and both write `"X"`. The later `coreModelIndexes` pass then
    // hits E11000, deliberately skips the rebuild, and the collection is
    // left with duplicate active names and NO uniqueness enforcement at all
    // — worse than the duplicate this migration exists to remove.
    //
    // Creating it here is idempotent, matches the spec the models declare,
    // and cannot itself fail on the whitespace pairs: `"X"` and `"X "` are
    // still distinct at this point. BEST-EFFORT — a database that already
    // holds unrelated duplicate active names will refuse the build, and that
    // is exactly the state `coreModelIndexes` reports with actionable text;
    // falling back to the unserialized check is no worse than before.
    try {
      await collection.createIndex?.(
        { name: 1 },
        { unique: true, partialFilterExpression: { _deletedAt: null } },
      );
    } catch (err) {
      // A refusal is not necessarily an absence. A peer upgraded
      // from the pre-#303 schema still carries the LEGACY plain unique
      // `name_1`, and `createIndex` rejects a differing
      // partialFilterExpression with IndexOptionsConflict — while that index
      // serializes active-name writes at least as strictly as the one being
      // requested (it covers deleted rows too). Treating that as "unsafe"
      // would skip the collection forever on the Atlas side, which never
      // runs the `syncIndexes()` pass that would replace it — and skipping
      // disables name reconciliation, so an unrelated same-name pair then
      // E11000s on every cycle.
      //
      // So ask what actually exists before giving up.
      if (await hasUniqueNameIndex(collection)) {
        // Adequately serialized after all; carry on.
      } else if (await replaceInadequateNameIndex(collection)) {
        // GH #1116: an INADEQUATE index — a legacy NON-unique
        // `name_1` — is a different case from a duplicate-data refusal, and
        // it is the one that cannot clear on its own.
        //
        // `createIndex` conflicts with it on every cycle and
        // `hasUniqueNameIndex` rejects it, so the collection is skipped
        // forever. On the LOCAL side `coreModelIndexes` would eventually
        // replace it, but the hybrid REMOTE never runs `dbConnect` at all —
        // so on Atlas this state is permanent. Combined with the paired-only
        // hold-back and its prerequisite cascade, an unpaired row would be
        // held and its dependents skipped indefinitely, with no user action
        // that could resolve it.
        //
        // So convert it: build the intended index under an explicit distinct
        // name FIRST (the earlier attempt only collided because both wanted
        // the auto-generated `name_1`), and drop the legacy one only once the
        // replacement exists. The collection is never left unprotected, and
        // if the data still forbids the build the create throws and we fall
        // through to the ordinary skip.
      } else {
      // Otherwise do NOT fall back to writing unserialized. That path is what
      // the index exists to prevent: two writers can each clear the check and
      // both normalize to the same name, ADDING duplicates on a database that
      // already has one. Leave the collection alone and say so; the caller
      // keeps the migration unsettled and retries.
      skipped.push({
        collection: collectionName,
        reason:
          err instanceof Error && /E11000|duplicate key/i.test(err.message)
            ? "the collection already has duplicate active names — resolve them and restart"
            : `could not create the unique name index: ${
                err instanceof Error ? err.message : String(err)
              }`,
      });
      continue;
      }
    }
    // Anchored on either edge, over the EXACT set `trim()` strips — see
    // JS_TRIM_CHARS. `hasEdgeWhitespace` still re-checks each candidate in
    // JS, so the query stays a pre-filter rather than the decision.
    const docs = await collection
      .find(
        { name: { $regex: EDGE_WHITESPACE_PATTERN } },
        { projection: { name: 1, _deletedAt: 1, _purged: 1 } },
      )
      .toArray();

    for (const doc of docs) {
      const decision = await classifyTrimCandidate(collection, collectionName, doc, isHidden);
      if (decision.kind === "skip") continue;
      if (decision.kind === "conflict") {
        conflicts.push(decision.conflict);
        continue;
      }
      const { next, active } = decision;
      try {
        // Conditional on the name we SCANNED. This runs on every
        // hybrid cycle while the app can still write to either database, so a
        // user rename landing between the read and this write must win —
        // filtering on `_id` alone would stamp the stale candidate's trimmed
        // value over their new name. Only a matched write counts as a trim.
        // name-lookup-ok: RAW DRIVER, so the filter is never cast — pinning the
        // scanned raw `name` here is the point (see the comment above).
        const res = await collection.updateOne(
          { _id: doc._id, name: doc.name },
          { $set: { name: next } },
        );
        if ((res as { matchedCount?: number }).matchedCount === 0) continue;
        trimmed++;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        conflicts.push({
          collection: collectionName,
          name: doc.name as string,
          active,
          id: String(doc._id),
          trimsTo: next,
          reason: "collision",
          collidesWith: null,
        });
        // A row OUTSIDE the partial index cannot collide under the index this
        // repo intends — deleted rows may freely share a name (GH #213 name
        // reuse). So a duplicate key here proves the collection is running
        // under the LEGACY plain unique `name_1`, which also covers deleted
        // rows. `coreModelIndexes` replaces that index later in this same
        // connect, after which the identical write succeeds.
        //
        // The question is INDEX COVERAGE, not schema activeness.
        //
        // `isActiveLikeSchema` treats `_deletedAt: ""` as active, because
        // Mongoose casts an empty string to null on a Date path. MongoDB does
        // NOT: a `partialFilterExpression: { _deletedAt: null }` matches null
        // and missing only, so a stored `""` is OUTSIDE the partial index. A
        // duplicate key on such a row therefore CANNOT have come from the
        // intended index — it is the transient legacy-plain-index case, and
        // recording it is exactly what keeps the migration unsettled until
        // `coreModelIndexes` replaces that index later in this same connect.
        //
        // So test `_deletedAt == null` (null or missing = covered), which is
        // MongoDB's own predicate. An untombstoned `_purged` zombie still
        // lands on the covered side: it is inactive for GATING purposes but
        // its `_deletedAt` is null, so it genuinely is in the partial index
        // and its collision is real rather than a legacy artifact.
        if (doc._deletedAt != null) {
          deferred.push({
            collection: collectionName,
            reason:
              `${JSON.stringify(doc.name)} collides only under the legacy ` +
              `plain unique name index; retrying after it is replaced`,
          });
        }
      }
    }
  }

  return { trimmed, conflicts, skipped, deferred };
}

/**
 * How many items keep the migration UNSETTLED, i.e. force another pass.
 *
 * Extracted so the decision is testable: it used to be an inline
 * expression inside `dbConnect`'s migration block, which no test could reach —
 * so the rule that `deferred` must block was unpinned, and an unpinned rule is
 * one refactor away from silently reverting.
 *
 * Three inputs, three different reasons:
 *   - `skipped`  — the collection was never touched (no protective index).
 *   - `conflicts.active` — a real duplicate a human can go and resolve.
 *   - `deferred` — blocked only by a legacy index this connect will replace.
 *
 * INACTIVE conflicts deliberately do NOT block: a whitespace-only or purged
 * name is untrimmable forever and invisible in the UI, so blocking on it would
 * keep the migration retrying (and, on the sync path, gate a collection) with
 * nothing anyone could do about it.
 */
export function trimBlockedCount(result: TrimEntityNamesResult): number {
  return (
    result.conflicts.filter((c) => c.active).length +
    (result.skipped?.length ?? 0) +
    (result.deferred?.length ?? 0)
  );
}

/** One log line summarizing a run, or null when there was nothing to say. */
export function describeTrimResult(result: TrimEntityNamesResult): string | null {
  if (
    result.trimmed === 0 &&
    result.conflicts.length === 0 &&
    (result.skipped?.length ?? 0) === 0
  ) {
    return null;
  }
  const parts: string[] = [];
  if (result.trimmed > 0) parts.push(`trimmed ${result.trimmed} entity name(s)`);
  if (result.conflicts.length > 0) {
    const named = result.conflicts
      .map((c) => `${c.collection}: ${JSON.stringify(c.name)}`)
      .join(", ");
    parts.push(
      `left ${result.conflicts.length} alone (trimming would collide with an existing row, or empty a required name) — ${named}`,
    );
  }
  for (const sk of result.skipped ?? []) {
    parts.push(`SKIPPED ${sk.collection} entirely — ${sk.reason}`);
  }
  return `[migration] GH #1116 name whitespace: ${parts.join("; ")}`;
}

/**
 * The value Mongoose's `String` SchemaType would store for `raw`, or null
 * when it wouldn't cast at all.
 *
 * Mongoose casts numbers, booleans and anything with a non-default
 * `toString`; it refuses plain objects and arrays. Null/undefined stay null —
 * the `required` validator handles those, and a missing name can't collide.
 */
export function castNameLikeSchema(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  // EVERY number, including the non-finite ones. `JSON.parse`
  // turns a valid JSON literal like `1e400` into `Infinity`, and Mongoose's
  // String cast is `value.toString()` — so it stores `"Infinity"`, which
  // collides with a `"Infinity "` sibling. A `Number.isFinite` gate skipped
  // exactly that pair and let the E11000 happen after the wipe.
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "boolean") return String(raw);
  // Transcribed from mongoose/lib/cast/string.js, in ITS order, because
  // paraphrasing it has now been wrong twice:
  //
  //   1. a value with a STRING `_id` casts to that `_id` — the populated-doc
  //      case, and reachable from JSON as plain `{"_id": "X"}`, so it hits
  //      the snapshot precheck as well as the Atlas path;
  //   2. otherwise anything with a non-default `toString` that is not an
  //      array — an ObjectId, a Date, a Buffer;
  //   3. otherwise the cast THROWS, which is what leaves the value for
  //      validation to reject rather than something this helper invents.
  //
  // Note clause 2 tests `Array.isArray`, not `toString !== Array.prototype
  // .toString`: an object carrying the array method is not an array, and
  // Mongoose accepts it. Mirroring the predicate rather than its effect is
  // the whole point.
  if (typeof raw === "object" && raw !== null) {
    const withId = raw as { _id?: unknown; toString?: unknown };
    if (typeof withId._id === "string") return withId._id;
    if (
      typeof withId.toString === "function" &&
      withId.toString !== Object.prototype.toString &&
      !Array.isArray(raw)
    ) {
      return String(raw);
    }
  }
  return null;
}

/**
 * Would the schema treat this `_deletedAt` as a live row?
 *
 * The name indexes are partial on `_deletedAt: null`, so "is this row active"
 * decides whether it participates in a collision — and the raw JSON value is
 * not the answer. Mongoose's Date path casts `null`, `undefined`
 * AND the empty string to `null`, so `{_deletedAt: ""}` inserts as an ACTIVE
 * row while a `!= null` test reads it as deleted. That mismatch is enough for
 * `{name: "X", _deletedAt: ""}` and `{name: "X "}` to slip past the precheck
 * and E11000 after the destructive wipe.
 *
 * Anything else is either a real date (deleted) or a value the Date cast
 * rejects outright — and a row that fails to cast never inserts, so the
 * per-document validation below refuses the whole restore anyway.
 */
export function isActiveLikeSchema(rawDeletedAt: unknown): boolean {
  return rawDeletedAt == null || rawDeletedAt === "";
}

/**
 * Is this snapshot row one the partial unique index will actually cover?
 *
 * Active-ness alone isn't the answer for FILAMENTS. The restore
 * path runs `normalizePurgedTombstone` before inserting, which stamps
 * `_deletedAt` on a `_purged` zombie — so a legacy snapshot holding an active
 * `"X"` beside a purged `"X "` is perfectly restorable, and rejecting it
 * would refuse a file the existing zombie repair handles correctly.
 *
 * `honorsPurged` is REQUIRED rather than defaulted, and that is the point.
 * The restore only re-tombstones filaments, printHistory
 * and sharedCatalogs; `_purged` is not in the Nozzle / Printer / BedType /
 * Location schemas at all, so strict mode STRIPS it and the row inserts
 * ACTIVE. Exempting those would suppress a real collision and hand the caller
 * the E11000-after-the-wipe this precheck exists to replace — the exact
 * failure, via the guard meant to prevent it. Of the unique-name collections
 * only `filaments` may pass true, so the caller has to say which it is.
 */
export function isIndexedRow(
  row: { _deletedAt?: unknown; _purged?: unknown },
  honorsPurged: boolean,
): boolean {
  // The `_deletedAt == null` half mirrors `normalizePurgedTombstone`'s OWN
  // condition, and it is load-bearing. That helper stamps
  // a tombstone only when `_deletedAt == null` — an EMPTY STRING isn't, so it
  // survives untouched (`restoreTypes` leaves it alone too, since "" doesn't
  // match the ISO date pattern) all the way to `insertMany`, where the Date
  // cast turns it into null and the row inserts ACTIVE. Exempting on
  // `_purged` alone would therefore wave through a pair that genuinely
  // collides. Exempt only what will actually be tombstoned.
  if (honorsPurged && row._purged === true && row._deletedAt == null) return false;
  return isActiveLikeSchema(row._deletedAt);
}

/**
 * A collision the trim setter would create on INSERT (GH #1116).
 *
 * A snapshot taken before the setter existed can legitimately contain both
 * `X` and `X `. Mongoose applies the setter on `insertMany`, so both land as
 * `X` and the ordered batch aborts on E11000 — after the destructive wipe,
 * which means the restore path leans on its rollback for what is really a
 * predictable, statable problem with the FILE. Detecting it up front turns
 * that into a clean 400 with the database untouched, the posture GH #1004
 * F2(b) established for schema-validation failures.
 *
 * Only ACTIVE rows are compared: every one of these `name` indexes is partial
 * on `_deletedAt: null`, so a trashed row is free to share a name (that is
 * the whole point of GH #213's name reuse).
 */
export function findTrimmedNameCollision(
  rows: readonly unknown[],
  /** True only for `filaments`, the one unique-name collection whose
   *  `_purged` rows the restore re-tombstones before inserting. */
  honorsPurged = false,
): { name: string; indexes: [number, number] } | null {
  const seen = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== "object" || row === null) continue;
    const record = row as { name?: unknown; _deletedAt?: unknown; _purged?: unknown };
    if (!isIndexedRow(record, honorsPurged)) continue;
    // Key by the value the SCHEMA will store, not the raw JSON.
    // Mongoose casts a `String` path, so a snapshot holding the number `1`
    // and the string `"1 "` passes per-document validation on both — and then
    // `insertMany` casts and trims them to the same `"1"` and raises E11000
    // AFTER the destructive wipe, which is exactly what this precheck exists
    // to prevent. `String(...)` mirrors the cast; `.trim()` mirrors the
    // setter. Anything with no cast (an object, an array) is left to the
    // per-document validation below, which rejects it with its own message.
    const cast = castNameLikeSchema(record.name);
    if (cast === null) continue;
    const key = cast.trim();
    if (key === "") continue; // caught by the `required` validator instead
    const first = seen.get(key);
    if (first !== undefined) return { name: key, indexes: [first, i] };
    seen.set(key, i);
  }
  return null;
}

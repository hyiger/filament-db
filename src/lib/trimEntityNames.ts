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
 * Spelled out because the MongoDB pre-filter has to select the SAME set
 * (Codex P2). Mongo's `\s` is PCRE's — ASCII-only in practice — so a name
 * ending in U+00A0 or U+3000 was never returned by the query, and the JS
 * re-check below never got the chance to repair it. Which is the worst
 * possible failure here: the schema setter WOULD trim that name on the
 * document's next save, so the two halves of the fix disagreed about what a
 * name is, and the row stayed a silent duplicate until something happened to
 * touch it.
 */
const JS_TRIM_CHARS =
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
}

export interface TrimEntityNamesResult {
  /** How many documents were rewritten. */
  trimmed: number;
  /** Rows left alone because trimming them would collide with an existing
   *  row, or would empty the required field. */
  conflicts: TrimNameConflict[];
}

interface MinimalCursor {
  toArray(): Promise<{ _id: unknown; name?: unknown; _deletedAt?: unknown }[]>;
}

interface MinimalCollection {
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

/** MongoDB's duplicate-key error, however the driver surfaces it. */
function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 11000 || code === 11001) return true;
  // Some wrapped/serialized errors lose `.code` but keep the text — the same
  // belt-and-braces `coreModelIndexes` already applies.
  return /E11000|duplicate key/i.test(String((err as { message?: unknown }).message ?? ""));
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

  for (const collectionName of TRIMMABLE_COLLECTIONS) {
    const collection = db.collection(collectionName);
    // Anchored on either edge, over the EXACT set `trim()` strips — see
    // JS_TRIM_CHARS. `hasEdgeWhitespace` still re-checks each candidate in
    // JS, so the query stays a pre-filter rather than the decision.
    const docs = await collection
      .find(
        { name: { $regex: EDGE_WHITESPACE_PATTERN } },
        { projection: { name: 1, _deletedAt: 1 } },
      )
      .toArray();

    for (const doc of docs) {
      if (typeof doc.name !== "string") continue;
      if (!hasEdgeWhitespace(doc.name)) continue;
      const next = doc.name.trim();
      if (next === "") {
        // `name` is `required`, so a whitespace-only name can't be trimmed
        // into a legal value. Report it rather than writing "" and making the
        // document fail validation on its owner's next save.
        conflicts.push({ collection: collectionName, name: doc.name });
        continue;
      }
      // Check the target name BEFORE writing, rather than relying on the
      // unique index to report the collision (Codex P1). On a database whose
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
      // name reuse). The E11000 catch below stays as the race guard for a
      // conflicting row created between this check and the write.
      if (doc._deletedAt == null) {
        const clash = await collection
          .find({ name: next, _deletedAt: null }, { projection: { _id: 1 } })
          .toArray();
        if (clash.some((c) => String(c._id) !== String(doc._id))) {
          conflicts.push({ collection: collectionName, name: doc.name });
          continue;
        }
      }
      try {
        // Conditional on the name we SCANNED (Codex P2). This runs on every
        // hybrid cycle while the app can still write to either database, so a
        // user rename landing between the read and this write must win —
        // filtering on `_id` alone would stamp the stale candidate's trimmed
        // value over their new name. Only a matched write counts as a trim.
        const res = await collection.updateOne(
          { _id: doc._id, name: doc.name },
          { $set: { name: next } },
        );
        if ((res as { matchedCount?: number }).matchedCount === 0) continue;
        trimmed++;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        conflicts.push({ collection: collectionName, name: doc.name });
      }
    }
  }

  return { trimmed, conflicts };
}

/** One log line summarizing a run, or null when there was nothing to say. */
export function describeTrimResult(result: TrimEntityNamesResult): string | null {
  if (result.trimmed === 0 && result.conflicts.length === 0) return null;
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
  return `[migration] GH #1116 name whitespace: ${parts.join("; ")}`;
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
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === "boolean") return String(raw);
  return null;
}

export function findTrimmedNameCollision(
  rows: readonly unknown[],
): { name: string; indexes: [number, number] } | null {
  const seen = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== "object" || row === null) continue;
    const record = row as { name?: unknown; _deletedAt?: unknown };
    if (record._deletedAt != null) continue;
    // Key by the value the SCHEMA will store, not the raw JSON (Codex P2).
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

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
 * ## Why driver-level
 *
 * Takes a minimal driver-shaped `db` rather than Mongoose models so the same
 * implementation can run from `dbConnect` and be unit-tested without a live
 * connection — the shape `legacyNozzleConditions` established. It also has to
 * be driver-level for correctness: a Mongoose `updateOne` would re-apply the
 * very setter whose absence created this state, which is harmless but makes
 * the write's intent unreadable, and the collision has to surface as a raw
 * E11000 rather than a cast/validation error.
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

/** A name with leading or trailing whitespace, in any of the forms JS's
 *  `String.prototype.trim` recognizes (which includes the Unicode space
 *  separators and the line terminators — `trim()` is what the schema setter
 *  uses, so the detector has to agree with it exactly or a row would be
 *  selected and then "trimmed" to itself forever). */
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
  toArray(): Promise<{ _id: unknown; name?: unknown }[]>;
}

interface MinimalCollection {
  find(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): MinimalCursor;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<unknown>;
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
    // Anchored on either edge. `\s` in a MongoDB regex is PCRE's, which is
    // narrower than JS `trim()`'s whitespace set — so `hasEdgeWhitespace`
    // re-checks each candidate in JS below, and the query stays a cheap
    // pre-filter rather than the decision.
    const docs = await collection
      .find({ name: { $regex: "^\\s|\\s$" } }, { projection: { name: 1 } })
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
      try {
        await collection.updateOne({ _id: doc._id }, { $set: { name: next } });
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
export function findTrimmedNameCollision(
  rows: readonly unknown[],
): { name: string; indexes: [number, number] } | null {
  const seen = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== "object" || row === null) continue;
    const record = row as { name?: unknown; _deletedAt?: unknown };
    if (record._deletedAt != null) continue;
    if (typeof record.name !== "string") continue;
    const key = record.name.trim();
    if (key === "") continue; // caught by the `required` validator instead
    const first = seen.get(key);
    if (first !== undefined) return { name: key, indexes: [first, i] };
    seen.set(key, i);
  }
  return null;
}

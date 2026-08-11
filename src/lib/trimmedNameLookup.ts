import { JS_TRIM_CHARS } from "@/lib/trimEntityNames";

/**
 * Find a stored entity by name when the stored side might NOT be trimmed yet
 * (GH #1116).
 *
 * ## Why any of this is needed
 *
 * `name` carries `trim: true` on all five uniquely-named models. A Mongoose
 * String setter applies to QUERY values, not just writes — so
 * `Model.findOne({ name: "X " })` casts to `{ name: "X" }` and can never select
 * a row whose STORED value is still the raw `"X "`. Trimming the input first
 * does not help either: the untrimmed side is the one in the database.
 *
 * `trimEntityNames` repairs stored rows, but it does not always get to finish.
 * It SKIPS a collection whose protective unique index cannot be established,
 * and it leaves individual rows alone when trimming them would collide or
 * would empty the required field. Either way a raw untrimmed row SURVIVES.
 *
 * Against a survivor, any "look up by name, create when missing" path misses,
 * creates, and succeeds — the two raw strings are distinct, so the unique index
 * has no objection — and the user is left with two rows that render
 * identically. That is precisely the duplicate #1116 exists to eliminate,
 * reproduced by the very code that was supposed to stop it.
 *
 * ## Why it is one shared helper
 *
 * This rule was applied to the CSV importer and to nothing else, and the two
 * call sites that needed it next were each found by review, one round apart.
 * A single exported filter means the next resolve-or-create path either uses it
 * or is visibly not using it.
 *
 * ## Why the `chars` argument is not optional
 *
 * `$trim` without `chars` strips MongoDB's ASCII-only default set, while every
 * other trim in this codebase is `String.prototype.trim` — which also removes
 * U+00A0, U+FEFF, U+3000 and the rest. Omitting it makes this query and the
 * schema setter disagree about what a name is, which is the same class of bug
 * one level down. `JS_TRIM_CHARS` is the single source of truth, shared with
 * `EDGE_WHITESPACE_PATTERN` so the migration's scan and this lookup cannot
 * drift apart.
 *
 * ## ALWAYS CANONICAL FIRST — this is correctness, not just cost
 *
 * Run the ordinary indexed name query first and reach for this only when it
 * MISSES. Two independent reasons, and the second is the one that bites:
 *
 *   1. `$expr` cannot use an index, so this is a collection scan. Keeping it
 *      on the miss path means the healthy case pays nothing.
 *
 *   2. The predicate matches the canonical row and the untrimmed one ALIKE,
 *      and imposes no ordering. In precisely the state that produces a
 *      survivor — `"PLA"` and `"PLA "` both present, which the partial unique
 *      index permits for tombstones and which a skipped migration permits for
 *      active rows — a survivor-first lookup returns an ARBITRARY one of them.
 *      The indexed query is deterministic and picks the canonical row; this
 *      one is not. Scanning first therefore turns a correct, predictable
 *      update into a coin flip over which of two rows gets written.
 *
 * That mistake has been made twice in this codebase (the OpenPrintTag bulk
 * upsert and the Prusament trashed resurrect), both times while ADDING this
 * fallback, so it is stated here rather than left to be rediscovered.
 */

/**
 * A raw-driver filter matching rows whose STORED `name` trims to any of
 * `names`.
 *
 * Compose it with the caller's own conditions (`_deletedAt: null`, and so on);
 * this deliberately says nothing about liveness, because the importers disagree
 * about what they want there — some resurrect a tombstone, some must not see
 * one at all.
 *
 * A non-string stored `name` is coerced to `""` rather than erroring: `$trim`
 * throws on a non-string input, and legacy data does hold them. Such a row
 * simply does not match (no caller passes `""`, which would be an empty name).
 */
export function trimmedNameFilter(names: string[]): Record<string, unknown> {
  return {
    $expr: {
      $in: [
        {
          $trim: {
            input: {
              $cond: [{ $eq: [{ $type: "$name" }, "string"] }, "$name", ""],
            },
            chars: JS_TRIM_CHARS,
          },
        },
        names.map((n) => n.trim()),
      ],
    },
  };
}

/** Minimal raw-driver shape, so callers can pass `Model.collection` and tests
 *  can pass a fake without standing up a connection. */
export interface MinimalNameCollection {
  findOne(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ _id: unknown; name?: unknown } | null>;
}

/**
 * The single-name fallback: the raw `_id` of a surviving untrimmed row whose
 * name trims to `name`, or null.
 *
 * Returns the RAW document rather than a Mongoose one on purpose — the caller
 * needs the `_id` to address the row (by `_id`, which casting cannot break),
 * and hydrating through Mongoose here would re-introduce the very lookup that
 * cannot see this row.
 */
export async function findByTrimmedName(
  collection: MinimalNameCollection,
  name: string,
  extraFilter: Record<string, unknown> = {},
): Promise<{ _id: unknown; name?: unknown } | null> {
  const trimmed = name.trim();
  if (trimmed === "") return null;
  return collection.findOne({ ...extraFilter, ...trimmedNameFilter([trimmed]) });
}

/**
 * Just the `_id` of a surviving untrimmed row, for the common shape:
 *
 * ```ts
 * let existing = await Filament.findOne({ name, _deletedAt: null }).lean();
 * if (!existing) {
 *   const id = await findSurvivorId(Filament.collection, name, { _deletedAt: null });
 *   if (id) existing = await Filament.findOne({ _id: id }).lean();
 * }
 * ```
 *
 * Returning the id rather than a document is deliberate: every caller re-reads
 * through its OWN query — with its own `.lean()`, projection or population —
 * so the fallback cannot quietly change the shape the caller expects. And an
 * `_id` re-read is safe where the name re-read was not, because casting can
 * mangle a name but never an ObjectId.
 */
export async function findSurvivorId(
  collection: MinimalNameCollection,
  name: string,
  extraFilter: Record<string, unknown> = {},
): Promise<unknown | null> {
  const row = await findByTrimmedName(collection, name, extraFilter);
  return row ? row._id : null;
}

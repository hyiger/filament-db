/**
 * Staging contended renames so a hybrid-sync copy can't deadlock on the
 * unique `name` index (GH #1142).
 *
 * ## The problem
 *
 * `syncCollection` decides each row's LWW outcome and writes it immediately,
 * with no awareness that the name it is about to write is currently held by a
 * DIFFERENT row that the same pass is about to move. Every entity collection
 * has a partial-unique index on `name`, so the write is rejected outright.
 *
 * Three distinct shapes, and only the first was reported:
 *
 *   - **Cycle** — local `A="X" B="Y"`, remote `A="Y" B="X"`. Whichever row is
 *     written first wants a name the other still holds. No ordering fixes it;
 *     reversing only changes which one fails.
 *   - **Chain** — `A` wants the name `B` is about to vacate. This one IS
 *     order-dependent, and the existing paired-before-unpaired ordering
 *     already resolves some of it, but not when the chain runs the other way.
 *   - **Unsatisfiable** — two rows genuinely want the same final name, and one
 *     of them is not moving. No amount of staging helps; it needs a human.
 *
 * The failure is permanent, not transient: it repeats every cycle, and via
 * `trySync`'s dependency chain a failure in `locations` cascade-skips
 * `filaments` and `printhistories`, so one swapped pair can stall most of sync
 * indefinitely.
 *
 * ## The approach
 *
 * Classic unique-value-swap staging. Before the copies, move every CONTENDED
 * holder to a placeholder name that cannot collide; run the copies, which
 * write the real names; then settle anything still holding a placeholder.
 *
 * This module is the decision half — pure, so the graph reasoning is testable
 * without two live databases. The caller does the I/O.
 *
 * ## Why the placeholder must be settled, not assumed
 *
 * A row is moved to a placeholder on the expectation that its own write lands
 * moments later. If that write does not happen — the copy threw, the process
 * died, the row was skipped — the row is left named `__sync-staging-…`, which
 * is visible in the UI and worse than the duplicate we were avoiding. The
 * caller MUST restore anything unsettled, which is why `planRenameStaging`
 * returns the original name alongside the placeholder.
 */

/** A row on the receiving peer, and the name this pass intends to give it. */
export interface RenameIntent {
  /** Opaque row identity — the caller's `_id`, stringified. */
  id: string;
  /** What the row is called on the target right now. */
  currentName: string;
  /**
   * What this pass will write. Equal to `currentName` for a row that is being
   * copied without a rename, which still matters: such a row HOLDS its name
   * and can therefore block someone else.
   */
  desiredName: string;
  /** False for a row that is present but not being written this pass. It can
   *  still block a name, and it can never be staged out of the way. */
  willWrite: boolean;
}

export interface StagedRename {
  id: string;
  /** The name to restore if this row's real write never lands. */
  originalName: string;
  placeholderName: string;
}

export interface UnsatisfiableRename {
  id: string;
  desiredName: string;
  /** The row that holds `desiredName` and is not going to give it up. */
  heldBy: string;
}

export interface RenameStagingPlan {
  /** Rows to move to a placeholder BEFORE any copy. */
  staged: StagedRename[];
  /** Rows whose desired name cannot be satisfied — report, do not write. */
  unsatisfiable: UnsatisfiableRename[];
}

/**
 * A placeholder that cannot collide with a real name or with another
 * placeholder.
 *
 * The prefix is deliberately conspicuous: if one is ever left behind by a
 * crash, it should be obvious in the UI what it is and where it came from,
 * rather than looking like a name the user typed.
 */
export const STAGING_PREFIX = "__sync-staging-";

export function placeholderFor(id: string, nonce: string): string {
  return `${STAGING_PREFIX}${nonce}-${id}`;
}

/** Is this a placeholder left over from a previous (crashed) pass? */
export function isStagingPlaceholder(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(STAGING_PREFIX);
}

/**
 * Decide which rows must be moved aside before the copies, and which desired
 * names cannot be satisfied at all.
 *
 * `nonce` makes the placeholders unique per pass so two concurrent syncers
 * cannot generate the same one.
 */
export function planRenameStaging(
  rows: readonly RenameIntent[],
  nonce: string,
): RenameStagingPlan {
  const staged: StagedRename[] = [];
  const unsatisfiable: UnsatisfiableRename[] = [];

  // Who currently holds each name on the target. A duplicate current name
  // shouldn't be possible under the unique index, but if the index is missing
  // the FIRST holder wins the slot — matching what the index would enforce.
  const holderByName = new Map<string, RenameIntent>();
  for (const row of rows) {
    if (!holderByName.has(row.currentName)) holderByName.set(row.currentName, row);
  }

  const stagedIds = new Set<string>();
  for (const row of rows) {
    if (!row.willWrite) continue;
    if (row.desiredName === row.currentName) continue;

    const holder = holderByName.get(row.desiredName);
    if (!holder || holder.id === row.id) continue;

    // The holder is moving too, so getting it out of the way unblocks this
    // write and the holder's own write will give it its real name.
    const holderIsMoving = holder.willWrite && holder.desiredName !== holder.currentName;
    if (holderIsMoving) {
      if (!stagedIds.has(holder.id)) {
        stagedIds.add(holder.id);
        staged.push({
          id: holder.id,
          originalName: holder.currentName,
          placeholderName: placeholderFor(holder.id, nonce),
        });
      }
      continue;
    }

    // The holder is staying put — or is being written WITHOUT a rename, which
    // means it is keeping this exact name. Two rows genuinely want one name;
    // staging cannot help and writing anyway would either E11000 or clobber.
    unsatisfiable.push({
      id: row.id,
      desiredName: row.desiredName,
      heldBy: holder.id,
    });
  }

  return { staged, unsatisfiable };
}

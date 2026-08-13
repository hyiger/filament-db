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

/** Is this a placeholder left over from a previous (crashed) pass?
 *
 * PREFIX match — deliberately loose, for call sites where a false positive is
 * CONSERVATIVE: refusing to transfer a placeholder-looking name, or treating
 * a row as possibly-staged. A site that takes DESTRUCTIVE action on the
 * strength of the name alone must use `isGeneratedPlaceholder` instead —
 * names are free-form strings, and a user may legitimately (if unwisely) name
 * a row `__sync-staging-custom`. */
export function isStagingPlaceholder(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(STAGING_PREFIX);
}

/**
 * Does this name match the COMPLETE generated placeholder grammar —
 * `__sync-staging-<8 hex nonce>-<24 hex ObjectId>` — not merely the prefix?
 * (GH #1153, Codex P2.)
 *
 * The sweep's grammar backstop ACTS on rows it recognizes: it rewrites the
 * name to the peer's, or fails the collection every cycle when it cannot.
 * Entity names are free-form, so a prefix match alone would let a user's own
 * `__sync-staging-custom` be silently renamed to its peer's value — data
 * loss by helpfulness. The full grammar (nonce from an ObjectId's tail hex,
 * id a full ObjectId hex) is not a shape anyone produces by accident.
 *
 * Deliberately NOT anchored to the row's own _id: a pre-#1142 LWW copy could
 * carry a placeholder to the other peer, where the embedded id is the SOURCE
 * row's — still a genuine artifact, still worth healing.
 */
const GENERATED_PLACEHOLDER_RE = new RegExp(
  `^${STAGING_PREFIX}[0-9a-f]{8}-[0-9a-f]{24}$`,
);
export function isGeneratedPlaceholder(name: unknown): boolean {
  return typeof name === "string" && GENERATED_PLACEHOLDER_RE.test(name);
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

  const byId = new Map(rows.map((r) => [r.id, r]));

  /**
   * Which rows can actually VACATE the name they hold?
   *
   * Not just "is it moving" — its own destination has to be reachable too.
   * Checking one level is insufficient (Codex P1): with A->B, B->C and C
   * standing still, a one-level check stages B for A, A takes B's name, and
   * then B cannot take C. Settlement cannot restore B either, because A now
   * owns its original name — B is stranded as `__sync-staging-…` permanently.
   *
   * Unsatisfiability propagates BACKWARDS along the chain, so this is a
   * fixpoint: start optimistic, then repeatedly knock out any row whose
   * destination is held by a row that cannot vacate, until nothing changes. A
   * pure cycle (A<->B) survives — each depends only on the other, and neither
   * is ever knocked out — which is exactly right, since staging one of them
   * frees the whole cycle.
   */
  const canVacate = new Set<string>();
  for (const row of rows) {
    if (row.willWrite && row.desiredName !== row.currentName) canVacate.add(row.id);
  }

  // A CONTESTED destination poisons every row that desires it (Codex P1).
  //
  // Two rows desiring the same name can only happen when the SOURCE holds
  // duplicate active names — a state the trim pass refuses to index and the
  // sync continues through paired-only. At most one of them can win the name;
  // the loser E11000s against the winner, whose write has by then LANDED, so
  // moving the winner aside can never be settled — its original name is the
  // contested one, which the loser's retry just took. Concretely: with target
  // A="X", B="Y", C="Z" and desires A→"Y", B→"X", C→"Y", staging resolved the
  // A↔B swap and then C collided with the now-final A; the cached plan still
  // authorized staging A, C took "Y", and settlement could not restore A —
  // stranded permanently.
  //
  // There is no principled winner to pick (write order is incidental), so
  // every contender is refused: removed from `canVacate` BEFORE the fixpoint,
  // which also cascades — a row whose destination is held by a contender
  // cannot rely on it vacating, and is knocked out by the ordinary rule.
  const desireCount = new Map<string, number>();
  for (const row of rows) {
    if (row.willWrite && row.desiredName !== row.currentName) {
      desireCount.set(row.desiredName, (desireCount.get(row.desiredName) ?? 0) + 1);
    }
  }
  for (const row of rows) {
    if (canVacate.has(row.id) && (desireCount.get(row.desiredName) ?? 0) > 1) {
      canVacate.delete(row.id);
    }
  }
  for (;;) {
    let changed = false;
    for (const id of [...canVacate]) {
      const row = byId.get(id)!;
      const holder = holderByName.get(row.desiredName);
      if (!holder || holder.id === row.id) continue; // destination is free
      if (!canVacate.has(holder.id)) {
        // The row occupying our destination will never leave it.
        canVacate.delete(id);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const stagedIds = new Set<string>();
  for (const row of rows) {
    if (!row.willWrite) continue;
    if (row.desiredName === row.currentName) continue;

    const holder = holderByName.get(row.desiredName);
    if (!holder || holder.id === row.id) continue;

    // Only move a holder aside when the whole chain behind it terminates.
    if (canVacate.has(holder.id) && canVacate.has(row.id)) {
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

    // Either the holder is staying put, or its own destination is blocked by
    // something that is. Staging cannot help; report and write nothing.
    unsatisfiable.push({
      id: row.id,
      desiredName: row.desiredName,
      heldBy: holder.id,
    });
  }

  return { staged, unsatisfiable };
}

/**
 * May the blocker be moved aside, given a FRESH read of its source row?
 *
 * Staging a blocker is a bet that its own pending write — later in this same
 * pass — will rename it away, vacating the name for good. The write's body is
 * hydrated from the source document AT WRITE TIME, so the only honest way to
 * predict it is to read that same document now (Codex P1, sixth pass — the
 * previous check compared the blocker's fresh name against its SNAPSHOT
 * desired name, and a source renamed after the snapshot made the two diverge:
 * staging was authorized for a rename that was no longer coming, and the
 * placeholder could never be settled).
 *
 * The table, and why each row refuses:
 *  - not a string: the source is gone or malformed — no rename is provably
 *    coming, and hydration at write time will skip the copy entirely;
 *  - equal to the blocker's current name: nothing will move the blocker off
 *    this name. This one clause covers three distinct histories at once — the
 *    write already LANDED (it transferred exactly this name), the write is a
 *    no-op rename, and the source was REVERTED to match after the snapshot;
 *  - a staging placeholder: the source row is itself moved aside on its own
 *    side, and the pending write would transfer the placeholder text verbatim
 *    onto this peer — the propagation this module exists to prevent.
 *
 * A residual race remains by construction: the source can change between this
 * read and the blocker's write, and without transactions that window cannot
 * be zero. It shrinks from pass-length to the gap between two adjacent
 * writes, and settlement now names anything that still slips through.
 */
export function pendingRenameCanFreeName(
  freshSourceName: unknown,
  blockerCurrentName: string,
): boolean {
  if (typeof freshSourceName !== "string") return false;
  if (isStagingPlaceholder(freshSourceName)) return false;
  return freshSourceName !== blockerCurrentName;
}

/**
 * Where should a swept placeholder row be restored to? (GH #1153)
 *
 * The sweep meets a row named `__sync-staging-…` on a LATER cycle, when the
 * pass that staged it — and the in-memory record of its original name — is
 * gone. Two sources can answer, in strict preference order:
 *
 *  1. the DURABLE QUEUE entry written before the row was staged — authoritative,
 *     it IS the original name;
 *  2. the syncId-paired PEER row's current name — the staging invariant is that
 *     a staged row's own write (carrying the peer's name) was expected moments
 *     later, so the peer's name is what that write would have delivered. Only
 *     trusted when it is a real, non-placeholder string that actually differs
 *     from what the row holds now: a placeholder peer means BOTH sides are
 *     stranded (adopting it would copy the disease, not the cure), and a
 *     non-string peer answers nothing.
 *
 * Returns null when neither source answers — the caller reports and leaves the
 * row alone, because inventing a name is a product decision this machinery is
 * not allowed to make. Free-ness on the target side is the CALLER's check: it
 * is a live index question, not a naming one.
 */
export function placeholderRestoreTarget(
  currentName: unknown,
  queuedOriginalName: string | null,
  peerName: unknown,
): string | null {
  if (!isStagingPlaceholder(currentName)) return null; // nothing to restore
  if (queuedOriginalName !== null && queuedOriginalName !== "") return queuedOriginalName;
  if (
    typeof peerName === "string" &&
    peerName !== "" &&
    !isStagingPlaceholder(peerName) &&
    peerName !== currentName
  ) {
    return peerName;
  }
  return null;
}

/** Facts about a row left holding a staging placeholder. */
export interface StrandedPlaceholder {
  collection: string;
  id: string;
  originalName: string;
  placeholderName: string;
}

/**
 * The lead-in that joins a stranding notice to the failure that caused it.
 *
 * Shared so the composer and any consumer that re-attaches the notice after
 * normalising an error agree on the wording.
 */
export const CAUSE_LEAD = "The failure was: ";

/**
 * The CAUSE-FREE sentence describing a stranded row.
 *
 * Cause-free is the load-bearing property, not a style choice. `wrapSyncErrorMessage`
 * decides whether an error is the read-only-Atlas shape by testing a REGEX over
 * the message, and it REPLACES the whole string when it matches. Interpolating a
 * cause into the same string is therefore how the stranding disappears — first
 * because an auth-shaped cause makes the composed message match, and second
 * because the notice quotes user-typed entity names, so a row could be named
 * into matching it. Keeping the notice free of the cause means the notice can be
 * re-attached AFTER any such decision, and can never be the thing that trips it.
 *
 * An earlier version relied on ORDER — stranding first, cause second — which
 * achieves nothing: the wrapper returns a fresh string and never reads the
 * original at all.
 */
export function strandedPlaceholderNotice(info: StrandedPlaceholder): string {
  return (
    `${info.collection} ${info.id} was moved aside to free the name ` +
    `${JSON.stringify(info.originalName)} and could not be restored — it still holds the ` +
    `temporary name ${JSON.stringify(info.placeholderName)}. Rename it back manually.`
  );
}

/** Where the notice is stashed on a thrown error, for consumers to recover. */
const STRANDING_KEY = "strandingNotice";

/**
 * Attach a stranding notice to an error on its way up.
 *
 * ONE factory rather than "compose a message, then tag it" because those are
 * two steps a later edit can desynchronise, and the resulting failure is silent
 * and identical to the bug this exists to fix. Composing and tagging in the
 * same expression makes an untagged stranding message unrepresentable.
 *
 * The original error rides as `cause`, which matters beyond provenance: it is
 * where a driver error's `code` lives, and `new Error(msg, {cause})` does NOT
 * inherit it — so a consumer that classifies errors by code has to look through
 * `cause`, and can only do that if the cause is attached.
 *
 * Notices ACCUMULATE. One pass can move several rows aside, and a failure late
 * in that pass strands all of them at once; reporting only the last would be a
 * quieter version of reporting none.
 *
 * A duck-typed string property, not a subclass: `instanceof` fails silently if
 * the module is ever loaded twice, and a silent drop is exactly the failure mode
 * being designed out.
 */
export function withStrandingNotice(cause: unknown, notice: string): Error {
  const existing = strandingNoticeOf(cause);
  const combined = existing ? `${existing} ${notice}` : notice;
  const causeText = cause instanceof Error ? cause.message : String(cause);
  const err = new Error(`${combined} ${CAUSE_LEAD}${causeText}`, { cause });
  return Object.assign(err, { [STRANDING_KEY]: combined });
}

/**
 * Recover the cause-free stranding notice from an error, or null.
 *
 * Total by design — it is called from a generic catch that has no idea what
 * threw.
 */
export function strandingNoticeOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const value = (err as Record<string, unknown>)[STRANDING_KEY];
  return typeof value === "string" ? value : null;
}

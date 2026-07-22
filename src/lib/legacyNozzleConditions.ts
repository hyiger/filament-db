/**
 * GH #1021 (#1022) — one-shot, per-DATABASE cleanup of the machine-derived
 * `nozzle_diameter[0]==D [or ...]` compatibility conditions the pre-#1021
 * export wrote into `settings.compatible_printers_condition` (and round-trips
 * persisted). After the cleanup, any nozzle-only condition in a settings bag
 * is user-authored by construction, so the export passes every pin through
 * untouched — an export-time purge cannot distinguish the two.
 *
 * Design constraints this shape answers (each a Codex P1 round on #1022):
 *  - PROVENANCE, not syntax: a pure nozzle condition may be a pre-upgrade
 *    USER-authored pin (the old export preserved any non-empty bag value), so
 *    shape alone must not condemn it. A row is cleared only when its stored
 *    value EXACTLY equals what the removed derivation would have produced
 *    from the row's effective compatibleNozzles (own list, else the parent's
 *    — mirroring resolveFilament, which is what the exporter resolved
 *    through). `compatibleNozzles` holds ObjectId REFS to the nozzles
 *    collection (src/models/Filament.ts) and the removed exporter read
 *    diameters off POPULATED docs — so this helper joins the `nozzles`
 *    collection and maps refs to diameters the same way (a dangling ref
 *    contributes nothing, exactly like populate yielding null). Residue
 *    accepted, in both directions: a user pin that is byte-identical to the
 *    current tick derivation is indistinguishable and is cleared; a machine
 *    value whose ticks were edited AFTER the round-trip no longer matches and
 *    survives — visible in the settings bag and clearable by hand, strictly
 *    better than silently deleting a pin.
 *  - TOCTOU-safe clears: claim serialization only excludes other cleanup
 *    runners, not ordinary filament writers (an Atlas DB shared by several
 *    clients keeps serving them). Each destructive write is therefore a
 *    PER-ROW CONDITIONAL update — filtered on the exact condition value the
 *    scan observed — so a row edited between scan and write is left alone
 *    (its new value is post-cleanup-era user input by definition).
 *  - NOT safe to re-run: a pin authored after the cleanup can be textually
 *    identical to a legacy value, so completion must be durable per DB — a
 *    marker document in `_migrations` — not a process-local flag.
 *  - CLAIM-FIRST + WAIT: the marker is inserted (unique `_id`) BEFORE the
 *    destructive update, so racing processes serialize on the insert; a loser
 *    does not proceed while the winner is mid-clear (its writes could be
 *    accepted and then erased by the in-flight update) — it POLLS the claim
 *    until the winner completes (→ done), the claim is released (→ takes its
 *    own attempt), or `waitMs` expires (→ throws, so the caller keeps its
 *    retry state and nothing downstream treats the DB as clean). A claim
 *    older than `staleMs` is a crashed claimer: skip permanently rather than
 *    take over — the remaining legacy values are the known, recoverable
 *    pre-fix state, while a re-run could eat a post-upgrade pin.
 *  - PREREQUISITE for callers: a throw from this helper means the DB is not
 *    in a terminal cleanup state. `dbConnect` RETHROWS it (failing the
 *    current request rather than serving against a mid-clear DB) and
 *    `electron/sync-service.ts` aborts the sync cycle.
 *  - HYBRID: the Electron sync engine opens Atlas directly (no dbConnect),
 *    and the cleanup preserves `updatedAt`, so LWW would never propagate it —
 *    each side must clean its own DB. This helper is driver-level (takes a
 *    bare `Db`) precisely so `dbConnect` AND `electron/sync-service.ts` (which
 *    runs it on BOTH the local and remote DBs before any collection sync)
 *    share one implementation.
 */

/** The exact machine grammar the pre-#1021 export produced — one or more
 * `nozzle_diameter[0]==<number>` terms joined by ` or `, nothing else. Used
 * only to select CANDIDATES cheaply; provenance decides (see below). */
export const LEGACY_NOZZLE_CONDITION_RE =
  /^nozzle_diameter\[0\]==\d+(\.\d+)?( or nozzle_diameter\[0\]==\d+(\.\d+)?)*$/;

const MARKER_ID = "legacyNozzleConditions";

/**
 * FROZEN copy of the derivation `filamentToSlicerKeys` performed before
 * #1021/#1022 removed it (unique positive diameters, ascending, default JS
 * number stringification, " or " join). Byte-identical output is the
 * provenance test: stored === derived ⇒ the value is machine-written. The
 * input is the POPULATED shape the exporter saw — objects carrying a numeric
 * `diameter` — with anything else (populate-miss nulls, junk) contributing
 * nothing. Do NOT "improve" the formatting — it must keep reproducing the
 * historical bytes.
 */
export function deriveLegacyNozzleCondition(compatibleNozzles: unknown): string | null {
  if (!Array.isArray(compatibleNozzles)) return null;
  const diameters = Array.from(
    new Set(
      compatibleNozzles
        .map((n: unknown) =>
          n != null &&
          typeof n === "object" &&
          typeof (n as { diameter?: unknown }).diameter === "number"
            ? (n as { diameter: number }).diameter
            : null,
        )
        .filter((d): d is number => typeof d === "number" && d > 0),
    ),
  ).sort((a, b) => a - b);
  if (diameters.length === 0) return null;
  return diameters.map((d) => `nozzle_diameter[0]==${d}`).join(" or ");
}

/** Minimal driver surface (mongodb Db / collection) so the helper works with
 * both mongoose's `connection.db` and the sync service's raw MongoClient. */
export interface MinimalDb {
  collection(name: string): {
    findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    find(
      filter: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): { toArray(): Promise<Record<string, unknown>[]> };
    insertOne(doc: Record<string, unknown>): Promise<unknown>;
    updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<{ modifiedCount: number }>;
    deleteOne(filter: Record<string, unknown>): Promise<unknown>;
  };
}

/** Thrown when another process holds a LIVE claim past `waitMs`. Callers must
 * treat it as transient (retry later) and must NOT mark the DB clean. */
export class LegacyCleanupInProgressError extends Error {
  constructor() {
    super(
      "legacyNozzleConditions cleanup is in progress in another process; timed out waiting for it to complete",
    );
    this.name = "LegacyCleanupInProgressError";
  }
}

// Private twin of mongodb.ts's isDuplicateKeyError — importing it would cycle
// (mongodb.ts imports this module) and pull mongoose into the Electron sync
// bundle; this helper must stay bare-driver.
function isDuplicateKey(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === 11000) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /E11000|duplicate key/i.test(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type LegacyNozzleCleanupResult =
  | { ran: true; cleared: number }
  | { ran: false; reason: "already-done" | "claimed-elsewhere" };

export interface LegacyNozzleCleanupOptions {
  /** How long to wait for another process's live claim before throwing
   * LegacyCleanupInProgressError. The clear itself is a handful of small
   * queries — real completions land in well under a second. */
  waitMs?: number;
  /** Poll interval while waiting on a live claim. */
  pollMs?: number;
  /** Claims older than this are treated as a crashed claimer (skip forever).
   * Generous so ordinary clock skew between writers can't misclassify a live
   * claim as stale. */
  staleMs?: number;
}

/**
 * Run the one-shot cleanup against `db` exactly once per database.
 * Throws on transient failures (after releasing the claim) and on a live-claim
 * wait timeout, so callers can retry later; returns how it resolved otherwise.
 */
export async function clearLegacyNozzleConditionsOnce(
  db: MinimalDb,
  options: LegacyNozzleCleanupOptions = {},
): Promise<LegacyNozzleCleanupResult> {
  const { waitMs = 15_000, pollMs = 250, staleMs = 10 * 60_000 } = options;
  const markers = db.collection("_migrations");
  const deadline = Date.now() + waitMs;

  // Observe-or-claim loop: ends by returning (done / stale skip), throwing
  // (live-claim timeout), or breaking out with the claim held.
  for (;;) {
    const existing = await markers.findOne({ _id: MARKER_ID });
    if (existing) {
      if (existing.completed === true) return { ran: false, reason: "already-done" };
      const claimedAt =
        existing.claimedAt instanceof Date ? existing.claimedAt.getTime() : NaN;
      // Malformed claim (no readable claimedAt): can't age it — treat as the
      // crashed-claimer state and skip rather than risk a concurrent re-run.
      if (!Number.isFinite(claimedAt) || Date.now() - claimedAt > staleMs) {
        return { ran: false, reason: "claimed-elsewhere" };
      }
      if (Date.now() >= deadline) throw new LegacyCleanupInProgressError();
      await sleep(pollMs);
      continue; // re-observe: winner completed, released, or still clearing
    }
    try {
      await markers.insertOne({ _id: MARKER_ID, claimedAt: new Date() });
      break; // claim held — we are the (sole) runner
    } catch (err) {
      if (isDuplicateKey(err)) continue; // lost the race — loop back and wait on the winner
      throw err;
    }
  }

  let cleared = 0;
  try {
    const filaments = db.collection("filaments");
    // Cheap syntactic candidate scan, then the PROVENANCE test: clear only
    // rows whose stored value byte-equals the legacy derivation from their
    // effective compatibleNozzles (own non-empty list, else the parent's —
    // the same resolution the old exporter saw).
    const candidates = await filaments
      .find(
        { "settings.compatible_printers_condition": { $regex: LEGACY_NOZZLE_CONDITION_RE } },
        { projection: { _id: 1, parentId: 1, compatibleNozzles: 1, "settings.compatible_printers_condition": 1 } },
      )
      .toArray();

    const hasOwn = (c: Record<string, unknown>) =>
      Array.isArray(c.compatibleNozzles) && c.compatibleNozzles.length > 0;
    const parentIds = candidates
      .filter((c) => !hasOwn(c) && c.parentId != null)
      .map((c) => c.parentId);
    const parents = parentIds.length
      ? await filaments
          .find({ _id: { $in: parentIds } }, { projection: { _id: 1, compatibleNozzles: 1 } })
          .toArray()
      : [];
    const parentNozzles = new Map(parents.map((p) => [String(p._id), p.compatibleNozzles]));

    const effectiveRefsOf = (c: Record<string, unknown>): unknown[] => {
      const effective = hasOwn(c)
        ? c.compatibleNozzles
        : c.parentId != null
          ? parentNozzles.get(String(c.parentId))
          : undefined;
      return Array.isArray(effective) ? effective : [];
    };

    // `compatibleNozzles` entries are ObjectId REFS — the exporter populated
    // them before reading `.diameter` (Codex P1 r7). Reproduce that with one
    // indexed join against the nozzles collection (raw BSON values in $in,
    // string-keyed dedupe); a ref that resolves to nothing contributes
    // nothing, exactly like populate yielding null.
    const refByKey = new Map<string, unknown>();
    for (const c of candidates) {
      for (const ref of effectiveRefsOf(c)) refByKey.set(String(ref), ref);
    }
    const nozzleDocs = refByKey.size
      ? await db
          .collection("nozzles")
          .find(
            { _id: { $in: Array.from(refByKey.values()) } },
            { projection: { _id: 1, diameter: 1 } },
          )
          .toArray()
      : [];
    const nozzleById = new Map(nozzleDocs.map((n) => [String(n._id), n]));

    const toClear = candidates
      .map((c) => {
        const populated = effectiveRefsOf(c)
          .map((ref) => nozzleById.get(String(ref)))
          .filter((n): n is Record<string, unknown> => n !== undefined);
        const derived = deriveLegacyNozzleCondition(populated);
        const stored = (c.settings as { compatible_printers_condition?: unknown } | undefined)
          ?.compatible_printers_condition;
        return derived !== null && stored === derived
          ? { _id: c._id, observed: stored as string }
          : null;
      })
      .filter((entry): entry is { _id: unknown; observed: string } => entry !== null);

    // Per-row CONDITIONAL clears: the filter re-asserts the exact value the
    // scan observed, so a filament edited by another client between scan and
    // write (claiming only serializes cleanup runners, not ordinary writers)
    // keeps its new value — modifiedCount 0, nothing erased.
    for (const entry of toClear) {
      const res = await filaments.updateOne(
        { _id: entry._id, "settings.compatible_printers_condition": entry.observed },
        { $set: { "settings.compatible_printers_condition": "" } },
      );
      cleared += res.modifiedCount;
    }
  } catch (err) {
    // Release the claim (best-effort) so the next attempt can retry; if this
    // delete also fails the claim stays held — waiters throw until it goes
    // stale, then skip (recoverable by deleting the marker by hand).
    await markers.deleteOne({ _id: MARKER_ID }).catch(() => {});
    throw err;
  }

  await markers.updateOne({ _id: MARKER_ID }, { $set: { completed: true, completedAt: new Date() } });
  return { ran: true, cleared };
}

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
 *  - INGESTION-GUARD companion (Codex P1 r10): cleaning the DB once is not
 *    enough — a pre-upgrade fork's sync-back or a pre-upgrade INI re-import
 *    keeps re-sending the stamped machine condition afterwards, and with the
 *    one-shot spent it would re-persist and resurrect the hidden-preset bug.
 *    The slicer write boundaries (per-id PrusaSlicer/OrcaSlicer sync, bulk
 *    INI import) therefore strip a provenance-matching INCOMING value via
 *    src/lib/stripLegacyNozzleCondition.ts, built on the same
 *    isLegacyMachineNozzleCondition predicate exported below.
 *  - TOCTOU-safe clears: claim serialization only excludes other cleanup
 *    runners, not ordinary filament writers (an Atlas DB shared by several
 *    clients keeps serving them). Each destructive write is therefore a
 *    PER-ROW CONDITIONAL update — filtered on the exact condition value AND
 *    the exact `updatedAt` the scan observed — so a row saved between scan
 *    and write is left alone even when the user deliberately re-pinned the
 *    byte-identical expression (the save bumped `updatedAt`, the filter
 *    misses, nothing is erased).
 *  - NOT safe to re-run blindly: a pin authored after a row was cleared (or
 *    merely examined) can be textually identical to the legacy value, so
 *    neither completion NOR per-attempt progress may live in a process-local
 *    flag. The `_migrations` marker durably records BOTH: `completed` for the
 *    whole DB, and `processed` — an OBSERVATION ({id, condition, updatedAt})
 *    for EVERY syntactic candidate an attempt examined, matches and
 *    non-matches alike, written BEFORE any destructive write. On resume a
 *    recorded row is eligible again ONLY when it is byte-identical to its
 *    recorded observation (untouched since the examination); anything saved
 *    in between — a re-pin, a tick edit — bumps `updatedAt`, mismatches, and
 *    is permanently skipped. So a retry can finish interrupted work on
 *    untouched rows but can never re-judge a row the user has touched since
 *    it was first examined — which is what makes releasing a failed attempt
 *    safe at all.
 *  - CLAIM-FIRST + WAIT + RESUME + FENCE: the marker is inserted (unique
 *    `_id`) BEFORE any destructive write, so racing processes serialize on
 *    the insert; a loser does not proceed while the winner is mid-clear (its
 *    writes could be accepted and then erased by the in-flight update) — it
 *    POLLS until the winner completes (→ done) or `waitMs` expires
 *    (→ throws, so the caller keeps its retry state and nothing downstream
 *    treats the DB as clean). A claim marked `released` (failed attempt) or
 *    older than `staleMs` (crashed claimer) is taken over via a CAS on the
 *    observed `claimedAt` — safe precisely because the resume honors the
 *    recorded per-row progress. Every acquisition mints a unique
 *    `claimToken`, and every subsequent marker write (per-row record,
 *    rollback, release, completion) filters on it — so a legitimately
 *    long-running holder that gets taken over past `staleMs` is FENCED OUT
 *    at its next record write (before the row's destructive clear) and
 *    aborts with the in-progress error instead of double-running, marking
 *    the new holder's claim released, or completing over it.
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

import { randomUUID } from "crypto";

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

/**
 * GH #1021 (Codex P1 r10): the provenance test as a reusable predicate — true
 * when `value` is exactly the machine grammar AND byte-equals the legacy
 * derivation from `populatedNozzles` (docs carrying numeric `diameter`).
 * Used by the one-shot DB cleanup above and by the INGESTION guard
 * (src/lib/stripLegacyNozzleCondition.ts): pre-upgrade forks/INIs keep
 * re-sending the stamped machine condition long after the cleanup completed,
 * so the sync/import write paths must strip it at the boundary or the
 * hidden-preset bug resurrects on the first sync-back.
 */
export function isLegacyMachineNozzleCondition(
  value: unknown,
  populatedNozzles: unknown,
): boolean {
  return (
    typeof value === "string" &&
    LEGACY_NOZZLE_CONDITION_RE.test(value) &&
    value === deriveLegacyNozzleCondition(populatedNozzles)
  );
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
    ): Promise<{ modifiedCount: number; matchedCount: number }>;
  };
}

/** Thrown when another process holds a LIVE claim past `waitMs`, or when this
 * runner discovers its claim was taken over (fenced out mid-run). Callers
 * must treat it as transient (retry later) and must NOT mark the DB clean. */
export class LegacyCleanupInProgressError extends Error {
  constructor() {
    super(
      "the legacyNozzleConditions cleanup claim is held by another process (still running, or it took this one over); retry later",
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
  | { ran: false; reason: "already-done" };

export interface LegacyNozzleCleanupOptions {
  /** How long to wait for another process's live claim before throwing
   * LegacyCleanupInProgressError. The clear itself is a handful of small
   * queries — real completions land in well under a second. */
  waitMs?: number;
  /** Poll interval while waiting on a live claim. */
  pollMs?: number;
  /** Live-shaped claims older than this are treated as a crashed claimer and
   * taken over (with progress honored). Generous so ordinary clock skew
   * between writers can't misclassify a live claim as stale. */
  staleMs?: number;
}

/**
 * Run the one-shot cleanup against `db` to completion at most once per
 * database, resuming (never repeating) prior partial attempts. Throws on
 * transient failures (after durably marking the claim released, progress
 * kept) and on a live-claim wait timeout, so callers can retry later; returns
 * how it resolved otherwise.
 */
export async function clearLegacyNozzleConditionsOnce(
  db: MinimalDb,
  options: LegacyNozzleCleanupOptions = {},
): Promise<LegacyNozzleCleanupResult> {
  const { waitMs = 15_000, pollMs = 250, staleMs = 10 * 60_000 } = options;
  const markers = db.collection("_migrations");
  const deadline = Date.now() + waitMs;
  // Fencing token: minted per acquisition; every later marker write filters
  // on it, so a runner whose claim was taken over aborts instead of writing.
  const token = randomUUID();

  // Observe-or-claim loop: ends by returning (done), throwing (live-claim
  // timeout), or breaking out with the claim held (fresh or resumed).
  for (;;) {
    const existing = await markers.findOne({ _id: MARKER_ID });
    if (!existing) {
      try {
        await markers.insertOne({
          _id: MARKER_ID,
          claimedAt: new Date(),
          claimToken: token,
          processed: [],
        });
        break; // fresh claim held — we are the (sole) runner
      } catch (err) {
        if (isDuplicateKey(err)) continue; // lost the race — re-observe the winner
        throw err;
      }
    }
    if (existing.completed === true) return { ran: false, reason: "already-done" };
    const claimedAtRaw = existing.claimedAt;
    const claimedAtMs = claimedAtRaw instanceof Date ? claimedAtRaw.getTime() : NaN;
    const abandoned =
      existing.released === true || // failed attempt, progress preserved
      !Number.isFinite(claimedAtMs) || // malformed claim — can't age it
      Date.now() - claimedAtMs > staleMs; // crashed claimer
    if (abandoned) {
      // CAS on the observed claimedAt serializes takeover racers; safe to
      // resume because the work phase honors the recorded observations, and
      // the fresh claimToken fences out the previous holder if still alive.
      const takeover = await markers.updateOne(
        { _id: MARKER_ID, claimedAt: claimedAtRaw ?? null, completed: { $ne: true } },
        { $set: { claimedAt: new Date(), claimToken: token }, $unset: { released: "" } },
      );
      if (takeover.modifiedCount === 1) break; // resumed claim held
      continue; // lost the CAS — re-observe
    }
    if (Date.now() >= deadline) throw new LegacyCleanupInProgressError();
    await sleep(pollMs);
  }

  let cleared = 0;
  try {
    // Fresh read for the durable per-attempt observations (empty on a fresh
    // claim). Each entry is {i: id, c: condition, u: updatedAt, d: the
    // derivation at examination time} for a syntactic candidate a prior
    // attempt EXAMINED — match or not.
    const marker = await markers.findOne({ _id: MARKER_ID });
    const processed = new Map<string, { c: unknown; u: unknown; d: unknown }>();
    for (const entry of Array.isArray(marker?.processed) ? (marker!.processed as unknown[]) : []) {
      if (entry && typeof entry === "object" && typeof (entry as { i?: unknown }).i === "string") {
        const e = entry as { i: string; c?: unknown; u?: unknown; d?: unknown };
        processed.set(e.i, { c: e.c, u: e.u ?? null, d: e.d ?? null });
      }
    }
    const timeOf = (v: unknown) => (v instanceof Date ? v.getTime() : v ?? null);
    const observationOf = (c: Record<string, unknown>) => ({
      c: (c.settings as { compatible_printers_condition?: unknown } | undefined)
        ?.compatible_printers_condition,
      u: c.updatedAt ?? null,
    });

    const filaments = db.collection("filaments");
    // Cheap syntactic candidate scan, then the PROVENANCE test: clear only
    // rows whose stored value byte-equals the legacy derivation from their
    // effective compatibleNozzles (own non-empty list, else the ACTIVE
    // parent's — the same resolution the old exporter saw; a soft-deleted
    // parent is unresolvable at export, so its ticks derive nothing, Codex P2
    // r15). A row RECORDED by a prior attempt stays eligible only while its
    // CHILD state is byte-identical to the recorded observation AND its
    // current derivation equals the recorded one (`d`) — a parent tick edit
    // between attempts changes the derivation without touching the child, and
    // must skip the row rather than re-judge it (Codex P1 r11 / P2 r15).
    const scanned = await filaments
      .find(
        { "settings.compatible_printers_condition": { $regex: LEGACY_NOZZLE_CONDITION_RE } },
        { projection: { _id: 1, parentId: 1, compatibleNozzles: 1, updatedAt: 1, "settings.compatible_printers_condition": 1 } },
      )
      .toArray();
    const fresh: Record<string, unknown>[] = []; // never examined by any attempt
    const resumable: Record<string, unknown>[] = []; // recorded + child untouched
    for (const c of scanned) {
      const rec = processed.get(String(c._id));
      if (!rec) fresh.push(c);
      else {
        const now = observationOf(c);
        if (rec.c === now.c && timeOf(rec.u) === timeOf(now.u)) resumable.push(c);
        // else: touched since examination — skipped forever
      }
    }
    const candidates = [...fresh, ...resumable];

    const hasOwn = (c: Record<string, unknown>) =>
      Array.isArray(c.compatibleNozzles) && c.compatibleNozzles.length > 0;
    const parentIds = candidates
      .filter((c) => !hasOwn(c) && c.parentId != null)
      .map((c) => c.parentId);
    const parents = parentIds.length
      ? await filaments
          .find(
            { _id: { $in: parentIds }, _deletedAt: null },
            { projection: { _id: 1, compatibleNozzles: 1 } },
          )
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
    const nozzles = db.collection("nozzles");
    const nozzleDocs = refByKey.size
      ? await nozzles
          .find(
            { _id: { $in: Array.from(refByKey.values()) } },
            { projection: { _id: 1, diameter: 1 } },
          )
          .toArray()
      : [];
    const nozzleById = new Map(nozzleDocs.map((n) => [String(n._id), n]));

    const deriveFor = (c: Record<string, unknown>): string | null =>
      deriveLegacyNozzleCondition(
        effectiveRefsOf(c)
          .map((ref) => nozzleById.get(String(ref)))
          .filter((n): n is Record<string, unknown> => n !== undefined),
      );
    const storedOf = (c: Record<string, unknown>): unknown =>
      (c.settings as { compatible_printers_condition?: unknown } | undefined)
        ?.compatible_printers_condition;

    interface ClearEntry {
      _id: unknown;
      observed: string;
      observedUpdatedAt: unknown;
      /** Set when provenance came through the parent — the pre-clear
       * revalidation re-reads THIS parent (Codex P2 r15). */
      viaParent: unknown;
    }
    const toClear: ClearEntry[] = [];
    for (const c of fresh) {
      const derived = deriveFor(c);
      const stored = storedOf(c);
      if (derived !== null && stored === derived) {
        toClear.push({
          _id: c._id,
          observed: stored as string,
          observedUpdatedAt: c.updatedAt,
          viaParent: hasOwn(c) ? null : c.parentId,
        });
      }
    }
    for (const c of resumable) {
      const derived = deriveFor(c);
      const stored = storedOf(c);
      const rec = processed.get(String(c._id));
      // Resume-eligible ONLY when the current derivation also equals the one
      // recorded at examination time — a parent tick edit between attempts
      // changes the derivation while the child looks untouched (Codex P2
      // r15). A recorded entry without `d` cannot be verified → skip.
      if (derived !== null && stored === derived && rec?.d === derived) {
        toClear.push({
          _id: c._id,
          observed: stored as string,
          observedUpdatedAt: c.updatedAt,
          viaParent: hasOwn(c) ? null : c.parentId,
        });
      }
    }

    // RECORD the observation of every NEWLY examined candidate — matches AND
    // non-matches — in one fenced write BEFORE any destructive write (Codex
    // P1 r11: a non-match left unrecorded would be re-judged by a later
    // attempt after e.g. a tick edit made it match, erasing a value the user
    // authored between attempts). Each entry carries the derivation at
    // examination time (`d`) so a resume can detect parent-side drift.
    // Already-recorded rows are NOT re-recorded (their original observation is
    // the authority). matchedCount (not modifiedCount): the fence asks "does
    // the claim still carry OUR token", not "did the write change anything".
    if (fresh.length > 0) {
      const recorded = await markers.updateOne(
        { _id: MARKER_ID, claimToken: token },
        {
          $addToSet: {
            processed: {
              $each: fresh.map((c) => {
                const o = observationOf(c);
                return { i: String(c._id), c: o.c, u: o.u, d: deriveFor(c) };
              }),
            },
          },
        },
      );
      if (recorded.matchedCount !== 1) throw new LegacyCleanupInProgressError();
    }

    // Per-row CONDITIONAL clears. The filter re-asserts the exact condition
    // AND the exact updatedAt the scan observed, so a row saved by another
    // client between scan and write keeps its new state even when the
    // re-pinned text is byte-identical (the save bumped updatedAt). A thrown
    // clear leaves the row recorded: the retry re-attempts it while untouched
    // (identical observation) and skips it the moment anyone saves it.
    for (const entry of toClear) {
      // Codex P2 r10: re-assert ownership at the destructive-write boundary —
      // a takeover in the record→clear window would let the new holder skip
      // this recorded row and complete while our clear lands after. The
      // residual (takeover between this read and the write below) is
      // benign-convergent: the condition+updatedAt predicate means a late
      // clear can only apply the exact clear the migration intended, and any
      // user save in between bumps updatedAt and blocks it.
      const owned = await markers.findOne({ _id: MARKER_ID });
      if (!owned || owned.claimToken !== token) throw new LegacyCleanupInProgressError();
      // Codex P2 r15: for a row whose provenance came through its PARENT, the
      // conditional filter below cannot see a parent tick edit (the child's
      // updatedAt is untouched by it) — so re-read the ACTIVE parent and
      // re-derive immediately before the write; any drift skips the row. The
      // residual single-write window is the same benign-convergent one as the
      // ownership re-check above. Own-tick rows need no re-read: their tick
      // edits bump the child's own updatedAt, which the filter re-asserts.
      if (entry.viaParent != null) {
        const parentNow = await filaments.findOne({ _id: entry.viaParent, _deletedAt: null });
        const parentRefs = Array.isArray(parentNow?.compatibleNozzles)
          ? (parentNow!.compatibleNozzles as unknown[])
          : [];
        const parentDocs = parentRefs.length
          ? await nozzles
              .find({ _id: { $in: parentRefs } }, { projection: { _id: 1, diameter: 1 } })
              .toArray()
          : [];
        if (deriveLegacyNozzleCondition(parentDocs) !== entry.observed) continue;
      }
      const res = await filaments.updateOne(
        {
          _id: entry._id,
          "settings.compatible_printers_condition": entry.observed,
          updatedAt: entry.observedUpdatedAt ?? null,
        },
        { $set: { "settings.compatible_printers_condition": "" } },
      );
      cleared += res.modifiedCount;
    }
  } catch (err) {
    // Durably mark the attempt released (progress kept) so the next attempt —
    // this process or any other — resumes instead of waiting on a claim
    // nobody holds. Fenced: if the claim was taken over, this no-ops and the
    // new holder's state stands. If the write fails, the claim stays
    // live-shaped: contenders throw until it goes stale, then the CAS
    // takeover resumes it.
    await markers
      .updateOne({ _id: MARKER_ID, claimToken: token }, { $set: { released: true } })
      .catch(() => {});
    throw err;
  }

  // Fenced completion: if the claim was taken over mid-run, the new holder
  // owns the terminal state — surface the in-progress error instead of
  // reporting a terminal result the marker does not reflect. A TRANSIENT
  // failure of this write releases the claim (Codex P1 r10) — otherwise a
  // one-off error here would leave a live-shaped claim that every dbConnect
  // waits on and fails against until staleMs, an avoidable outage; all row
  // work is recorded, so the released-claim resume just re-runs this
  // completion against an empty candidate set.
  let done;
  try {
    done = await markers.updateOne(
      { _id: MARKER_ID, claimToken: token },
      { $set: { completed: true, completedAt: new Date() } },
    );
  } catch (err) {
    await markers
      .updateOne({ _id: MARKER_ID, claimToken: token }, { $set: { released: true } })
      .catch(() => {});
    throw err;
  }
  if (done.matchedCount !== 1) throw new LegacyCleanupInProgressError();
  return { ran: true, cleared };
}

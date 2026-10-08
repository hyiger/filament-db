/**
 * GH #1227 — the startup pass that marks stored `optTags` already on the
 * OpenPrintTag spec numbering, and the Data health resolution that converts
 * (or keeps) every other array on the user's say-so.
 *
 * ## The marker
 *
 * `Filament.optTagsSpec: true` means "this row's `optTags` are spec ids".
 * Every row written since the enum was corrected carries it (schema default);
 * every row this pass can SETTLE (trivially spec) gets it; every other row
 * stays unmarked and is listed on Data health until the user says where its
 * tags came from. The marker is per ROW and travels WITH the document —
 * through hybrid sync's whole-document copies, through snapshots, through
 * shared catalogs — which is what makes a conversion safe to sync: a row the
 * user converted on one desktop is already marked when it reaches a peer, so
 * it is never converted twice. (A `_migrations`-level "done" flag could not
 * promise that: the remap is not idempotent on its own — `[2]` → `[20]` →
 * `[46]` — and a second desktop joining the same Atlas would have had no way
 * to tell a converted `[20]` from an unconverted one.)
 *
 * ## The pass
 *
 * For every unmarked filament (`optTagsSpec: { $ne: true }` — trashed rows
 * included, they can be restored), `classifyOptTags` decides:
 *
 *  - `trivial` → mark it. Nothing to translate (the remap would not change
 *    it): only ids that mean the same under both numberings. A legacy-numbered
 *    OPT snapshot on such a row is translated at the same time (below).
 *  - `ambiguous` → leave it unmarked. Data health lists it with both readings
 *    and hints; `resolveOptTagNumbering` applies the user's answer.
 *
 * THE PASS NEVER CONVERTS. No stored content proves the legacy numbering —
 * twelve Codex review rounds on PR #1228 took every candidate proof apart
 * (backfill equality, spec-only ids, the deprecated 18, pre-v1.83 snapshot
 * equality, a bare link; see the classifier's docblock) — so an automatic
 * conversion would be a guess that rewrites a user's data. Converting is a
 * user action: per row, or in bulk for the rows carrying the
 * `opt-provenance` hint ("most likely imported from the OpenPrintTag
 * database"). A resolution stamps `updatedAt`, so in hybrid mode it syncs to
 * the other peer like any other edit, marker included.
 *
 * Every write is conditioned on the row still being unmarked AND on every
 * classifier input exactly as it was read — `optTags`, the snapshot container's
 * presence and type, its `optTags` and numbering marker, the link settings
 * (`observedClassifierInputs`) — so a row another desktop or the sync service
 * replaced between the read and the write matches nothing and is simply
 * reclassified on the next pass (the #1021 posture). Pinning only the array
 * let a row read as trivial `[4]` and replaced with legacy `[2]` be marked
 * verified (Codex P1 r6 on PR #1228). The pass never touches `updatedAt`:
 * the marking is deterministic and every peer performs it on its own copy
 * before any copy, so there is nothing to propagate; a synthetic timestamp
 * let whichever side marked LATER win the hybrid LWW with a stale document
 * over the other side's genuinely newer edits (Codex P1 r7).
 *
 * Legacy concepts a Data health CONVERSION drops (no spec equivalent) are
 * RECORDED in the `_migrations` document so the page can show the user what
 * went away instead of losing it silently. The record is written BEFORE the
 * conversion (Codex P2 on PR #1228): a conversion that lands and a record
 * that then fails would mark the row settled with no trace of what it lost,
 * and nothing could reconstruct it. If the conversion's write is then skipped
 * (concurrent edit) or throws, the record is reconciled against a re-read of
 * the row (`reconcileDropRecord`); the record write is ONE atomic replacement
 * per row (`recordDropped`), so a retry replaces a stale notice instead of
 * stacking a second.
 *
 * `openprinttagSnapshot.optTags` — what the OPT importer/re-sync last offered —
 * is in the legacy numbering when the snapshot predates v1.83 (it then has no
 * `tagsNumbering` entry), so such a snapshot is translated AND stamped
 * `tagsNumbering: "spec"` whenever the row is marked (by the pass OR by a Data
 * health resolution, whichever marks it); a snapshot already marked spec is
 * never touched, so no snapshot is translated twice (Codex P1 r4 on PR
 * #1228).
 *
 * ## Driver-level, on purpose
 *
 * Takes a minimal `db` handle rather than Mongoose models so `dbConnect` (the
 * local database) and the Electron hybrid-sync service (the REMOTE database,
 * which never runs `dbConnect`) share ONE implementation — the same shape
 * `trimEntityNames` and the #1021 cleanup use. Timestamps are therefore set
 * by hand (`updatedAt`), since the raw driver has no Mongoose timestamps.
 */

import {
  classifyOptTags,
  describeOptTagReadings,
  isDocumentContainer,
  isSnapshotDocument,
  remapLegacyOptTags,
  sameOptTagSet,
  type OptTagClassifiable,
  type OptTagHint,
  SPEC_ONLY_IDS,
  LEGACY_ONLY_IDS,
  OPT_SNAPSHOT_NUMBERING_KEY,
  OPT_SNAPSHOT_SPEC_NUMBERING,
  OPT_TAG_CLASSIFIER_PATHS,
  snapshotIsSpecNumbered,
} from "./optTagLegacy";

export interface MinimalRenumberCollection {
  find(
    filter: Record<string, unknown>,
    options?: { projection?: Record<string, unknown> },
  ): { toArray(): Promise<Record<string, unknown>[]> };
  findOne(
    filter: Record<string, unknown>,
    options?: { projection?: Record<string, unknown> },
  ): Promise<Record<string, unknown> | null>;
  updateOne(
    filter: Record<string, unknown>,
    /** An update document, or an aggregation pipeline (the atomic drop-record replacement). */
    update: Record<string, unknown> | Record<string, unknown>[],
    options?: { upsert?: boolean },
  ): Promise<{ matchedCount?: number; modifiedCount?: number } | unknown>;
}

export interface MinimalRenumberDb {
  collection(name: string): MinimalRenumberCollection;
}

/** `_migrations` document: the pass's last run, and the legacy tags Data health conversions dropped. */
export const OPT_TAG_RENUMBER_MARKER_ID = "optTagRenumber";

/** The filter that selects rows this pass has not settled. */
export const UNVERIFIED_OPT_TAGS_FILTER: Readonly<Record<string, unknown>> = {
  optTagsSpec: { $ne: true },
};

// Everything the classifier reads (incl. the snapshot's numbering marker — a
// projection that drops it turns a spec snapshot into a legacy-looking one)
// plus what the pass and Data health need of their own.
/**
 * The snapshot CONTAINER is projected whole, never through its child paths.
 * MongoDB omits a parent that is not a document from a child-path projection
 * (`{"openprinttagSnapshot.optTags": 1}` over `openprinttagSnapshot: null`
 * returns no `openprinttagSnapshot` at all), and `null` is exactly what the
 * schema default stores on every row the pre-v1.83 app saved. Read through the
 * child paths, such a row came back with the container ABSENT, the container
 * pin below said `$exists: false`, and the conditional write matched nothing:
 * every schema-shaped trivial row was skipped on every pass, and every Data
 * health decision answered `tags_changed`. The raw-insert test fixtures (field
 * truly absent) hid it; CI caught it the moment a fixture was written through
 * Mongoose (PR #1228). The same goes for the `settings` bag (Codex P2 r19):
 * a `null` bag vanishes from a child-path projection and an ARRAY bag (the
 * path is `Mixed`; restore accepts it) defeats a child `$exists: false` pin,
 * because dotted predicates traverse array elements — so the bag is projected
 * whole too and its container shape is pinned. Only the pass (over the
 * unmarked rows, a one-time set) and a single-row resolution read this
 * projection, so the bag's size is not a concern here; the classification-only
 * readers (the PUT and GET routes) keep the child paths.
 */
const ROW_PROJECTION: Record<string, 1> = {
  ...Object.fromEntries(
    OPT_TAG_CLASSIFIER_PATHS.map((path) => [
      path.startsWith("openprinttagSnapshot.") ? "openprinttagSnapshot" : path.startsWith("settings.") ? "settings" : path,
      1 as const,
    ]),
  ),
  vendor: 1,
  _deletedAt: 1,
  _purged: 1,
};

/** A legacy concept a Data health conversion had to drop from one filament. */
export interface DroppedLegacyTags {
  filamentId: string;
  name: string;
  /** LEGACY ids (label them through `optTagLegacy.<name>`). */
  tags: number[];
  at: Date;
}

export interface OptTagRenumberSummary {
  scanned: number;
  /** Trivially spec, marked. */
  verified: number;
  /** Left unmarked for Data health. */
  ambiguous: number;
  /** A conditional write matched nothing (concurrent edit) — next pass. */
  skipped: number;
}

function emptySummary(): OptTagRenumberSummary {
  return { scanned: 0, verified: 0, ambiguous: 0, skipped: 0 };
}

/**
 * `$set` fragment translating a LEGACY-numbered OPT snapshot, if the row has
 * one, and stamping it `tagsNumbering: "spec"` so it is never translated
 * twice. A snapshot that already says it is spec-numbered (written by a
 * post-v1.83 link/re-sync/import) is left alone (Codex P1 r4 on PR #1228).
 * The container must be a DOCUMENT: the schema path is `Mixed` and snapshot
 * restore accepts any shape, so an ARRAY can be stored there, and `typeof`
 * calls it an object — MongoDB rejects `$set` of a named child into an array,
 * so one malformed row made the pass throw on every connect, Data health
 * answer 500 and the sync cycle abort (Codex P2 r17). A non-document is read
 * as "no snapshot object" everywhere (classifier + pin) and never written.
 */
function snapshotRemapSet(row: Record<string, unknown>): Record<string, unknown> {
  const snapshot = row.openprinttagSnapshot as Record<string, unknown> | null | undefined;
  if (!isSnapshotDocument(snapshot) || snapshotIsSpecNumbered(snapshot)) return {};
  const set: Record<string, unknown> = {
    [`openprinttagSnapshot.${OPT_SNAPSHOT_NUMBERING_KEY}`]: OPT_SNAPSHOT_SPEC_NUMBERING,
  };
  if (Array.isArray(snapshot.optTags)) {
    set["openprinttagSnapshot.optTags"] = remapLegacyOptTags(snapshot.optTags).tags;
  }
  return set;
}

/**
 * The exact classifier inputs this pass observed, as a filter fragment: the
 * conditional write below matches only a row that still looks exactly like
 * what was classified AND hinted (Codex P1 r6 + P2 r15 on PR #1228). An absent field pins
 * "absent" — `undefined` is not a valid query value, and a row that GAINED a
 * snapshot or a link since the read must not match either.
 */
function observedClassifierInputs(row: Record<string, unknown>): Record<string, unknown> {
  // Child pins only for a DOCUMENT container (Codex P2 r18 on PR #1228): a
  // dotted predicate traverses array elements, so for a restored
  // `openprinttagSnapshot: [{ optTags: [2] }]` the classifier rightly reads
  // "no snapshot object" while `"openprinttagSnapshot.optTags": {$exists:
  // false}` is FALSE (MongoDB finds `optTags` inside the element) — the write
  // never matched, the pass skipped the row on every connect and every
  // resolution answered `tags_changed`. The container pin (`$type: "array"`)
  // already fixes a non-document shape exactly.
  const snapshot = isSnapshotDocument(row.openprinttagSnapshot) ? row.openprinttagSnapshot : null;
  // The settings bag is pinned the same way (Codex P2 r19): its container
  // shape always, its two link keys only when it is a document.
  const settings = isDocumentContainer(row.settings) ? row.settings : null;
  const pin = (value: unknown): unknown => (value === undefined ? { $exists: false } : value);
  // The snapshot CONTAINER is pinned by presence and type, not only its
  // children (Codex P1 r10 on PR #1228): `classifyOptTags` reads "no snapshot
  // object at all" (a pre-v1.36 import — the link alone is proof) differently
  // from "a snapshot object with no `optTags` entry" (the material offered no
  // tags — nothing to conclude), and the two children's `$exists: false` pins
  // are satisfied by BOTH shapes. A linked `[2]` read without a snapshot and
  // replaced, before the write, by a whole-document copy carrying a tag-less
  // pre-upgrade snapshot must match nothing, not convert.
  const pinContainer = (value: unknown): unknown => {
    if (value === undefined) return { $exists: false };
    if (value === null) return { $type: "null" };
    if (Array.isArray(value)) return { $type: "array" };
    if (typeof value === "object") return { $type: "object" };
    return value;
  };
  return {
    optTags: pin(row.optTags),
    // `name` + `type` feed the `backfill-derivation` hint (Codex P2 r15 on PR
    // #1228): a rename or re-type landing between the read that validated the
    // echoed hints and this write would otherwise apply a decision made on a
    // hint the row no longer carries. Every hint-producing input is pinned.
    name: pin(row.name),
    type: pin(row.type),
    openprinttagSnapshot: pinContainer(row.openprinttagSnapshot),
    ...(snapshot
      ? {
          "openprinttagSnapshot.optTags": pin(snapshot.optTags),
          [`openprinttagSnapshot.${OPT_SNAPSHOT_NUMBERING_KEY}`]: pin(snapshot[OPT_SNAPSHOT_NUMBERING_KEY]),
        }
      : {}),
    settings: pinContainer(row.settings),
    ...(settings
      ? {
          "settings.openprinttag_slug": pin(settings.openprinttag_slug),
          "settings.openprinttag_uuid": pin(settings.openprinttag_uuid),
        }
      : {}),
  };
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

function matched(res: unknown): boolean {
  const n = (res as { matchedCount?: number } | null | undefined)?.matchedCount;
  // A driver result always carries matchedCount; a test double may not — then
  // trust the write rather than counting a success as a skip.
  return n === undefined || n > 0;
}

/** The drop record for one row. */
function droppedEntryFor(row: Record<string, unknown>, dropped: number[], now: Date): DroppedLegacyTags {
  return {
    filamentId: String(row._id),
    name: typeof row.name === "string" ? row.name : "",
    tags: dropped,
    at: now,
  };
}

/** A stored `dropped[]` element that is a usable record. */
function isDropRecord(d: unknown): d is DroppedLegacyTags {
  return !!d && typeof d === "object" && typeof (d as DroppedLegacyTags).filamentId === "string";
}

/**
 * Record one row's dropped legacy concepts — written BEFORE the row is
 * converted. Idempotent per filament AND atomic: ONE pipeline update drops
 * every earlier record for the same row and appends this one. A pull-then-push
 * pair was not enough (Codex P2 r10 on PR #1228): two concurrent conversions
 * could both pull before either pushed, leaving two records for one
 * conversion that `reconcileDropRecord` then rightly kept (the row IS
 * converted). `$literal`: a name (or id) beginning with `$` must not be read
 * as a field path.
 */
async function recordDropped(db: MinimalRenumberDb, entry: DroppedLegacyTags): Promise<void> {
  await db.collection("_migrations").updateOne(
    { _id: OPT_TAG_RENUMBER_MARKER_ID },
    [
      {
        $set: {
          dropped: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ["$dropped", []] },
                  as: "d",
                  cond: { $ne: ["$$d.filamentId", { $literal: entry.filamentId }] },
                },
              },
              [{ $literal: entry }],
            ],
          },
        },
      },
    ],
    { upsert: true },
  );
}

/** Undo `recordDropped` for a conversion that did not land (concurrent edit, or a write shown not to have landed). */
async function unrecordDropped(db: MinimalRenumberDb, entry: DroppedLegacyTags): Promise<void> {
  await db
    .collection("_migrations")
    .updateOne(
      { _id: OPT_TAG_RENUMBER_MARKER_ID },
      { $pull: { dropped: { filamentId: entry.filamentId, at: entry.at } } },
    );
}

/**
 * A conversion write did not succeed as expected — it THREW, or it matched
 * nothing. Neither tells us the row is unconverted: a thrown write may have
 * committed and lost its acknowledgement (Codex P2 r5 on PR #1228), and an
 * unmatched one may have lost to a COMPETING conversion that landed the
 * identical write first and marked the row (another process on the same
 * database — Codex P2 r8). In the second case the record this call wrote
 * replaced the competitor's, so it is the only notice left. Re-read the row
 * to decide what becomes of it:
 *  - the row is marked AND holds exactly the array this conversion would have
 *    written → a conversion landed; the record stays (nothing revisits a
 *    marked row, so this is the record's only chance to survive);
 *  - the row is still unmarked → it did not land; pull the record;
 *  - the re-read fails too, or the row is gone → keep the record. A kept
 *    record for a conversion that never landed is REPLACED, not duplicated,
 *    when the row converts later (`recordDropped` is idempotent per filament),
 *    and the Data health notice is dismissable — a stale notice is the cheaper
 *    error, a lost one is silent data loss.
 */
async function reconcileDropRecord(
  db: MinimalRenumberDb,
  filaments: MinimalRenumberCollection,
  id: unknown,
  wouldHaveWritten: readonly number[],
  entry: DroppedLegacyTags,
): Promise<void> {
  let landed: boolean | null = null;
  try {
    const row = await filaments.findOne({ _id: id }, { projection: { optTags: 1, optTagsSpec: 1 } });
    if (row) {
      landed = row.optTagsSpec === true && sameOptTagSet(row.optTags as unknown[], wouldHaveWritten);
    }
  } catch {
    landed = null;
  }
  if (landed === false) await unrecordDropped(db, entry).catch(() => undefined);
}

async function recordRun(db: MinimalRenumberDb, now: Date, counts: OptTagRenumberSummary): Promise<void> {
  await db
    .collection("_migrations")
    .updateOne({ _id: OPT_TAG_RENUMBER_MARKER_ID }, { $set: { lastRunAt: now, lastRun: counts } }, { upsert: true });
}

/**
 * Mark every unmarked filament whose array is trivially spec (and translate
 * its legacy snapshot); leave every other one for Data health. Idempotent: a
 * second run finds only the rows the first could not settle, and does nothing
 * to them. Converts nothing — see the module docblock.
 */
export async function renumberOptTags(
  db: MinimalRenumberDb,
  now: Date = new Date(),
): Promise<OptTagRenumberSummary> {
  const filaments = db.collection("filaments");
  const rows = await filaments.find({ ...UNVERIFIED_OPT_TAGS_FILTER }, { projection: ROW_PROJECTION }).toArray();
  const summary = emptySummary();

  for (const row of rows) {
    summary.scanned++;
    if (classifyOptTags(row as OptTagClassifiable).kind === "ambiguous") {
      summary.ambiguous++;
      continue;
    }
    // No `updatedAt` on this write — see the module docblock: the marking is
    // a per-peer rewrite, not an edit to propagate.
    const res = await filaments.updateOne(
      { _id: row._id, ...UNVERIFIED_OPT_TAGS_FILTER, ...observedClassifierInputs(row) },
      { $set: { optTagsSpec: true, ...snapshotRemapSet(row) } },
    );
    if (!matched(res)) {
      // The row no longer looks like what was classified — reclassified next pass.
      summary.skipped++;
      continue;
    }
    summary.verified++;
  }

  if (summary.scanned > 0) await recordRun(db, now, summary);
  return summary;
}

/** One log line, or null when the pass found nothing to look at. */
export function describeRenumberSummary(s: OptTagRenumberSummary): string | null {
  if (s.scanned === 0) return null;
  const parts = [`verified ${s.verified}`, `awaiting review ${s.ambiguous}`];
  if (s.skipped > 0) parts.push(`skipped ${s.skipped} (concurrent edit — next pass)`);
  return `[migration] GH #1227: optTags → OpenPrintTag spec numbering — ${parts.join(", ")}`;
}

// ── Data health ──────────────────────────────────────────────────────────────

/** One row the pass left for the user, with both readings pre-computed. */
export interface PendingOptTagRow {
  filamentId: string;
  name: string;
  vendor: string | null;
  type: string | null;
  trashed: boolean;
  /** Always `ambiguous` — the only verdict that leaves a row for the user. */
  verdict: "ambiguous";
  /**
   * The classifier's hints for this row, as displayed. The page echoes them
   * back as `expectedHints` on resolve, and the resolution refuses when they
   * no longer hold (Codex P2 r14 on PR #1228): the bulk "imported from
   * OpenPrintTag" action selects rows BY the `opt-provenance` hint, and a
   * re-link or a sync between the scan and the click can replace the legacy
   * snapshot with a spec-marked one while leaving the array unchanged — the
   * array pin alone would still accept the convert. The booleans below are
   * the same information, pre-split for the card.
   */
  hints: OptTagHint[];
  /**
   * OpenPrintTag provenance: a pre-v1.83 snapshot whose `optTags` equal the
   * stored array, or a link with no snapshot object — likely imported from
   * the OPT database, shown as a hint, never decided (the link route and the
   * re-sync store a snapshot without touching the array; a bare slug rides
   * the slicer round-trip and the share import — Codex P1 r12 on PR #1228).
   * Data health offers a bulk conversion for exactly these rows.
   */
  matchesOptProvenance: boolean;
  /**
   * The array equals what the historical backfill script wrote for this
   * name + type — likely entered in this app, shown as a hint, never decided.
   */
  matchesBackfill: boolean;
  /**
   * Ids in the array the pre-#1227 FORM could not have written (spec-only
   * ids) — likely read from a tag or typed from the spec, shown as a hint,
   * never decided: the pre-#1227 CSV importer could store them too (Codex P1
   * r3 on PR #1228).
   */
  specOnlyIds: number[];
  /**
   * Ids the current spec does not define but the pre-#1227 app did (18, its
   * MARBLE) — likely entered in this app, shown as a hint, never decided: an
   * older spec defined 18 and a vendor tag could carry it (Codex P1 r6).
   */
  legacyOnlyIds: number[];
  /** The stored ids, verbatim order — echoed back as `expectedTags` on resolve. */
  stored: number[];
  asLegacy: { tags: number[]; dropped: number[] };
  asSpec: number[];
}

/**
 * Every unmarked, non-purged filament the classifier cannot settle. Trivially
 * spec rows are not listed — call `renumberOptTags` first (the GET route does)
 * so such a row that arrived after startup (a share import, a synced-down peer
 * row) is marked rather than shown as pending.
 */
export async function scanUnverifiedOptTags(db: MinimalRenumberDb): Promise<PendingOptTagRow[]> {
  const rows = await db
    .collection("filaments")
    .find({ ...UNVERIFIED_OPT_TAGS_FILTER, _purged: { $ne: true } }, { projection: ROW_PROJECTION })
    .toArray();
  const out: PendingOptTagRow[] = [];
  for (const row of rows) {
    const verdict = classifyOptTags(row as OptTagClassifiable);
    if (verdict.kind !== "ambiguous") continue;
    const readings = describeOptTagReadings(row.optTags as unknown[]);
    out.push({
      filamentId: String(row._id),
      name: typeof row.name === "string" ? row.name : "",
      vendor: typeof row.vendor === "string" ? row.vendor : null,
      type: typeof row.type === "string" ? row.type : null,
      trashed: row._deletedAt != null,
      verdict: verdict.kind,
      hints: [...verdict.hints],
      matchesOptProvenance: verdict.hints.includes("opt-provenance"),
      matchesBackfill: verdict.hints.includes("backfill-derivation"),
      specOnlyIds: readings.stored.filter((id) => SPEC_ONLY_IDS.has(id)),
      legacyOnlyIds: readings.stored.filter((id) => LEGACY_ONLY_IDS.has(id)),
      ...readings,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export type OptTagResolveAction = "convert" | "keep";

export type OptTagResolveResult =
  | { outcome: "converted"; tags: number[]; dropped: number[] }
  | { outcome: "kept"; tags: number[] }
  /** Already marked, or the stored array no longer matches what the user saw. */
  | { outcome: "changed" }
  | { outcome: "not_found" };

/**
 * Apply the user's answer for one pending row. `expectedTags` is the array the
 * user was shown; the write is conditioned on the row still holding exactly it
 * (and still being unmarked), so an edit made in another tab since the scan is
 * reported as `changed` instead of being overwritten. It is ALSO conditioned
 * on the snapshot and link state exactly as read (`observedClassifierInputs`,
 * the same pin the pass uses): the `$set` translates the snapshot that was
 * READ, and a snapshot re-linked under it (now spec-marked) would otherwise be
 * overwritten with a stale legacy remap (Codex P2 r8 on PR #1228).
 *
 * `expectedHints`, when the caller sends them, are the classifier hints the
 * page DISPLAYED; the decision is refused as `changed` when the row as read no
 * longer carries exactly that set (Codex P2 r14). The array pin covers an
 * edit to the tags; this covers the evidence the user decided ON — the bulk
 * "imported from OpenPrintTag" action selects rows by the `opt-provenance`
 * hint, and a re-link or a sync between the scan and the click can swap the
 * legacy snapshot for a spec-marked one while the array stays `[2]`: the pin
 * then matches the NEW state, so without this check the convert would still
 * land on a row that no longer qualifies. Checked against the same read the
 * write is pinned to, so it cannot pass on one state and write under another.
 *
 *  - `convert`: the tags were entered in this app → translate legacy → spec.
 *  - `keep`: the tags came from a vendor tag → already spec, just mark them.
 *
 * Both translate a legacy-numbered OPT snapshot (see the module docblock).
 */
export async function resolveOptTagNumbering(
  db: MinimalRenumberDb,
  filamentId: unknown,
  action: OptTagResolveAction,
  expectedTags: readonly number[],
  now: Date = new Date(),
  expectedHints?: readonly string[],
): Promise<OptTagResolveResult> {
  const filaments = db.collection("filaments");
  const row = await filaments.findOne({ _id: filamentId }, { projection: ROW_PROJECTION });
  if (!row) return { outcome: "not_found" };
  if (row.optTagsSpec === true) return { outcome: "changed" };
  const stored = Array.isArray(row.optTags) ? (row.optTags as unknown[]) : [];
  if (!sameOptTagSet(stored, expectedTags)) return { outcome: "changed" };
  if (expectedHints) {
    const verdict = classifyOptTags(row as OptTagClassifiable);
    const current: readonly string[] = verdict.kind === "ambiguous" ? verdict.hints : [];
    if (!sameStringSet(current, expectedHints)) return { outcome: "changed" };
  }

  const $set: Record<string, unknown> = { optTagsSpec: true, updatedAt: now, ...snapshotRemapSet(row) };
  let remapped: { tags: number[]; dropped: number[] } | null = null;
  let droppedEntry: DroppedLegacyTags | null = null;
  if (action === "convert") {
    remapped = remapLegacyOptTags(stored);
    $set.optTags = remapped.tags;
    if (remapped.dropped.length > 0) {
      droppedEntry = droppedEntryFor(row, remapped.dropped, now);
      // Record first, convert second — see the module docblock.
      await recordDropped(db, droppedEntry);
    }
  }
  let res: unknown;
  try {
    res = await filaments.updateOne(
      { _id: row._id, ...UNVERIFIED_OPT_TAGS_FILTER, ...observedClassifierInputs(row) },
      { $set },
    );
  } catch (err) {
    // A thrown write has an UNKNOWN outcome (Codex P2 r4 + r5 on PR #1228).
    if (droppedEntry) {
      await reconcileDropRecord(db, filaments, row._id, remapped?.tags ?? [], droppedEntry);
    }
    throw err;
  }
  if (!matched(res)) {
    // A competing conversion may have landed first (Codex P2 r8), and this
    // record is then the only notice left — reconciled, not pulled.
    if (droppedEntry) {
      await reconcileDropRecord(db, filaments, row._id, remapped?.tags ?? [], droppedEntry);
    }
    return { outcome: "changed" };
  }

  if (remapped) {
    return { outcome: "converted", tags: remapped.tags, dropped: remapped.dropped };
  }
  return {
    outcome: "kept",
    tags: stored.filter((t): t is number => typeof t === "number"),
  };
}

/** The recorded drops (for Data health), oldest first. */
export async function readDroppedLegacyTags(db: MinimalRenumberDb): Promise<DroppedLegacyTags[]> {
  const doc = await db.collection("_migrations").findOne({ _id: OPT_TAG_RENUMBER_MARKER_ID });
  const list = (doc as { dropped?: unknown } | null)?.dropped;
  if (!Array.isArray(list)) return [];
  return list.filter(isDropRecord);
}

/** The identity of one displayed drop record: the row it names AND the version shown. */
export interface DroppedLegacyTagsRef {
  filamentId: string;
  at: Date;
}

/**
 * Dismiss recorded drops once the user has read them. With `records`, only
 * those EXACT records go — matched on `filamentId` AND `at`, the version the
 * page displayed: a record appended between the page load and the click
 * survives (Codex P2 r7 on PR #1228), and so does a REPLACEMENT for the same
 * row — a later conversion of the same filament (made reviewable again by a
 * snapshot restore or a newer unverified hybrid revision) re-records under the
 * same `filamentId` with a new `at`, and a dismissal keyed on the id alone
 * pulled the notice the user never saw (Codex P2 r16). One `$pull` per record,
 * with explicit `$eq` operators so the condition is unambiguously a query
 * against each element, not a whole-document equality. Without `records`,
 * everything is cleared (API callers that read the whole list themselves).
 */
export async function dismissDroppedLegacyTags(
  db: MinimalRenumberDb,
  records?: readonly DroppedLegacyTagsRef[],
): Promise<void> {
  const migrations = db.collection("_migrations");
  if (records) {
    for (const r of records) {
      await migrations.updateOne(
        { _id: OPT_TAG_RENUMBER_MARKER_ID },
        { $pull: { dropped: { filamentId: { $eq: r.filamentId }, at: { $eq: r.at } } } },
      );
    }
    return;
  }
  await migrations.updateOne({ _id: OPT_TAG_RENUMBER_MARKER_ID }, { $set: { dropped: [] } }, { upsert: true });
}

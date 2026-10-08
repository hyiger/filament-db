/**
 * GH #1227 — the startup pass that brings stored `optTags` onto the OpenPrintTag
 * spec numbering, and the Data health resolution it hands the user.
 *
 * ## The marker
 *
 * `Filament.optTagsSpec: true` means "this row's `optTags` are spec ids".
 * Every row written since the enum was corrected carries it (schema default);
 * every row this pass can SETTLE gets it; a row the pass cannot settle stays
 * unmarked and is listed on Data health until the user says where its tags
 * came from. The marker is per ROW and travels WITH the document — through
 * hybrid sync's whole-document copies, through snapshots, through shared
 * catalogs — which is what makes the pass idempotent: a converted row synced
 * to a peer is already marked when that peer's pass runs, so it is never
 * converted twice. (A `_migrations`-level "done" flag could not promise that:
 * the remap is not idempotent on its own — `[2]` → `[20]` → `[46]` — and a
 * second desktop joining the same Atlas would have had no way to tell a
 * converted `[20]` from an unconverted one.)
 *
 * ## The pass
 *
 * For every unmarked filament (`optTagsSpec: { $ne: true }` — trashed rows
 * included, they can be restored), `classifyOptTags` decides:
 *
 *  - `trivial` → mark it. Nothing to translate (the remap would not change it).
 *  - `legacy` → translate with `remapLegacyOptTags`, mark it, bump
 *    `updatedAt` so the change propagates by LWW to a peer that has not run
 *    the pass. Legacy concepts with no spec equivalent are dropped and
 *    RECORDED (in the `_migrations` document) so Data health can show the
 *    user what went away instead of losing it silently. The record is written
 *    BEFORE the conversion (Codex P2 on PR #1228): a conversion that lands and
 *    a record that then fails would mark the row settled with no trace of what
 *    it lost, and no later pass could reconstruct it. If the conversion is
 *    then skipped (concurrent edit), the just-written record is pulled back.
 *  - `ambiguous` → leave it unmarked. Data health lists it
 *    with both readings; `resolveOptTagNumbering` applies the user's answer.
 *
 * Every write is conditioned on the row still being unmarked AND on every
 * classifier input exactly as it was read — `optTags`, the snapshot's
 * `optTags` and numbering marker, the link settings (`observedClassifierInputs`)
 * — so a row another desktop or the sync service replaced between the read
 * and the write matches nothing and is simply reclassified on the next pass
 * (the #1021 posture). Pinning only the array, and only for conversions,
 * let a row read as trivial `[4]` and replaced with legacy `[2]` be marked
 * verified (Codex P1 r6 on PR #1228).
 *
 * `openprinttagSnapshot.optTags` — what the OPT importer/re-sync last offered —
 * is in the legacy numbering when the snapshot predates v1.83 (it then has no
 * `tagsNumbering` entry), so such a snapshot is translated AND stamped
 * `tagsNumbering: "spec"` whenever the row is marked (by the pass OR by a Data
 * health resolution, whichever marks it); a snapshot already marked spec is
 * never touched, so no snapshot is translated twice (Codex P1 r4 on PR
 * #1228). Residual: a post-upgrade re-import/link/re-sync that lands BEFORE
 * this pass first runs (only possible if the pass failed transiently on first
 * connect) replaces a legacy snapshot with a marked spec one, so that row
 * loses its provenance proof and goes to Data health instead of converting on
 * its own — never a wrong conversion.
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
  remapLegacyOptTags,
  sameOptTagSet,
  type OptTagClassifiable,
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
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<{ matchedCount?: number; modifiedCount?: number } | unknown>;
}

export interface MinimalRenumberDb {
  collection(name: string): MinimalRenumberCollection;
}

/** `_migrations` document that records what the pass did (dropped legacy tags). */
export const OPT_TAG_RENUMBER_MARKER_ID = "optTagRenumber";

/** The filter that selects rows this pass has not settled. */
export const UNVERIFIED_OPT_TAGS_FILTER: Readonly<Record<string, unknown>> = {
  optTagsSpec: { $ne: true },
};

// Everything the classifier reads (incl. the snapshot's numbering marker — a
// projection that drops it turns a spec snapshot into a legacy-looking one)
// plus what the pass and Data health need of their own.
const ROW_PROJECTION: Record<string, 1> = {
  ...Object.fromEntries(OPT_TAG_CLASSIFIER_PATHS.map((path) => [path, 1 as const])),
  vendor: 1,
  _deletedAt: 1,
  _purged: 1,
};

/** A legacy concept the conversion had to drop from one filament. */
export interface DroppedLegacyTags {
  filamentId: string;
  name: string;
  /** LEGACY ids (label them through `optTagLegacy.<name>`). */
  tags: number[];
  at: Date;
}

export interface OptTagRenumberSummary {
  scanned: number;
  /** Legacy → spec, marked. */
  converted: number;
  /** Nothing to translate, marked. */
  verified: number;
  /** Left unmarked for Data health. */
  ambiguous: number;
  /** A conditional write matched nothing (concurrent edit) — next pass. */
  skipped: number;
  dropped: DroppedLegacyTags[];
}

function emptySummary(): OptTagRenumberSummary {
  return { scanned: 0, converted: 0, verified: 0, ambiguous: 0, skipped: 0, dropped: [] };
}

/**
 * `$set` fragment translating a LEGACY-numbered OPT snapshot, if the row has
 * one, and stamping it `tagsNumbering: "spec"` so it is never translated
 * twice. A snapshot that already says it is spec-numbered (written by a
 * post-v1.83 link/re-sync/import) is left alone (Codex P1 r4 on PR #1228).
 */
function snapshotRemapSet(row: Record<string, unknown>): Record<string, unknown> {
  const snapshot = row.openprinttagSnapshot as Record<string, unknown> | null | undefined;
  if (!snapshot || typeof snapshot !== "object" || snapshotIsSpecNumbered(snapshot)) return {};
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
 * what was classified (Codex P1 r6 on PR #1228). An absent field pins
 * "absent" — `undefined` is not a valid query value, and a row that GAINED a
 * snapshot or a link since the read must not match either.
 */
function observedClassifierInputs(row: Record<string, unknown>): Record<string, unknown> {
  const snapshot = row.openprinttagSnapshot as Record<string, unknown> | null | undefined;
  const settings = row.settings as Record<string, unknown> | null | undefined;
  const pin = (value: unknown): unknown => (value === undefined ? { $exists: false } : value);
  return {
    optTags: pin(row.optTags),
    "openprinttagSnapshot.optTags": pin(snapshot?.optTags),
    [`openprinttagSnapshot.${OPT_SNAPSHOT_NUMBERING_KEY}`]: pin(snapshot?.[OPT_SNAPSHOT_NUMBERING_KEY]),
    "settings.openprinttag_slug": pin(settings?.openprinttag_slug),
    "settings.openprinttag_uuid": pin(settings?.openprinttag_uuid),
  };
}

function matched(res: unknown): boolean {
  const n = (res as { matchedCount?: number } | null | undefined)?.matchedCount;
  // A driver result always carries matchedCount; a test double may not — then
  // trust the write rather than counting a success as a skip.
  return n === undefined || n > 0;
}

/**
 * Record one row's dropped legacy concepts — written BEFORE the row is
 * converted. Idempotent per filament: an earlier record for the same row is
 * replaced, not stacked, so a retry after a conversion write that threw (and
 * whose cleanup below may have failed too, e.g. the database went away) cannot
 * leave two notices for one conversion (Codex P2 r4 on PR #1228).
 */
async function recordDropped(db: MinimalRenumberDb, entry: DroppedLegacyTags): Promise<void> {
  const migrations = db.collection("_migrations");
  await migrations.updateOne(
    { _id: OPT_TAG_RENUMBER_MARKER_ID },
    { $pull: { dropped: { filamentId: entry.filamentId } } },
  );
  await migrations.updateOne({ _id: OPT_TAG_RENUMBER_MARKER_ID }, { $push: { dropped: entry } }, { upsert: true });
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
 * A conversion write THREW. That is an UNKNOWN outcome, not a failed one:
 * MongoDB may have committed the update and lost the acknowledgement on the
 * way back (Codex P2 r5 on PR #1228). Re-read the row to decide what becomes
 * of the drop record written before the attempt:
 *  - the row is marked AND holds exactly the array this conversion would have
 *    written → it landed; the record stays (the pass never revisits a marked
 *    row, so this is the record's only chance to survive);
 *  - the row is still unmarked → it did not land; pull the record;
 *  - the re-read fails too, or the row is gone → keep the record. A kept
 *    record for a conversion that never landed is REPLACED, not duplicated,
 *    when the row converts later (`recordDropped` is idempotent per filament),
 *    and the Data health notice is dismissable — a stale notice is the cheaper
 *    error, a lost one is silent data loss.
 */
async function reconcileDropRecordAfterThrow(
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

async function recordRun(
  db: MinimalRenumberDb,
  now: Date,
  counts: Omit<OptTagRenumberSummary, "dropped">,
): Promise<void> {
  await db
    .collection("_migrations")
    .updateOne({ _id: OPT_TAG_RENUMBER_MARKER_ID }, { $set: { lastRunAt: now, lastRun: counts } }, { upsert: true });
}

/**
 * Settle every unmarked filament whose numbering can be proven. Idempotent:
 * a second run finds only the rows the first could not settle, and does
 * nothing to them.
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
    const verdict = classifyOptTags(row as OptTagClassifiable);
    if (verdict.kind === "ambiguous") {
      summary.ambiguous++;
      continue;
    }

    const filter: Record<string, unknown> = {
      _id: row._id,
      ...UNVERIFIED_OPT_TAGS_FILTER,
      ...observedClassifierInputs(row),
    };
    const snapSet = snapshotRemapSet(row);
    const $set: Record<string, unknown> = { optTagsSpec: true, ...snapSet };
    let droppedEntry: DroppedLegacyTags | null = null;
    let convertedTags: number[] | null = null;

    if (verdict.kind === "legacy") {
      const stored = Array.isArray(row.optTags) ? (row.optTags as unknown[]) : [];
      const remapped = remapLegacyOptTags(stored);
      convertedTags = remapped.tags;
      $set.optTags = remapped.tags;
      $set.updatedAt = now;
      if (remapped.dropped.length > 0) {
        droppedEntry = {
          filamentId: String(row._id),
          name: typeof row.name === "string" ? row.name : "",
          tags: remapped.dropped,
          at: now,
        };
        // Record first, convert second — see the module docblock.
        await recordDropped(db, droppedEntry);
      }
    } else if (Object.keys(snapSet).length > 0) {
      // Only the marker + a translated snapshot change: still a content change
      // a peer should see.
      $set.updatedAt = now;
    }

    let res: unknown;
    try {
      res = await filaments.updateOne(filter, { $set });
    } catch (err) {
      // A thrown write has an UNKNOWN outcome (Codex P2 r4 + r5 on PR #1228):
      // reconcile the pre-written drop record against the row, then the
      // failure propagates as before.
      if (droppedEntry) {
        await reconcileDropRecordAfterThrow(db, filaments, row._id, convertedTags ?? [], droppedEntry);
      }
      throw err;
    }
    if (!matched(res)) {
      if (droppedEntry) await unrecordDropped(db, droppedEntry);
      summary.skipped++;
      continue;
    }
    if (verdict.kind === "legacy") {
      summary.converted++;
      if (droppedEntry) summary.dropped.push(droppedEntry);
    } else {
      summary.verified++;
    }
  }

  if (summary.scanned > 0) {
    await recordRun(db, now, {
      scanned: summary.scanned,
      converted: summary.converted,
      verified: summary.verified,
      ambiguous: summary.ambiguous,
      skipped: summary.skipped,
    });
  }
  return summary;
}

/** One log line, or null when the pass found nothing to look at. */
export function describeRenumberSummary(s: OptTagRenumberSummary): string | null {
  if (s.scanned === 0) return null;
  const parts = [
    `converted ${s.converted}`,
    `verified ${s.verified}`,
    `awaiting review ${s.ambiguous}`,
  ];
  if (s.skipped > 0) parts.push(`skipped ${s.skipped} (concurrent edit — next pass)`);
  if (s.dropped.length > 0) {
    parts.push(
      `dropped legacy tags with no OpenPrintTag equivalent on ${s.dropped.length} filament(s): ` +
        s.dropped.map((d) => `${d.name || d.filamentId} [${d.tags.join(",")}]`).join("; "),
    );
  }
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
 * Every unmarked, non-purged filament the classifier cannot settle. Rows that
 * ARE settleable are not listed — call `renumberOptTags` first (the GET route
 * does) so a decisive row that arrived after startup (a share import, a
 * synced-down peer row) is marked rather than shown as pending.
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
 * reported as `changed` instead of being overwritten.
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
): Promise<OptTagResolveResult> {
  const filaments = db.collection("filaments");
  const row = await filaments.findOne({ _id: filamentId }, { projection: ROW_PROJECTION });
  if (!row) return { outcome: "not_found" };
  if (row.optTagsSpec === true) return { outcome: "changed" };
  const stored = Array.isArray(row.optTags) ? (row.optTags as unknown[]) : [];
  if (!sameOptTagSet(stored, expectedTags)) return { outcome: "changed" };

  const $set: Record<string, unknown> = { optTagsSpec: true, updatedAt: now, ...snapshotRemapSet(row) };
  let remapped: { tags: number[]; dropped: number[] } | null = null;
  let droppedEntry: DroppedLegacyTags | null = null;
  if (action === "convert") {
    remapped = remapLegacyOptTags(stored);
    $set.optTags = remapped.tags;
    if (remapped.dropped.length > 0) {
      droppedEntry = {
        filamentId: String(row._id),
        name: typeof row.name === "string" ? row.name : "",
        tags: remapped.dropped,
        at: now,
      };
      // Record first, convert second — same ordering as the pass.
      await recordDropped(db, droppedEntry);
    }
  }
  let res: unknown;
  try {
    res = await filaments.updateOne(
      { _id: row._id, optTags: stored, ...UNVERIFIED_OPT_TAGS_FILTER },
      { $set },
    );
  } catch (err) {
    // Same reconciliation as the pass (Codex P2 r4 + r5 on PR #1228).
    if (droppedEntry) {
      await reconcileDropRecordAfterThrow(db, filaments, row._id, remapped?.tags ?? [], droppedEntry);
    }
    throw err;
  }
  if (!matched(res)) {
    if (droppedEntry) await unrecordDropped(db, droppedEntry);
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
  return list.filter(
    (d): d is DroppedLegacyTags =>
      !!d && typeof d === "object" && typeof (d as DroppedLegacyTags).filamentId === "string",
  );
}

/** Clear the recorded drops once the user has read them. */
export async function dismissDroppedLegacyTags(db: MinimalRenumberDb): Promise<void> {
  await db
    .collection("_migrations")
    .updateOne({ _id: OPT_TAG_RENUMBER_MARKER_ID }, { $set: { dropped: [] } }, { upsert: true });
}

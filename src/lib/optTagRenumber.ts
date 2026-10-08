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
 *  - `trivial` / `spec` → mark it. Nothing to translate.
 *  - `legacy` → translate with `remapLegacyOptTags`, mark it, bump
 *    `updatedAt` so the change propagates by LWW to a peer that has not run
 *    the pass. Legacy concepts with no spec equivalent are dropped and
 *    RECORDED (in the `_migrations` document) so Data health can show the
 *    user what went away instead of losing it silently.
 *  - `ambiguous` / `inconsistent` → leave it unmarked. Data health lists it
 *    with both readings; `resolveOptTagNumbering` applies the user's answer.
 *
 * Every write is conditioned on the row still being unmarked and, for a
 * conversion, on `optTags` still holding the exact array that was classified —
 * a concurrent edit makes the write match nothing and the row is simply
 * revisited on the next pass (the #1021 posture).
 *
 * `openprinttagSnapshot.optTags` — what the OPT importer/re-sync last offered —
 * is in the legacy numbering by construction on every unmarked row, so it is
 * translated whenever the row is marked (by the pass OR by a Data health
 * resolution, whichever marks it). Residual: a row whose snapshot was
 * refreshed by a post-upgrade re-import BEFORE this pass first ran (only
 * possible if the pass failed transiently on first connect and an OPT import
 * ran in that window) would have a spec-numbered snapshot translated once
 * more; the snapshot only steers the re-sync dialog's adopt/conflict labels,
 * where the user still decides, so this is stated rather than guarded.
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
  type OptTagVerdict,
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

const ROW_PROJECTION = {
  optTags: 1,
  optTagsSpec: 1,
  name: 1,
  vendor: 1,
  type: 1,
  _deletedAt: 1,
  _purged: 1,
  "settings.openprinttag_slug": 1,
  "settings.openprinttag_uuid": 1,
  "openprinttagSnapshot.optTags": 1,
} as const;

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
  /** Already spec (or nothing to translate), marked. */
  verified: number;
  /** Left unmarked for Data health. */
  ambiguous: number;
  inconsistent: number;
  /** A conditional write matched nothing (concurrent edit) — next pass. */
  skipped: number;
  dropped: DroppedLegacyTags[];
}

function emptySummary(): OptTagRenumberSummary {
  return { scanned: 0, converted: 0, verified: 0, ambiguous: 0, inconsistent: 0, skipped: 0, dropped: [] };
}

/** `$set` fragment translating a legacy-numbered OPT snapshot, if the row has one. */
function snapshotRemapSet(row: Record<string, unknown>): Record<string, unknown> {
  const snap = (row.openprinttagSnapshot as { optTags?: unknown } | null | undefined)?.optTags;
  if (!Array.isArray(snap)) return {};
  return { "openprinttagSnapshot.optTags": remapLegacyOptTags(snap).tags };
}

function matched(res: unknown): boolean {
  const n = (res as { matchedCount?: number } | null | undefined)?.matchedCount;
  // A driver result always carries matchedCount; a test double may not — then
  // trust the write rather than counting a success as a skip.
  return n === undefined || n > 0;
}

async function recordRun(
  db: MinimalRenumberDb,
  now: Date,
  counts: Omit<OptTagRenumberSummary, "dropped">,
  dropped: DroppedLegacyTags[],
): Promise<void> {
  const update: Record<string, unknown> = { $set: { lastRunAt: now, lastRun: counts } };
  if (dropped.length > 0) update.$push = { dropped: { $each: dropped } };
  await db.collection("_migrations").updateOne({ _id: OPT_TAG_RENUMBER_MARKER_ID }, update, { upsert: true });
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
    if (verdict.kind === "ambiguous" || verdict.kind === "inconsistent") {
      summary[verdict.kind]++;
      continue;
    }

    const filter: Record<string, unknown> = { _id: row._id, ...UNVERIFIED_OPT_TAGS_FILTER };
    const snapSet = snapshotRemapSet(row);
    const $set: Record<string, unknown> = { optTagsSpec: true, ...snapSet };
    let dropped: number[] = [];

    if (verdict.kind === "legacy") {
      const stored = Array.isArray(row.optTags) ? (row.optTags as unknown[]) : [];
      const remapped = remapLegacyOptTags(stored);
      // Exact-array condition: a concurrent edit of the tags makes this match
      // nothing, and the row is reclassified on the next pass.
      filter.optTags = stored;
      $set.optTags = remapped.tags;
      $set.updatedAt = now;
      dropped = remapped.dropped;
    } else if (Object.keys(snapSet).length > 0) {
      // Only the marker + a translated snapshot change: still a content change
      // a peer should see.
      $set.updatedAt = now;
    }

    const res = await filaments.updateOne(filter, { $set });
    if (!matched(res)) {
      summary.skipped++;
      continue;
    }
    if (verdict.kind === "legacy") {
      summary.converted++;
      if (dropped.length > 0) {
        summary.dropped.push({
          filamentId: String(row._id),
          name: typeof row.name === "string" ? row.name : "",
          tags: dropped,
          at: now,
        });
      }
    } else {
      summary.verified++;
    }
  }

  if (summary.scanned > 0) {
    const { dropped, ...counts } = summary;
    await recordRun(db, now, counts, dropped);
  }
  return summary;
}

/** One log line, or null when the pass found nothing to look at. */
export function describeRenumberSummary(s: OptTagRenumberSummary): string | null {
  if (s.scanned === 0) return null;
  const parts = [
    `converted ${s.converted}`,
    `verified ${s.verified}`,
    `awaiting review ${s.ambiguous + s.inconsistent}`,
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
  verdict: Extract<OptTagVerdict, { kind: "ambiguous" | "inconsistent" }>["kind"];
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
    if (verdict.kind !== "ambiguous" && verdict.kind !== "inconsistent") continue;
    const readings = describeOptTagReadings(row.optTags as unknown[]);
    out.push({
      filamentId: String(row._id),
      name: typeof row.name === "string" ? row.name : "",
      vendor: typeof row.vendor === "string" ? row.vendor : null,
      type: typeof row.type === "string" ? row.type : null,
      trashed: row._deletedAt != null,
      verdict: verdict.kind,
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
  if (action === "convert") {
    remapped = remapLegacyOptTags(stored);
    $set.optTags = remapped.tags;
  }
  const res = await filaments.updateOne(
    { _id: row._id, optTags: stored, ...UNVERIFIED_OPT_TAGS_FILTER },
    { $set },
  );
  if (!matched(res)) return { outcome: "changed" };

  if (remapped) {
    if (remapped.dropped.length > 0) {
      await recordRun(
        db,
        now,
        { scanned: 1, converted: 1, verified: 0, ambiguous: 0, inconsistent: 0, skipped: 0 },
        [
          {
            filamentId: String(row._id),
            name: typeof row.name === "string" ? row.name : "",
            tags: remapped.dropped,
            at: now,
          },
        ],
      );
    }
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

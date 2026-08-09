/**
 * Formats a filament import's per-row skip reasons for display (GH #1115).
 *
 * `upsertImportRows` has always built a `skippedRows` list with genuinely
 * useful text — `Invalid color hex "red" (expected #RRGGBB)`,
 * `Missing required field(s): vendor, type`, `Parent "X" not found among
 * active filaments` — and both import routes have always returned it. Nothing
 * ever rendered it: the user saw a bare count and had no way to learn which
 * rows failed or why. The sibling SPOOL importer does show a per-row table, so
 * the omission was inconsistent as well as unhelpful.
 *
 * Pure and string-only because the repo has no React test harness (the vitest
 * env is node, with no jsdom — see `vitest.config.ts`). Keeping the formatting
 * here makes it coverage-gated and lets the two call sites stay dumb.
 */

/** One row the importer refused, as returned by `upsertImportRows`. */
export interface SkippedRowLike {
  row: number;
  name?: string | null;
  reason: string;
}

/**
 * How many rows to name before collapsing the rest into a count.
 *
 * Matches the bulk-delete failure list on the filaments page, which uses the
 * same acknowledge-only dialog. The cap is load-bearing there and here: the
 * dialog's message paragraph wraps but does not scroll, so an uncapped list
 * from a 200-row import would run off the bottom.
 */
export const MAX_SHOWN_SKIPPED = 10;

export interface SkipReportStrings {
  /** e.g. `row 7 — Prusament PLA: Missing required field(s): vendor` */
  row: (args: { row: number; name: string; reason: string }) => string;
  /** e.g. `…and 4 more` */
  overflow: (count: number) => string;
}

/**
 * Build the dialog body, or `null` when there is nothing to report.
 *
 * `notes` are the GH #605 non-fatal per-row notes (`result.errors`) — rows that
 * DID import but had something stripped. They were equally invisible, and they
 * belong in the same place: both answer "what happened to my rows?".
 */
export function formatSkipReport(
  skipped: readonly SkippedRowLike[] | undefined,
  notes: readonly string[] | undefined,
  strings: SkipReportStrings,
): string | null {
  const rows = skipped ?? [];
  const extra = notes ?? [];
  if (rows.length === 0 && extra.length === 0) return null;

  const lines = rows
    .slice(0, MAX_SHOWN_SKIPPED)
    .map((r) =>
      strings.row({
        row: r.row,
        // A row can fail BEFORE its name is known (a missing Name column is
        // itself a skip reason), so never interpolate a bare undefined.
        name: (r.name ?? "").trim(),
        reason: r.reason,
      }),
    );

  if (rows.length > MAX_SHOWN_SKIPPED) {
    lines.push(strings.overflow(rows.length - MAX_SHOWN_SKIPPED));
  }

  // Notes are capped on the same budget. "At most a handful" was wrong: a bulk
  // update touching many templates emits one note PER ROW, up to the route's
  // 10,000-row limit — and ConfirmDialog's body neither scrolls nor bounds its
  // height, so an uncapped list would push the Close button off-screen (Codex
  // P2). The two lists share one budget so the dialog is bounded overall, not
  // per-section.
  const noteBudget = Math.max(0, MAX_SHOWN_SKIPPED - lines.length);
  lines.push(...extra.slice(0, noteBudget));
  if (extra.length > noteBudget) {
    lines.push(strings.overflow(extra.length - noteBudget));
  }

  return lines.join("\n");
}

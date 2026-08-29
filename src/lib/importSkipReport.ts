/**
 * Formats a filament import's per-row skip reasons for display (GH #1115).
 * Pure and string-only because the repo has no React test harness (the vitest
 * env is node, no jsdom) — keeping the formatting here makes it
 * coverage-gated and lets the two call sites stay dumb.
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

/**
 * Per-fragment character cap. The entry cap bounds how many LINES the dialog
 * gets, not how long they are — a skip reason interpolates the offending
 * cell verbatim, and a single cell may be close to the route's ~10 MB upload
 * limit; ten such lines would put Close out of reach in a dialog that
 * neither scrolls nor bounds its height. 160 is comfortably above every
 * reason the importer actually composes.
 */
export const MAX_FRAGMENT_CHARS = 160;

/**
 * Collapse a fragment to a single line, then clip it to the cap.
 *
 * The flattening is not cosmetic: a CSV field may contain literal newlines
 * (that is what quoting is FOR, and `parseCsv` preserves them), and
 * `ConfirmDialog` renders with `whitespace-pre-wrap`, unbounded in height —
 * 160 characters of `\n` is 160 RENDERED LINES. Every Unicode line
 * terminator is folded, not just `\n`, since `pre-wrap` breaks on
 * U+2028/U+2029 too.
 *
 * Order is load-bearing: fold FIRST, then clip. Clipping first would leave
 * whatever line breaks survived inside the kept 160 characters.
 */
function clip(text: string): string {
  const flat = text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  return flat.length > MAX_FRAGMENT_CHARS
    ? `${flat.slice(0, MAX_FRAGMENT_CHARS)}…`
    : flat;
}

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
        name: clip((r.name ?? "").trim()),
        reason: clip(r.reason),
      }),
    );

  if (rows.length > MAX_SHOWN_SKIPPED) {
    lines.push(strings.overflow(rows.length - MAX_SHOWN_SKIPPED));
  }

  // Notes are capped on the same budget: a bulk update touching many
  // templates emits one note PER ROW, up to the route's 10,000-row limit.
  // The two lists share one budget so the dialog is bounded overall, not
  // per-section.
  const noteBudget = Math.max(0, MAX_SHOWN_SKIPPED - lines.length);
  lines.push(...extra.slice(0, noteBudget).map(clip));
  if (extra.length > noteBudget) {
    lines.push(strings.overflow(extra.length - noteBudget));
  }

  return lines.join("\n");
}

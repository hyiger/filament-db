/**
 * Shared rules for the /compare selection, so the client page and the API
 * route agree on the cap instead of each hard-coding `8` (GH #1109).
 * Deliberately free of Node and DOM APIs: imported by both a `"use client"`
 * page and a route handler.
 */

/**
 * Maximum filaments in one comparison. Enforced by the API (a wider set makes
 * the table unreadable and the query unbounded); the client caps to match so
 * an over-long link degrades to a truncated comparison rather than an error.
 */
export const MAX_COMPARE_FILAMENTS = 8;

export interface ParsedCompareIds {
  /** The ids to compare, deduped and capped. */
  ids: string[];
  /**
   * How many ids the input carried beyond the cap. Drives the "showing the
   * first N" notice — the user pasted a link and needs to know it was
   * truncated, otherwise the missing columns read as data loss.
   */
  dropped: number;
}

/**
 * Parse a `?ids=` query value into a bounded, duplicate-free selection.
 *
 * Duplicates are removed BEFORE the cap so `a,a,b` yields two filaments rather
 * than spending two of the eight slots on the same one. They also used to
 * produce repeated React keys and identical columns in the table.
 */
export function parseCompareIds(raw: string | null | undefined): ParsedCompareIds {
  const unique = Array.from(
    new Set(
      (raw || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
  return {
    ids: unique.slice(0, MAX_COMPARE_FILAMENTS),
    dropped: Math.max(0, unique.length - MAX_COMPARE_FILAMENTS),
  };
}

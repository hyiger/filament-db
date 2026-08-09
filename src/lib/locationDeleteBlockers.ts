/**
 * Explains why a location can't be deleted (GH #1106).
 *
 * The delete guard refuses while ANY non-purged filament still has a spool at
 * the location. The `/locations` list, meanwhile, counted only spools that are
 * both non-retired AND on an active filament. So two whole buckets of blocking
 * spools were invisible on the page that offers the Delete button:
 *
 *   1. retired spools on active filaments — hidden from /inventory unless the
 *      "Include retired" pref is on;
 *   2. spools on trashed (non-purged) filaments — unreachable from /inventory
 *      at ANY setting, because that aggregation matches `_deletedAt: null`.
 *
 * The result was a row reading "Spools 0" that refused to delete and told the
 * user to reassign spools the same page insisted did not exist.
 *
 * The blocking PREDICATE is deliberately unchanged — excluding retired spools
 * from it would delete the location out from under them and leave a dangling
 * `locationId`. What changes is that the app stops contradicting itself before
 * the click, and says something actionable after it.
 *
 * Pure so the summary + message are unit-testable; the route supplies the
 * per-filament rows.
 */

/** How many filament names to name before falling back to "and N more". */
export const MAX_NAMED_BLOCKERS = 5;

/** One filament holding at least one spool at the location being deleted. */
export interface LocationBlockerDoc {
  name?: string | null;
  /** Soft-deleted (in the trash) but not purged. */
  trashed: boolean;
  activeSpoolsHere: number;
  retiredSpoolsHere: number;
}

export interface LocationDeleteBlockers {
  blocked: boolean;
  /** Non-retired spools here, on active filaments. */
  activeSpools: number;
  /** Retired spools here, on active filaments — the #1106 invisible bucket. */
  retiredSpools: number;
  /** Spools here on trashed filaments, retired or not — invisible everywhere. */
  trashedSpools: number;
  activeFilaments: number;
  trashedFilaments: number;
  /** Up to MAX_NAMED_BLOCKERS active filament names, for the UI. */
  filamentNames: string[];
  /** Up to MAX_NAMED_BLOCKERS trashed filament names. */
  trashedFilamentNames: string[];
  /** Blocking filaments beyond the names emitted, across both buckets. */
  moreFilaments: number;
}

const UNNAMED = "(unnamed)";

export function summarizeLocationBlockers(
  docs: readonly LocationBlockerDoc[],
): LocationDeleteBlockers {
  let activeSpools = 0;
  let retiredSpools = 0;
  let trashedSpools = 0;
  const filamentNames: string[] = [];
  const trashedFilamentNames: string[] = [];
  let activeFilaments = 0;
  let trashedFilaments = 0;

  for (const d of docs) {
    const here = (d.activeSpoolsHere || 0) + (d.retiredSpoolsHere || 0);
    // A row with no spool at this location isn't a blocker. The route's
    // aggregation shouldn't emit one, but a caller passing a wider set
    // shouldn't get a phantom blocker out of it.
    if (here <= 0) continue;
    const name = (d.name || "").trim() || UNNAMED;
    if (d.trashed) {
      trashedFilaments++;
      trashedSpools += here;
      if (trashedFilamentNames.length < MAX_NAMED_BLOCKERS) trashedFilamentNames.push(name);
    } else {
      activeFilaments++;
      activeSpools += d.activeSpoolsHere || 0;
      retiredSpools += d.retiredSpoolsHere || 0;
      if (filamentNames.length < MAX_NAMED_BLOCKERS) filamentNames.push(name);
    }
  }

  const named = filamentNames.length + trashedFilamentNames.length;
  return {
    blocked: activeFilaments + trashedFilaments > 0,
    activeSpools,
    retiredSpools,
    trashedSpools,
    activeFilaments,
    trashedFilaments,
    filamentNames,
    trashedFilamentNames,
    moreFilaments: Math.max(0, activeFilaments + trashedFilaments - named),
  };
}

/**
 * English `error` string for the response body.
 *
 * This is the fallback a non-browser client (curl, a script) sees; the web UI
 * renders the structured fields instead. Two substrings are pinned by
 * `tests/locations-route.test.ts` and must survive any rewording: "referenced
 * by spools" whenever anything blocks, and "trash" whenever a trashed filament
 * is among the blockers.
 */
export function locationBlockerMessage(s: LocationDeleteBlockers): string {
  const filaments = s.activeFilaments + s.trashedFilaments;
  const parts = [
    `Cannot delete this location — it is referenced by spools in ${filaments} filament(s).`,
  ];
  if (s.retiredSpools > 0) {
    parts.push(
      `${s.retiredSpools} of those spool(s) are retired, so they are hidden from Inventory unless "Include retired" is on.`,
    );
  }
  if (s.trashedFilaments > 0) {
    parts.push(
      `${s.trashedFilaments} filament(s) in the trash also have spools here — restore and reassign them, or permanently delete them.`,
    );
  }
  parts.push("Reassign those spools to another location first.");
  return parts.join(" ");
}

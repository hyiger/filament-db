/**
 * The two list pages' URL filter specs, and the preference keys each one
 * persists (GH #1141).
 *
 * These lived in the page files, which `vitest.config.ts` cannot exercise —
 * it runs `environment: "node"` with no jsdom. Moving the pure data here puts
 * two invariants under the coverage gate that nothing else can check:
 *
 *  1. every persisted key is marked `sticky`, so its absence from a URL is
 *     unambiguous (see `FilterParamSpec.sticky`); and
 *  2. no sticky key's fallback serializes to the empty string, which the
 *     serializer's delete branch would silently un-stick.
 *
 * Both are the kind of thing a future preference would break quietly.
 */

import {
  oneOf,
  boolParam,
  textParam,
  exactTextParam,
  type FilterSpec,
} from "@/lib/listFilterParams";
import { KNOWN_LOCATION_KINDS } from "@/lib/locationKind";
import {
  INVENTORY_GROUP_BYS,
  INVENTORY_SORT_KEYS,
  INVENTORY_SORT_DIRS,
  type InventoryGroupBy,
  type InventorySortKey,
  type InventorySortDir,
} from "@/lib/inventorySort";
import { SORT_KEYS, SORT_DIRS, type SortKey, type SortDir } from "@/lib/sortFilamentList";
import { QUICK_FILTERS, type QuickFilter } from "@/components/QuickFilterChips";

/**
 * Parse a stored preference blob, tolerating corruption (GH #1141, Codex P2).
 *
 * The persist effects READ the stored blob before writing, so they can merge
 * per-key over it. Parsing it inline inside their catch-everything try meant a
 * corrupt blob threw at the parse and skipped the `setItem` — so nothing ever
 * OVERWROTE the bad value, and persistence was dead until the user cleared
 * storage by hand. The load path already tolerated corruption; the write path
 * choked on it, which is backwards: the write is the one chance to heal.
 *
 * Returns `{}` for anything that is not a plain JSON object — null, corrupt
 * text, `"42"`, arrays (spreading an array yields index keys, not prefs) — so
 * the caller merges against defaults and the next write replaces the blob.
 */
export function parseStoredPrefs(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ home */

/** #831: persisted sort for the filament list. */
export const HOME_PREFS_KEY = "filamentdb-home-prefs";

export interface HomePrefs {
  sortKey: SortKey;
  sortDir: SortDir;
}

export const DEFAULT_HOME_PREFS: HomePrefs = { sortKey: "name", sortDir: "asc" };

/** The keys the home page writes to `localStorage`. Must equal its sticky set. */
export const HOME_PERSISTED_KEYS = ["sortKey", "sortDir"] as const;

export const HOME_FILTER_SPEC = {
  search: { param: "q", fallback: "", ...textParam },
  // Exact keys into stored data, NOT trimmed — the schema does not trim
  // type/vendor and the API compares them with $eq, so a stored "PLA " must
  // round-trip byte-exact (Codex P2). Search stays `textParam`: it is a
  // substring query whose live value the debounce canonicalizes the same way.
  typeFilter: { param: "type", fallback: "", ...exactTextParam },
  vendorFilter: { param: "vendor", fallback: "", ...exactTextParam },
  quickFilter: { param: "quick", fallback: "all" as QuickFilter, parse: oneOf(QUICK_FILTERS) },
  showOutOfStock: { param: "oos", fallback: false, ...boolParam },
  sortKey: {
    param: "sort",
    fallback: DEFAULT_HOME_PREFS.sortKey,
    parse: oneOf(SORT_KEYS),
    sticky: true,
  },
  sortDir: {
    param: "dir",
    fallback: DEFAULT_HOME_PREFS.sortDir,
    parse: oneOf(SORT_DIRS),
    sticky: true,
  },
} satisfies FilterSpec;

/* ------------------------------------------------------------- inventory */

/**
 * GH #795 — persisted group/sort/filter prefs. A single JSON blob avoids key
 * sprawl; unknown enum values fall back to the default so a corrupt or old
 * blob cannot wedge the page. `includeRetired` rides along since it also
 * drives the server query.
 */
export const INVENTORY_PREFS_KEY = "filamentdb-inventory-prefs";

export interface InventoryPrefs {
  groupBy: InventoryGroupBy;
  sortKey: InventorySortKey;
  sortDir: InventorySortDir;
  includeRetired: boolean;
}

export const DEFAULT_INVENTORY_PREFS: InventoryPrefs = {
  groupBy: "location",
  // #795: default to remaining-weight ascending — surfaces near-empty spools
  // to reorder, the issue's primary use case.
  sortKey: "remaining",
  sortDir: "asc",
  includeRetired: false,
};

/** The keys /inventory writes to `localStorage`. Must equal its sticky set. */
export const INVENTORY_PERSISTED_KEYS = [
  "groupBy",
  "sortKey",
  "sortDir",
  "includeRetired",
] as const;

export const INVENTORY_FILTER_SPEC = {
  search: { param: "q", fallback: "", ...textParam },
  // Validated against the SELECTABLE kinds (Codex P2), not free text. The
  // select renders exactly these five options, so a stale or hand-typed
  // `?kind=garage` would leave React displaying "All kinds" while the hidden
  // state kept filtering — and re-choosing the option already shown may emit
  // no change event, so the filter would be invisible AND unclearable.
  kind: { param: "kind", fallback: "", parse: oneOf(["", ...KNOWN_LOCATION_KINDS]) },
  // Exact keys, untrimmed — see the home spec's twin comment (Codex P2).
  type: { param: "type", fallback: "", ...exactTextParam },
  vendor: { param: "vendor", fallback: "", ...exactTextParam },
  includeRetired: {
    param: "includeRetired",
    fallback: DEFAULT_INVENTORY_PREFS.includeRetired,
    ...boolParam,
    sticky: true,
  },
  groupBy: {
    param: "group",
    fallback: DEFAULT_INVENTORY_PREFS.groupBy,
    parse: oneOf(INVENTORY_GROUP_BYS),
    sticky: true,
  },
  sortKey: {
    param: "sort",
    fallback: DEFAULT_INVENTORY_PREFS.sortKey,
    parse: oneOf(INVENTORY_SORT_KEYS),
    sticky: true,
  },
  sortDir: {
    param: "dir",
    fallback: DEFAULT_INVENTORY_PREFS.sortDir,
    parse: oneOf(INVENTORY_SORT_DIRS),
    sticky: true,
  },
} satisfies FilterSpec;

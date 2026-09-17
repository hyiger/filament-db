/**
 * Which rows the home filament list shows, and the color-facet chip counts
 * derived from that SAME decision.
 *
 * The decision used to live inline in `src/app/page.tsx`'s `visibleFilaments`
 * memo. `vitest.config.ts` runs `environment: "node"` with no jsdom, so the
 * page is untestable — and the color facet needs a per-chip count that must
 * equal the rows clicking that chip renders. Two copies of the rule (one in
 * the page, one behind the counts) would drift, so the rule moved here and
 * both call it. The behaviour with no color selected is a byte-for-byte port
 * of the page's memo; the tests pin #712, #847, #552/#1107 and the
 * parent-in-stock rule as regression guards for the move.
 */

import type { QuickFilter } from "@/components/QuickFilterChips";
import { getRemainingGrams, getSpoolCount, type InventorySpool } from "./inventoryStats";
import { BLANK_COLOR_HEX } from "./cssNamedColors";
import {
  COLOR_FACET_VALUES,
  matchesColorFacet,
  type ColorFacetInput,
  scopeByColorFacet,
  type ColorClassifiable,
  type ColorFacet,
} from "./colorFamily";

/** The fields of a home-list row (`FilamentSummary`) the visibility rule reads. */
export interface HomeListRow extends ColorClassifiable {
  _id: string;
  parentId?: string | null;
  hasVariants?: boolean;
  spools?: InventorySpool[];
  totalWeight: number | null;
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  lowStockThreshold?: number | null;
  hasCalibrations?: boolean;
}

export interface HomeVisibilityOptions {
  quickFilter: QuickFilter;
  showOutOfStock: boolean;
  /** A server-side search/type/vendor filter shaped the fetched list. */
  serverFilterActive: boolean;
  /** A color facet scoped the list (client-side, over the full fetch). */
  colorActive: boolean;
  /** The active facet. When given with `colorActive`, a row that doesn't
   *  match it (a parent riding along as a group header) is kept only while
   *  it heads a visible matching row — see `dropOrphanedColorRiders`. */
  colorFacet?: ColorFacetInput;
}

/**
 * Under a color facet, `scopeByColorFacet` keeps a non-matching parent only
 * as the header of its matching variants. The stock/quick filters can then
 * drop every such variant while keeping the parent — a pre-#605 legacy parent
 * holding its OWN spools is in stock on its own — and the list would render
 * it as a standalone, non-matching row under a chip that counts 0 (and
 * suppress the color empty state). Drop such orphaned riders.
 */
function dropOrphanedColorRiders<F extends HomeListRow>(
  rows: F[],
  facet: ColorFacetInput,
): F[] {
  const headed = new Set<string>();
  for (const f of rows) if (f.parentId) headed.add(f.parentId);
  return rows.filter((f) => headed.has(f._id) || matchesColorFacet(f, facet));
}

/** Remaining grams below the row's own threshold. Unset/zero threshold, or a
 *  row with no computable grams, is never low. */
export function isLowStock(f: HomeListRow): boolean {
  const threshold = f.lowStockThreshold;
  if (!threshold || threshold <= 0) return false;
  const remaining = getRemainingGrams(f);
  return remaining !== null && remaining < threshold;
}

/**
 * "In stock" = at least one active (non-retired) spool, legacy single-spool
 * rolls included (`getSpoolCount`). Parents own no spools, so a parent counts
 * as in stock when ANY of its variants in `list` is — otherwise hiding
 * out-of-stock would drop a parent whose variants are fully stocked.
 *
 * Resolved against `list`, so under a color facet a template is in stock only
 * through its MATCHING variants: a family appears only if a matching variant
 * is in stock.
 */
export function inStockPredicate<F extends HomeListRow>(list: readonly F[]): (f: F) => boolean {
  const parentsWithStock = new Set<string>();
  for (const f of list) {
    if (f.parentId && getSpoolCount(f) > 0) parentsWithStock.add(f.parentId);
  }
  return (f) => getSpoolCount(f) > 0 || parentsWithStock.has(f._id);
}

/**
 * The rows the list renders at the top level (before grouping), given the
 * fetched list — already color-scoped by the caller when a color is active.
 */
export function computeVisibleFilaments<F extends HomeListRow>(
  filaments: F[],
  opts: HomeVisibilityOptions,
): F[] {
  const visible = computeVisibleUnpruned(filaments, opts);
  // An unfiltered pass-through (same reference) keeps every matching row, so
  // no rider can be orphaned — skip the pass and keep the identity.
  if (!opts.colorActive || opts.colorFacet == null || opts.colorFacet === "" || visible === filaments) {
    return visible;
  }
  return dropOrphanedColorRiders(visible, opts.colorFacet);
}

function computeVisibleUnpruned<F extends HomeListRow>(
  filaments: F[],
  opts: HomeVisibilityOptions,
): F[] {
  const { quickFilter, showOutOfStock, serverFilterActive, colorActive } = opts;
  // The "all" view keeps parents in the dataset so the list renders them as
  // grouping headers above their color variants. By default it hides
  // out-of-stock filaments; the toggle reveals them. The hide runs ONLY when
  // no server-side filter is active: search/type/vendor can return a parent
  // WITHOUT its (stocked) variants — the in-stock set would then miss it and
  // wrongly hide the family. While such a filter is active, show every match
  // in or out of stock (#712).
  //
  // A color facet does NOT lift the hide: it is applied client-side over the
  // FULL fetched list, so #712's incomplete-family reason doesn't apply, and
  // "what orange do I have" means in-stock orange by default.
  if (quickFilter === "all") {
    if (showOutOfStock || serverFilterActive) return filaments;
    const inStockList = filaments.filter(inStockPredicate(filaments));
    // #847: don't let the default out-of-stock hide empty the unfiltered
    // "All" view — a catalog with nothing in stock would otherwise render
    // "No filaments match" under "All (N)". Skipped under a color: an empty
    // in-stock orange is the ANSWER, and the empty state offers the
    // out-of-stock reveal instead of silently showing it.
    if (inStockList.length === 0 && !colorActive) return filaments;
    return inStockList;
  }
  // "Has spools" resolves against the full list (parents included) and MUST
  // use the same predicate as its chip badge, or the two disagree by
  // construction (#552). GH #1107: `getSpoolCount`, never a raw
  // `spools.length` — that excludes legacy rolls and includes retired-only
  // filaments.
  if (quickFilter === "hasSpools") {
    return filaments.filter((f) => getSpoolCount(f) > 0);
  }
  // Every other filter resolves against the inventory rows (templates are
  // grouping headers, not rolls) — otherwise the chip badge, counted over
  // inventory rows, disagrees with the rendered count whenever a parent
  // happens to match the criterion.
  return filaments.filter((f) => {
    if (f.hasVariants) return false;
    // Only lowStock / noCalibration reach here (QUICK_FILTERS is closed).
    return quickFilter === "lowStock" ? isLowStock(f) : !f.hasCalibrations;
  });
}

/**
 * Inventory rows hidden by the default out-of-stock hide — the "Show out of
 * stock" toggle's badge on the no-color view. Parents are grouping headers
 * (not stock). A variant of a STOCKED family is always rendered under its
 * parent there (#786), so it isn't "hidden" even with no spool of its own —
 * only standalone rows and variants of a fully-out-of-stock family are.
 * (Under a color facet groups carry only visible variants, so the page uses
 * `colorFacetCounts(...).hidden` for the badge instead.)
 */
export function countOutOfStockHidden<F extends HomeListRow>(filaments: F[]): number {
  const inStock = inStockPredicate(filaments);
  const shownParents = new Set(
    filaments.filter((f) => f.hasVariants && inStock(f)).map((f) => f._id),
  );
  return filaments.filter((f) => {
    if (f.hasVariants) return false;
    if (getSpoolCount(f) > 0) return false;
    if (f.parentId && shownParents.has(f.parentId)) return false;
    return true;
  }).length;
}

export interface ColorFacetCount {
  /** Matching rows the list would render with this facet active. */
  shown: number;
  /** Matching rows the default out-of-stock hide keeps off-screen — counted
   *  whether or not the hide is currently on, so the page's toggle (whose
   *  badge this drives) doesn't vanish the moment it is switched on. 0 when
   *  the hide doesn't apply (a quick filter or server filter is active). */
  hidden: number;
}

export type ColorFacetCountOptions = Omit<HomeVisibilityOptions, "colorActive">;

/**
 * Per `COLOR_FACET_VALUES` entry: how many filaments clicking that chip shows,
 * and how many more the out-of-stock toggle reveals.
 *
 * Counts MATCHING rows (never templates, which only ride along as group
 * headers), computed by running the real `scopeByColorFacet` +
 * `computeVisibleFilaments` pipeline — so a chip's number can't disagree with
 * its rows. A filament can match several facets (additive membership), so
 * the family counts add up to more than the library.
 */
export function colorFacetCounts<F extends HomeListRow & { _id: string }>(
  fetched: F[],
  opts: ColorFacetCountOptions,
): Record<ColorFacet, ColorFacetCount> {
  const out = {} as Record<ColorFacet, ColorFacetCount>;
  for (const facet of COLOR_FACET_VALUES) {
    const scoped = scopeByColorFacet(fetched, facet);
    if (scoped.length === 0) {
      out[facet] = { shown: 0, hidden: 0 };
      continue;
    }
    const matching = (showOutOfStock: boolean) =>
      computeVisibleFilaments(scoped, {
        ...opts,
        showOutOfStock,
        colorActive: true,
        colorFacet: facet,
      }).filter((f) =>
        matchesColorFacet(f, facet),
      ).length;
    const withHide = matching(false);
    const withoutHide = matching(true);
    out[facet] = {
      shown: opts.showOutOfStock ? withoutHide : withHide,
      hidden: withoutHide - withHide,
    };
  }
  return out;
}

/**
 * Rows in `rows` whose swatch is the app's blank default gray (#808080) —
 * the classifier files those under No color unless the name says gray, and
 * the facet UI says so rather than leaving a "gray" dot unexplained.
 */
export function countBlankDefaultColor(rows: readonly ColorClassifiable[]): number {
  return rows.filter(
    (f) => typeof f.color === "string" && f.color.trim().toUpperCase() === BLANK_COLOR_HEX,
  ).length;
}

/**
 * Per-row form of the visibility rule for a row MATCHING an active color
 * facet — the predicate `relaxColorQuery`'s suggestion counts take, so a
 * "Try Gray · Dark (3)" button promises exactly the rows it shows. Exact for
 * matching rows because a matching row is never a template: its stock is its
 * own, so the family-level in-stock set never changes its answer.
 */
export function colorRowVisible(
  f: HomeListRow,
  opts: ColorFacetCountOptions,
): boolean {
  const { quickFilter, showOutOfStock, serverFilterActive } = opts;
  if (quickFilter === "all") {
    return showOutOfStock || serverFilterActive || getSpoolCount(f) > 0;
  }
  if (quickFilter === "hasSpools") return getSpoolCount(f) > 0;
  if (f.hasVariants) return false;
  if (quickFilter === "lowStock") return isLowStock(f);
  return !f.hasCalibrations;
}

/**
 * Group filaments into parent families + standalone rows for the main list.
 *
 * The crux (GH #744 / #786): a parent's "N colors" chip and the variant
 * rows/swatches rendered under it MUST come from the same set, or they drift
 * (#712's out-of-stock filter removes rows from `visibleFilaments`, so a chip
 * counted from the full list over-counts the variants displayed). A shown
 * parent's group therefore carries ALL of its variants from `allFilaments`,
 * and the chip renders `group.variants.length` — the count and the displayed
 * variants are the SAME array. `visibleFilaments` still decides which
 * TOP-LEVEL rows appear, so a fully-out-of-stock family stays hidden.
 */
export interface VariantGroup<F> {
  parent: F;
  variants: F[];
}

export interface GroupResult<F> {
  groups: VariantGroup<F>[];
  standalone: F[];
}

type Groupable = { _id: string; parentId?: string | null };

export function buildFilamentGroups<F extends Groupable>(
  /** The full fetched list (server-filtered when a search/type/vendor filter
   *  is active). Source of truth for a shown family's variants + the chip. */
  allFilaments: F[],
  /** The post-filter set that decides which top-level rows are shown. */
  visibleFilaments: F[],
  opts: {
    /** Apply parent→variant field inheritance for display. Identity by default. */
    enrichVariant?: (variant: F, parent: F | undefined) => F;
    /** Parent lookup for enriching orphaned variants whose parent row was
     *  filtered out of `visibleFilaments`. */
    parentLookup?: Map<string, F>;
  } = {},
): GroupResult<F> {
  const enrich = opts.enrichVariant ?? ((v) => v);
  const parentLookup = opts.parentLookup;

  // Every variant of each parent, from the full set — this is exactly the set
  // the chip counts, so a rendered group must match it one-for-one.
  const allVariantsByParent = new Map<string, F[]>();
  for (const f of allFilaments) {
    if (f.parentId) {
      const arr = allVariantsByParent.get(f.parentId);
      if (arr) arr.push(f);
      else allVariantsByParent.set(f.parentId, [f]);
    }
  }

  const groups: VariantGroup<F>[] = [];
  const groupedParentIds = new Set<string>();
  const standalone: F[] = [];

  // A visible non-variant row becomes a group iff the FULL set has variants for
  // it; the group then carries every one of them (in- and out-of-stock alike).
  for (const f of visibleFilaments) {
    if (f.parentId) continue; // variants handled via their parent
    const variants = allVariantsByParent.get(f._id);
    if (variants && variants.length > 0) {
      groups.push({ parent: f, variants: variants.map((v) => enrich(v, f)) });
      groupedParentIds.add(f._id);
    } else {
      standalone.push(f);
    }
  }

  // Orphaned variants: a visible variant whose parent is NOT a shown group
  // (e.g. the parent was filtered out server-side). Render it standalone, still
  // enriched from its (possibly-hidden) parent so inherited fields resolve.
  for (const f of visibleFilaments) {
    if (!f.parentId) continue;
    if (groupedParentIds.has(f.parentId)) continue; // already inside its group
    standalone.push(enrich(f, parentLookup?.get(f.parentId)));
  }

  return { groups, standalone };
}

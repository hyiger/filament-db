"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Suspense } from "react";
import SearchParamsSync from "@/components/SearchParamsSync";
import {
  parseFilterParams,
  presentFilterKeys,
  nextFilterHref,
  seedFilterState,
  queryStringOf,
  withCurrentValue,
} from "@/lib/listFilterParams";
import {
  parseStoredPrefs,
  INVENTORY_FILTER_SPEC,
  INVENTORY_PREFS_KEY,
  INVENTORY_PERSISTED_KEYS,
  DEFAULT_INVENTORY_PREFS,
  type InventoryPrefs,
} from "@/lib/listFilterSpecs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useDateFormat } from "@/hooks/useDateFormat";
import { Skeleton, SkeletonRegion } from "@/components/Skeleton";
import {
  groupAndSortInventory,
  summarizeInventoryGroups,
  INVENTORY_NO_GROUP_KEY,
  type InventoryGroupBy,
  type InventorySortKey,
  type InventorySortDir,
  INVENTORY_GROUP_BYS,
  INVENTORY_SORT_KEYS,
} from "@/lib/inventorySort";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { isKnownLocationKind } from "@/lib/locationKind";
import { parseWeightInput, type WeightInputProblem } from "@/lib/parseWeightInput";
import FilamentSwatch from "@/components/FilamentSwatch";
import { deriveArrangement } from "@/lib/filamentColors";
import { deriveFinish } from "@/lib/filamentFinish";
import { withReturnTo } from "@/lib/returnTo";

// Loaded on demand — the dialog pulls in the TSPL emitter + the qrcode
// package for its preview, none of which the page needs until a print is
// actually requested.
const PrintDryBoxLabelDialog = dynamic(
  () => import("@/components/PrintDryBoxLabelDialog"),
  { ssr: false },
);

/**
 * Spool Inventory page — the counterpart to the filament list (/): where
 * that list groups spools UNDER their filament, this page groups filaments
 * under their LOCATION.
 *
 * Data comes from `/api/spools/by-location` (server-side aggregation with
 * parent inheritance hints for the % remaining math). Inline edits hit the
 * existing `PUT /api/filaments/{id}/spools/{spoolId}` endpoint.
 */

interface SpoolRow {
  _id: string;
  /** The durable per-spool id, surfaced read-only here. */
  instanceId?: string;
  /** The spool's current location, so the move-to dropdown pre-selects it. */
  locationId: string | null;
  label: string;
  totalWeight: number | null;
  lotNumber: string | null;
  purchaseDate: string | null;
  openedDate: string | null;
  retired: boolean;
  /** GH #429: not in the by-location aggregation payload — per-row data
   * URLs could push the response into the megabytes range. Kept optional
   * in the type so a future row-expand can lazy-load it. */
  photoDataUrl?: string | null;
  dryCycleCount: number;
  lastDryAt: string | null;
  filamentId: string;
  filamentName: string;
  filamentVendor: string;
  filamentType: string;
  /** Raw variant primary — null for coextruded filaments, whose colors
   * live in `secondaryColors`. Don't coalesce to a gray before handing it
   * to FilamentSwatch; the swatch's own secondaryColors fallback handles
   * the null-primary case (GH #1050). */
  filamentColor: string | null;
  /** Effective (parent-fallback) color arrays from the aggregation.
   * Optional so a stale client cache of the pre-#1050 payload shape
   * doesn't explode. */
  secondaryColors?: string[];
  optTags?: number[];
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  parentSpoolWeight: number | null;
  parentNetFilamentWeight: number | null;
  /** GH #783: a synthetic row for a legacy single-spool filament (no real
   * spools[] subdoc). Rendered read-only — its inline edit/move/retire routes
   * would 404 since they match on spools._id. */
  legacySingleSpool?: boolean;
}

interface Group {
  locationId: string | null;
  location: {
    _id: string;
    name: string;
    kind: string;
    humidity: number | null;
    /** ISO string over the wire; drives the dry-box label's
     *  "DESICCANT CHANGED" line. */
    desiccantChangedAt: string | null;
    notes: string;
  } | null;
  spools: SpoolRow[];
  count: number;
  totalGrams: number;
}

interface InventoryResponse {
  groups: Group[];
  totalSpools: number;
}

interface LocationOption {
  _id: string;
  name: string;
  kind: string;
}

/** Effective spool/net weights with parent inheritance. */
function effectiveWeights(row: SpoolRow): { tare: number | null; net: number | null } {
  return {
    tare: row.spoolWeight ?? row.parentSpoolWeight ?? null,
    net: row.netFilamentWeight ?? row.parentNetFilamentWeight ?? null,
  };
}

/** Grams of filament remaining on this spool, or null if uncomputable. */
function remainingGrams(row: SpoolRow): number | null {
  const { tare } = effectiveWeights(row);
  if (tare == null || row.totalWeight == null) return null;
  return Math.max(0, row.totalWeight - tare);
}

/** Integer 0–100 percent remaining, or null if uncomputable. */
function remainingPct(row: SpoolRow): number | null {
  const { tare, net } = effectiveWeights(row);
  if (tare == null || net == null || net <= 0 || row.totalWeight == null) return null;
  const grams = Math.max(0, row.totalWeight - tare);
  return Math.min(100, Math.max(0, Math.round((grams / net) * 100)));
}

/**
 * Persisted group/sort/filter prefs (localStorage). Unknown enum values fall
 * back to the default so a corrupt/old blob can't wedge the page.
 */
function loadInventoryPrefs(): InventoryPrefs {
  if (typeof window === "undefined") return DEFAULT_INVENTORY_PREFS;
  try {
    const raw = window.localStorage.getItem(INVENTORY_PREFS_KEY);
    if (!raw) return DEFAULT_INVENTORY_PREFS;
    const p = JSON.parse(raw) as Partial<InventoryPrefs>;
    return {
      groupBy: (INVENTORY_GROUP_BYS as readonly InventoryGroupBy[]).includes(p.groupBy as InventoryGroupBy)
        ? (p.groupBy as InventoryGroupBy)
        : DEFAULT_INVENTORY_PREFS.groupBy,
      sortKey: (INVENTORY_SORT_KEYS as readonly InventorySortKey[]).includes(p.sortKey as InventorySortKey)
        ? (p.sortKey as InventorySortKey)
        : DEFAULT_INVENTORY_PREFS.sortKey,
      sortDir: p.sortDir === "desc" ? "desc" : DEFAULT_INVENTORY_PREFS.sortDir,
      includeRetired: p.includeRetired === true,
    };
  } catch {
    return DEFAULT_INVENTORY_PREFS;
  }
}

/** Sentinel `<option>` value for "take me to the create-a-location form".
 *  Shared spelling with the filament list; not a valid ObjectId, so it can
 *  never collide with a real location id. */
const NEW_LOCATION_OPTION = "__new_location__";

/**
 * GH #1141 URL-mirrored filters: `includeRetired` keeps its existing
 * spelling — `/locations` links here with it, a supported entry point.
 * `location` is deliberately NOT a filter — it is a one-shot
 * scroll/highlight deep link encoded into printed dry-box QR stickers, and
 * `serializeFilterParams` preserves it precisely because it is unowned.
 */

export default function InventoryPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const { formatNumber } = useNumberFormat();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [data, setData] = useState<InventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState<LocationOption[]>([]);

  // Filters
  const [kind, setKind] = useState("");
  const [type, setType] = useState("");
  const [vendor, setVendor] = useState("");
  const [search, setSearch] = useState("");
  const [includeRetired, setIncludeRetired] = useState(DEFAULT_INVENTORY_PREFS.includeRetired);

  // Distinct type/vendor option lists for the filter dropdowns.
  const [types, setTypes] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);

  // Grouping + sorting. Persisted in localStorage, but loaded post-mount (in
  // an effect) so the server and client first paint both use the defaults —
  // no hydration mismatch on the controls or the group order.
  const [groupBy, setGroupBy] = useState<InventoryGroupBy>(DEFAULT_INVENTORY_PREFS.groupBy);
  const [sortKey, setSortKey] = useState<InventorySortKey>(DEFAULT_INVENTORY_PREFS.sortKey);
  const [sortDir, setSortDir] = useState<InventorySortDir>(DEFAULT_INVENTORY_PREFS.sortDir);
  // STATE, not a ref (GH #1141). Effects in one commit run in declaration
  // order, so a ref set by the seed effect is already true when the mirror
  // effect runs in that SAME commit, still closed over the initial defaults —
  // it wrote those over the URL it had just read, and a shared
  // `/inventory?q=pla` landed bare. A state flag is only true from the commit
  // AFTER the seed.
  const [seeded, setSeeded] = useState(false);
  /** Preference keys the USER changed this session — the only ones written
   *  back to storage. See the persist effect. */
  const prefsTouchedRef = useRef<Set<(typeof INVENTORY_PERSISTED_KEYS)[number]>>(new Set());
  /** The query string this page last wrote, so its own replaceState does not
   *  come back through SearchParamsSync as an external change. */
  const ownUrlWriteRef = useRef<string | null>(null);

  // Debounce the search input — the filtered-groups memo walks every group +
  // every spool on each keystroke. 200ms (snappier than the main list's
  // 300ms because the search runs purely client-side here).
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    // Trimmed at the debounce — the parser trims on read, so an untrimmed
    // live value diverges from its own mirrored URL. See the home page's
    // twin comment; the input keeps the raw text.
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => clearTimeout(id);
  }, [search]);

  // Per-group expand/collapse state. Default: every group expanded.
  // The set holds COLLAPSED group keys (locationId or "_none") so a
  // brand-new group from a refresh defaults to expanded without us
  // having to seed it.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Per-spool selection state for batch actions, keyed by
  // `filamentId:spoolId` so the same selection set works across groups and
  // survives filter changes (rows that dropped out of the view stay selected
  // but invisible — the action-bar count reflects the visible-AND-selected
  // intersection so the user isn't surprised by hidden writes).
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const spoolKey = (row: SpoolRow) => `${row.filamentId}:${row._id}`;
  const toggleSelected = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);

  // Dry-box label printing: the location whose print button was clicked.
  // Deliberately NOT the group's spool rows — this page's groups are the
  // VISIBLE (filtered/searched) subset, and a label printed from them under
  // a filter would assert a partial list as the box's full contents. The
  // dialog fetches its own unfiltered manifest.
  const [printLocation, setPrintLocation] = useState<NonNullable<Group["location"]> | null>(null);

  // Deep link from a printed label's QR: /inventory?location=<id> expands
  // that location's group, scrolls to it and rings it briefly. Same
  // fired-once pattern as the filament detail page's ?spool= (no
  // useSearchParams — reading window.location avoids a Suspense boundary).
  const deepLinkHandledRef = useRef(false);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);

  useEffect(() => {
    if (deepLinkHandledRef.current || loading || !data) return;
    deepLinkHandledRef.current = true;
    const param = new URLSearchParams(window.location.search).get("location");
    if (!param) return;
    // A physical label can outlive its box's contents: once every active
    // spool moves out, the by-location aggregation returns NO group for it —
    // nothing to scroll to, and the scan would silently do nothing. A
    // printed QR pointing at silence reads as "the app is broken"; say what
    // actually happened instead.
    if (!data.groups.some((g) => g.locationId === param)) {
      toast(t("inventory.deepLinkEmpty"), "info");
      return;
    }
    // A scanned label must not depend on the scanning browser's persisted
    // groupBy preference: under type/vendor/none grouping the section ids
    // are bucket values, not location ids, and the target simply would not
    // exist. Forcing location grouping is what the user asked for by
    // scanning a BOX label; the touch is recorded so it persists like any
    // manual switch.
    prefsTouchedRef.current.add("groupBy");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGroupBy("location");
    // Groups default to expanded (`collapsed` holds collapsed keys), so the
    // delete only matters when a stored pref collapsed this one.
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(param);
      return next;
    });
    setHighlightKey(param);
  }, [loading, data, t, toast]);

  // Deep link, step 2: scroll once the location-grouped DOM exists. Split
  // from step 1 because the setGroupBy above re-renders the section list —
  // a same-tick requestAnimationFrame can fire before that commit and find
  // no element.
  useEffect(() => {
    if (!highlightKey || groupBy !== "location" || loading) return;
    const raf = requestAnimationFrame(() => {
      document
        .getElementById(`inventory-group-${highlightKey}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const timer = setTimeout(() => setHighlightKey(null), 2500);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [highlightKey, groupBy, loading]);

  const fetchInventory = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        if (kind) qs.set("kind", kind);
        if (type) qs.set("type", type);
        if (vendor) qs.set("vendor", vendor);
        if (includeRetired) qs.set("includeRetired", "1");
        const res = await fetch(`/api/spools/by-location?${qs.toString()}`, { signal });
        if (!res.ok) {
          toast(t("inventory.loadFailed"), "error");
          setLoading(false);
          return;
        }
        setData(await res.json());
        setLoading(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        toast(t("inventory.loadFailed"), "error");
        setLoading(false);
      }
    },
    [kind, type, vendor, includeRetired, t, toast],
  );

  // Load on mount + whenever a filter changes.
  useEffect(() => {
    const ac = new AbortController();
    fetchInventory(ac.signal); // eslint-disable-line react-hooks/set-state-in-effect -- data fetching
    return () => ac.abort();
  }, [fetchInventory]);

  // Locations list (for the "move" dropdown on each row).
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/locations", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: LocationOption[]) => setLocations(list))
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // GH #795: distinct type + vendor lists for the filter dropdowns.
  useEffect(() => {
    const ac = new AbortController();
    Promise.all([
      fetch("/api/filaments/types", { signal: ac.signal }).then((r) => (r.ok ? r.json() : [])),
      fetch("/api/filaments/vendors", { signal: ac.signal }).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([t1, v1]: [string[], string[]]) => {
        setTypes(Array.isArray(t1) ? t1 : []);
        setVendors(Array.isArray(v1) ? v1 : []);
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // Load persisted group/sort prefs once, after mount, so the first client
  // paint matches the server HTML (both use the defaults), then adopt the
  // stored values. The persist effect below is gated on `seeded` so it
  // doesn't clobber storage with the defaults before this runs.
  useEffect(() => {
    const p = loadInventoryPrefs();
    // GH #1141: the URL wins over the persisted pref, for the keys it carries.
    //
    // Read post-mount, defaults-then-adopt — NOT a lazy `useState` initializer
    // with a `typeof window` check, which produces different first renders on
    // the two sides. Group/sort/retired fall back to the PERSISTED pref when
    // the URL is silent, so a bare /inventory still opens the way the user
    // left it, while a link that carries them applies them for the visit.
    // `seedFilterState` owns that rule for both this seed and the re-seed.
    const url = seedFilterState(window.location.search, INVENTORY_FILTER_SPEC, p);

    setSearch(url.search); // eslint-disable-line react-hooks/set-state-in-effect -- URL + persisted prefs
    setKind(url.kind);
    setType(url.type);
    setVendor(url.vendor);
    setGroupBy(url.groupBy);
    setSortKey(url.sortKey);
    setSortDir(url.sortDir);
    // GH #1106: `?includeRetired=1` overrides the persisted pref for this
    // visit — the /locations "location is still in use" panel links here to
    // show the retired spools blocking a delete; without it the aggregation
    // returns no group and the deep-link handler toasts "no active spools".
    // It is NOT written into stored preferences (GH #1141): every non-bare
    // /inventory URL carries it, so "the URL mentions it" no longer
    // distinguishes a deliberate ask from a serialized default, and a one-off
    // "show retired" link should not permanently flip a stored setting.
    setIncludeRetired(url.includeRetired);
    setSeeded(true);
  }, []);

  // GH #1141: mirror the filters into the URL so a view can be shared,
  // bookmarked and survive a refresh.
  //
  // `replaceState`, not `pushState`: a history entry per dropdown change
  // would make leaving the page take N Back presses. It MUST go through the
  // patched `window.history` method — Next copies its internal `__NA` marker
  // onto the state, and its popstate handler full-page-reloads an entry
  // without it. `nextFilterHref` returns null when nothing would change, and
  // MERGES: `?location=` — encoded into printed dry-box QR stickers — is
  // preserved because the spec does not own it. Gated on `seeded` so it
  // cannot run before the seed above and blank the query string.
  useEffect(() => {
    if (!seeded) return;
    const href = nextFilterHref(
      window.location,
      INVENTORY_FILTER_SPEC,
      {
      // The DEBOUNCED value — serializing the raw one fires a
      // `router.replace` per keystroke.
      search: debouncedSearch,
      kind,
      type,
      vendor,
      includeRetired,
      groupBy,
      sortKey,
      sortDir,
    },
      // Fresh persisted values — the sticky keys stay encoded while the
      // view's group/sort/retired differ from the stored ones, or clearing
      // the last filter drops the URL to bare and a reload silently swaps
      // the shared link's view for the persisted one. See the home page's
      // twin.
      loadInventoryPrefs(),
    );
    if (href) {
      // Record what we wrote so the re-seed can tell our own change from
      // someone else's and not loop on it.
      // Query component ONLY: the href keeps the hash, the echo through
      // useSearchParams never has one, and a mismatched marker turns our own
      // write into an "external" re-seed that clobbers live input.
      ownUrlWriteRef.current = queryStringOf(href);
      // Through the ROUTER, not `window.history` directly. A raw
      // `replaceState` leaves the router's own model of the URL untouched, so
      // `useSearchParams` keeps reporting the pre-write value — and a later
      // Link click to the same route then looks like no change at all, which
      // is exactly the navigation the re-seed exists to catch. Verified in the
      // browser: with a raw replaceState the list stayed filtered under a bare
      // URL. `scroll: false` keeps the list position; already debounced.
      router.replace(href, { scroll: false });
    }
  }, [seeded, debouncedSearch, kind, type, vendor, includeRetired, groupBy, sortKey, sortDir, router]);

  // GH #1141: re-seed when something ELSE changes the query string. The
  // mount seed misses a client-side navigation to the SAME route — clicking
  // the header's Inventory link while filtered reuses this page, so the URL
  // goes bare while the state stays filtered.
  const reseedFromUrl = useCallback((nextSearch: string) => {
    // Our own replaceState comes back through here; CONSUME the marker
    // rather than just testing it — a marker is good for one echo, and it is
    // spent on one OBSERVATION regardless of match (see the home page's twin
    // comment: a normalization-only replace is invisible to useSearchParams,
    // and a marker consumed only on match survives to mis-claim a later
    // genuine navigation to the same canonical query).
    const own = ownUrlWriteRef.current;
    ownUrlWriteRef.current = null;
    if (own === nextSearch) return;
    const url = parseFilterParams(nextSearch, INVENTORY_FILTER_SPEC);
    const present = presentFilterKeys(nextSearch, INVENTORY_FILTER_SPEC);
    setSearch(url.search);
    // Both, or the debounce timer would re-write the pre-navigation value a
    // moment later and undo the re-seed.
    setDebouncedSearch(url.search);
    setKind(url.kind);
    setType(url.type);
    setVendor(url.vendor);
    // Group, sort and includeRetired are PERSISTED, so an absent param means
    // "unchanged", not "default". Resetting them on a bare /inventory would
    // have the persist effect below overwrite the user's stored group/sort
    // with the defaults — a saved preference destroyed by a navigation that
    // never mentioned it. Functional updates keep the callback free of state
    // deps.
    setIncludeRetired((cur) => (present.has("includeRetired") ? url.includeRetired : cur));
    setGroupBy((cur) => (present.has("groupBy") ? url.groupBy : cur));
    setSortKey((cur) => (present.has("sortKey") ? url.sortKey : cur));
    setSortDir((cur) => (present.has("sortDir") ? url.sortDir : cur));
    // Any touch still armed here is DEAD — a real one was consumed by the
    // persist effect at its own commit, before this navigation could be
    // processed. See the home page's twin comment.
    prefsTouchedRef.current.clear();
  }, []);

  // Persist ONLY what the user chose (GH #1141). Every shared /inventory
  // link MENTIONS the grouping, sort and includeRetired, so an ungated
  // persist effect would let a friend's link permanently overwrite the
  // recipient's saved preferences just by being opened. Per-key rather than
  // a single boolean because the record is one blob: a boolean cannot
  // express "store the direction I just flipped, leave the grouping alone".
  useEffect(() => {
    if (!seeded || prefsTouchedRef.current.size === 0) return;
    try {
      // Tolerant parse — a corrupt blob merges as `{}` and this write
      // replaces it. See the home page's twin comment.
      const stored = parseStoredPrefs(
        window.localStorage.getItem(INVENTORY_PREFS_KEY),
      ) as Partial<InventoryPrefs>;
      const live: InventoryPrefs = { groupBy, sortKey, sortDir, includeRetired };
      const next: InventoryPrefs = { ...DEFAULT_INVENTORY_PREFS, ...stored };
      for (const key of prefsTouchedRef.current) next[key] = live[key] as never;
      window.localStorage.setItem(INVENTORY_PREFS_KEY, JSON.stringify(next));
      // CONSUME the touches. A touch authorizes ONE write — the change that
      // armed it, now stored. Left armed, it authorizes every later state
      // change too, letting a Back through an old shared URL overwrite the
      // preference the user had just set. Mirrors the home page.
      prefsTouchedRef.current.clear();
    } catch {
      /* ignore quota / disabled storage / a corrupt stored blob */
    }
  }, [seeded, groupBy, sortKey, sortDir, includeRetired]);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Client-side search filter — runs over the already-server-filtered
  // groups: free-text match against filament name / spool label / lot.
  //
  // `count` and `totalGrams` are recomputed from the FILTERED spools —
  // keeping the server-side counts would render "20 spools · 18000g" for a
  // one-result search. The sum mirrors the server's 0g-tare fallback for
  // legacy spools (totalWeight set, no own/parent spoolWeight):
  // `remainingGrams()` returns null in that shape — correct for the per-row
  // display, wrong for the group total — so an unsearched group's total and
  // the same group's searched total (matching all rows) agree.
  const filteredGroups = useMemo(() => {
    if (!data) return [];
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return data.groups;
    return data.groups
      .map((g) => {
        const matching = g.spools.filter(
          (s) =>
            s.filamentName.toLowerCase().includes(q) ||
            (s.label || "").toLowerCase().includes(q) ||
            (s.lotNumber || "").toLowerCase().includes(q),
        );
        const totalGrams = matching.reduce((sum, s) => {
          if (s.totalWeight == null) return sum;
          const { tare } = effectiveWeights(s);
          return sum + Math.max(0, s.totalWeight - (tare ?? 0));
        }, 0);
        return {
          ...g,
          spools: matching,
          count: matching.length,
          totalGrams,
        };
      })
      .filter((g) => g.spools.length > 0);
  }, [data, debouncedSearch]);

  // Stats for the header derive from `filteredGroups` so they track BOTH the
  // server-side filters and the client-side text search, matching the group
  // headers. With an empty search `filteredGroups` IS `data.groups`
  // verbatim, so the unsearched numbers are unchanged.
  const stats = useMemo(() => summarizeInventoryGroups(filteredGroups), [filteredGroups]);

  // Regroup (location / type / vendor / none) + sort within each group. Pure
  // transform over the already-search-filtered rows — the payload carries
  // type/vendor/dates/weights per row, so switching grouping or sorting
  // needs no server round-trip.
  const displayGroups = useMemo(
    () => groupAndSortInventory(filteredGroups, groupBy, sortKey, sortDir),
    [filteredGroups, groupBy, sortKey, sortDir],
  );

  // Inline edits use the existing per-spool PUT — the same one SpoolCard
  // uses on the detail page — so retire / move / weight-update semantics
  // stay identical across both surfaces.
  const updateSpool = useCallback(
    async (row: SpoolRow, patch: Record<string, unknown>): Promise<boolean> => {
      // GH #1027: ?shape=spool — success body is never read here (state
      // refreshes via fetchInventory), so skip the full-doc serialization.
      const res = await fetch(`/api/filaments/${row.filamentId}/spools/${row._id}?shape=spool`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast(body?.error || t("inventory.updateFailed"), "error");
        return false;
      }
      return true;
    },
    [t, toast],
  );

  // Rows currently selected AND visible in the filtered view. A row that
  // scrolled out via a search refinement still lives in `selectedKeys` but
  // doesn't count toward the action-bar tally. ALSO skip rows whose group is
  // collapsed — the user can't see them, so batch-acting on them would be a
  // hidden-write surprise; re-expanding the group re-includes them (the
  // underlying selection set is unchanged, so the round-trip is lossless).
  const visibleSelectedRows = useMemo(() => {
    const out: SpoolRow[] = [];
    for (const g of displayGroups) {
      if (collapsed.has(g.key)) continue;
      for (const s of g.spools) {
        if (selectedKeys.has(spoolKey(s))) out.push(s);
      }
    }
    return out;
  }, [displayGroups, selectedKeys, collapsed]);

  // Run the same PUT for every selected row, sequentially so a transient
  // failure doesn't trigger a thundering-herd of retries. Surface
  // partial-success ("3 of 5") explicitly.
  const applyBatchPatch = useCallback(
    async (patch: Record<string, unknown>): Promise<void> => {
      if (visibleSelectedRows.length === 0) return;
      setBatchBusy(true);
      let okCount = 0;
      let failCount = 0;
      // try/finally so a network rejection can't escape with `batchBusy`
      // still true (the sticky action bar would stay disabled with no
      // aggregate toast).
      try {
        for (const row of visibleSelectedRows) {
          try {
            const ok = await updateSpool(row, patch);
            if (ok) okCount += 1;
            else failCount += 1;
          } catch {
            // updateSpool already toasts its own error; count this as
            // a failed row so the aggregate summary still surfaces.
            failCount += 1;
          }
        }
        const total = visibleSelectedRows.length;
        if (failCount === 0) {
          toast(t("inventory.batch.success", { count: okCount }), "success");
        } else if (okCount === 0) {
          toast(t("inventory.batch.allFailed"), "error");
        } else {
          toast(
            t("inventory.batch.partial", { ok: okCount, count: total, failed: failCount }),
            "info",
          );
        }
      } finally {
        setBatchBusy(false);
        clearSelection();
        // Best-effort refresh — failures here are non-fatal (the page
        // just keeps showing the previous data) and shouldn't block
        // the UI reset above.
        await fetchInventory().catch(() => {});
      }
    },
    [visibleSelectedRows, updateSpool, toast, t, clearSelection, fetchInventory],
  );

  const handleBatchMoveTo = useCallback(
    (locationId: string) => {
      // `locationId === ""` is the "no location" sentinel — the API
      // accepts null to clear the field.
      void applyBatchPatch({ locationId: locationId || null });
    },
    [applyBatchPatch],
  );

  const handleBatchRetire = useCallback(
    async (retire: boolean) => {
      if (retire) {
        const ok = await confirm({
          message: t("inventory.batch.confirmRetire", {
            count: visibleSelectedRows.length,
          }),
          destructive: true,
        });
        if (!ok) return;
      }
      void applyBatchPatch({ retired: retire });
    },
    [confirm, applyBatchPatch, t, visibleSelectedRows.length],
  );

  return (
    <>
      {/* GH #1141: only THIS child suspends, so the page still prerenders. */}
      <Suspense fallback={null}>
        <SearchParamsSync onExternalChange={reseedFromUrl} />
      </Suspense>
    <main id="main-content" className="w-full max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold">{t("inventory.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("inventory.subtitle")}</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
        <StatCard label={t("inventory.stats.spools")} value={stats.spoolCount.toString()} />
        <StatCard label={t("inventory.stats.locations")} value={stats.locationCount.toString()} />
        <StatCard label={t("inventory.stats.totalWeight")} value={`${formatNumber(stats.totalGrams / 1000, { minDecimals: 2, maxDecimals: 2, trimTrailingZeros: false })} kg`} />
      </div>
      {/* The cards follow the search, so say so — a shrunken total should
          read as "filtered", never as data loss. */}
      {debouncedSearch.trim() !== "" && (
        <p className="-mt-4 mb-6 text-xs text-gray-500 dark:text-gray-400">
          {t("inventory.stats.searchNote")}
        </p>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-6 p-3 bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-800 rounded-lg">
        <div>
          <label htmlFor="inv-search" className="block text-xs text-gray-500 mb-1">
            {t("inventory.filter.search")}
          </label>
          <input
            id="inv-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
            placeholder={t("inventory.filter.searchPlaceholder")}
            className="w-56 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
          />
        </div>
        <div>
          <label htmlFor="inv-kind" className="block text-xs text-gray-500 mb-1">
            {t("inventory.filter.kind")}
          </label>
          <select
            id="inv-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          >
            <option value="">{t("inventory.filter.allKinds")}</option>
            <option value="shelf">{t("locations.kind.shelf")}</option>
            <option value="drybox">{t("locations.kind.drybox")}</option>
            <option value="cabinet">{t("locations.kind.cabinet")}</option>
            <option value="printer">{t("locations.kind.printer")}</option>
            <option value="other">{t("locations.kind.other")}</option>
          </select>
        </div>
        <div>
          <label htmlFor="inv-type" className="block text-xs text-gray-500 mb-1">
            {t("inventory.filter.type")}
          </label>
          <select
            id="inv-type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          >
            <option value="">{t("inventory.filter.allTypes")}</option>
            {withCurrentValue(types, type).map((tp) => (
              <option key={tp} value={tp}>
                {tp}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inv-vendor" className="block text-xs text-gray-500 mb-1">
            {t("inventory.filter.vendor")}
          </label>
          <select
            id="inv-vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          >
            <option value="">{t("inventory.filter.allVendors")}</option>
            {withCurrentValue(vendors, vendor).map((vn) => (
              <option key={vn} value={vn}>
                {vn}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inv-groupby" className="block text-xs text-gray-500 mb-1">
            {t("inventory.groupBy")}
          </label>
          <select
            id="inv-groupby"
            value={groupBy}
            onChange={(e) => {
              prefsTouchedRef.current.add("groupBy");
              setGroupBy(e.target.value as InventoryGroupBy);
            }}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          >
            <option value="location">{t("inventory.groupBy.location")}</option>
            <option value="type">{t("inventory.groupBy.type")}</option>
            <option value="vendor">{t("inventory.groupBy.vendor")}</option>
            <option value="none">{t("inventory.groupBy.none")}</option>
          </select>
        </div>
        <div>
          <label htmlFor="inv-sortby" className="block text-xs text-gray-500 mb-1">
            {t("inventory.sortBy")}
          </label>
          <div className="flex items-center gap-1">
            <select
              id="inv-sortby"
              value={sortKey}
              onChange={(e) => {
                prefsTouchedRef.current.add("sortKey");
                setSortKey(e.target.value as InventorySortKey);
              }}
              className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            >
              <option value="remaining">{t("inventory.sort.remaining")}</option>
              <option value="name">{t("inventory.sort.name")}</option>
              <option value="type">{t("inventory.sort.type")}</option>
              <option value="vendor">{t("inventory.sort.vendor")}</option>
              <option value="purchase">{t("inventory.sort.purchase")}</option>
              <option value="opened">{t("inventory.sort.opened")}</option>
            </select>
            <button
              type="button"
              onClick={() => {
                prefsTouchedRef.current.add("sortDir");
                setSortDir((d) => (d === "asc" ? "desc" : "asc"));
              }}
              aria-label={t(sortDir === "asc" ? "inventory.sort.asc" : "inventory.sort.desc")}
              title={t(sortDir === "asc" ? "inventory.sort.asc" : "inventory.sort.desc")}
              className="px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            >
              {sortDir === "asc" ? "↑" : "↓"}
            </button>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 pb-1">
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(e) => {
              prefsTouchedRef.current.add("includeRetired");
              setIncludeRetired(e.target.checked);
            }}
            className="accent-blue-600"
          />
          {t("inventory.filter.includeRetired")}
        </label>
      </div>

      {/* Batch-action bar — appears only when at least one visible spool is
          selected; sticky so a user scrolling a long shelf list keeps the
          controls in reach. */}
      {visibleSelectedRows.length > 0 && (
        <div
          className="sticky top-2 z-30 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/40 p-3 shadow-sm"
          role="region"
          aria-label={t("inventory.selected.count", { count: visibleSelectedRows.length })}
        >
          <span className="text-sm font-medium text-blue-900 dark:text-blue-200">
            {t("inventory.selected.count", { count: visibleSelectedRows.length })}
          </span>
          <select
            aria-label={t("inventory.batch.moveTo", { count: visibleSelectedRows.length })}
            disabled={batchBusy}
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              handleBatchMoveTo(e.target.value === "_none" ? "" : e.target.value);
            }}
            className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900"
          >
            <option value="" disabled>
              {t("inventory.batch.moveTo", { count: visibleSelectedRows.length })}
            </option>
            <option value="_none">{t("inventory.noLocation")}</option>
            {locations.map((l) => (
              <option key={l._id} value={l._id}>
                {l.name}
              </option>
            ))}
          </select>
          {/* Batch retire — show "unretire" instead when every selected
              row is already retired (the dropdown above moves work the
              same in either direction; retire is the asymmetric one). */}
          {visibleSelectedRows.every((r) => r.retired) ? (
            <button
              type="button"
              disabled={batchBusy}
              onClick={() => handleBatchRetire(false)}
              className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              {t("inventory.batch.unretire", { count: visibleSelectedRows.length })}
            </button>
          ) : (
            <button
              type="button"
              disabled={batchBusy}
              onClick={() => handleBatchRetire(true)}
              className="px-3 py-1 text-sm border border-amber-400 text-amber-700 dark:text-amber-300 dark:border-amber-600 rounded bg-white dark:bg-gray-900 hover:bg-amber-50 dark:hover:bg-amber-900/30 disabled:opacity-50"
            >
              {t("inventory.batch.retire", { count: visibleSelectedRows.length })}
            </button>
          )}
          <button
            type="button"
            disabled={batchBusy}
            onClick={clearSelection}
            className="ml-auto px-3 py-1 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white disabled:opacity-50"
          >
            {t("inventory.deselectAll")}
          </button>
        </div>
      )}

      {/* Groups */}
      {loading ? (
        // Card-shaped skeletons so the layout doesn't reflow when content
        // lands.
        <SkeletonRegion label={t("inventory.loading")} className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-3"
            >
              <Skeleton className="h-5 w-48 rounded" />
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-4 w-3/4 rounded" />
            </div>
          ))}
        </SkeletonRegion>
      ) : displayGroups.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-gray-300 dark:border-gray-700 rounded-lg">
          <p className="text-gray-500 mb-3">{t("inventory.empty")}</p>
          <Link
            href="/locations/new"
            className="text-blue-600 hover:underline text-sm"
          >
            {t("inventory.empty.addLocation")}
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {displayGroups.map((group) => {
            const key = group.key;
            const isCollapsed = collapsed.has(key);
            // The header label depends on the grouping mode.
            const name =
              groupBy === "location"
                ? (group.location?.name ?? t("inventory.noLocation"))
                : groupBy === "none"
                  ? t("inventory.groupAll")
                  : group.key === INVENTORY_NO_GROUP_KEY
                    ? t("inventory.groupNone")
                    : (group.label ?? "");
            const kindLabel =
              groupBy === "location" && group.location?.kind
                ? isKnownLocationKind(group.location.kind)
                  ? t(`locations.kind.${group.location.kind}`)
                  : group.location.kind
                : "";
            // Dry-box groups get a print-label action in the header. Gated on
            // the drybox kind — the label template is dry-box specific (its
            // subtitle, desiccant line and replace hint would be wrong on a
            // shelf) — and on location grouping, where a group IS a location.
            const canPrintLabel =
              groupBy === "location" && group.location?.kind === "drybox";
            return (
              <section
                key={key}
                id={`inventory-group-${key}`}
                className={`border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden ${
                  highlightKey === key ? "ring-2 ring-blue-500" : ""
                }`}
              >
                <div className="flex items-stretch bg-gray-50 dark:bg-gray-900/50">
                <button
                  type="button"
                  onClick={() => toggleCollapse(key)}
                  aria-expanded={!isCollapsed}
                  className="flex-1 min-w-0 flex items-center justify-between px-4 py-3 hover:bg-gray-100 dark:hover:bg-gray-900 text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-gray-400 text-sm" aria-hidden="true">
                      {isCollapsed ? "▶" : "▼"}
                    </span>
                    <h2 className="font-semibold text-base truncate">
                      {name}
                      {kindLabel && (
                        <span className="ml-2 text-xs text-gray-500 font-normal">
                          {kindLabel}
                        </span>
                      )}
                      {group.location?.humidity != null && (
                        <span className="ml-2 text-xs text-gray-500 font-normal">
                          · {group.location.humidity}% RH
                        </span>
                      )}
                    </h2>
                  </div>
                  <div className="text-sm text-gray-500 whitespace-nowrap">
                    {t(
                      group.count === 1
                        ? "inventory.group.summary.one"
                        : "inventory.group.summary.other",
                      {
                        count: formatNumber(group.count, { maxDecimals: 0 }),
                        grams: formatNumber(group.totalGrams, { maxDecimals: 0 }),
                      },
                    )}
                  </div>
                </button>
                {canPrintLabel && group.location && (
                  <button
                    type="button"
                    onClick={() =>
                      setPrintLocation(group.location as NonNullable<Group["location"]>)
                    }
                    title={t("inventory.printDryBox")}
                    aria-label={t("inventory.printDryBox")}
                    className="px-3 border-l border-gray-200 dark:border-gray-800 text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-900"
                  >
                    <span aria-hidden="true">🖨</span>
                  </button>
                )}
                </div>
                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b border-gray-200 dark:border-gray-800 text-xs text-gray-500">
                        <tr>
                          <th scope="col" className="w-8 py-2 px-2">
                            <GroupSelectAllCheckbox
                              // GH #783: legacy single-spool rows are read-only
                              // (no checkbox), so exclude them from "select all"
                              // — selecting them would 404 on batch actions.
                              rows={group.spools.filter((r) => !r.legacySingleSpool)}
                              selectedKeys={selectedKeys}
                              spoolKey={spoolKey}
                              setSelected={setSelectedKeys}
                              label={t("inventory.selectAll")}
                            />
                          </th>
                          <th scope="col" className="text-left py-2 px-3">{t("inventory.col.filament")}</th>
                          <th scope="col" className="text-left py-2 px-3">{t("inventory.col.spool")}</th>
                          <th scope="col" className="text-right py-2 px-3">{t("inventory.col.weight")}</th>
                          <th scope="col" className="text-right py-2 px-3">{t("inventory.col.remaining")}</th>
                          <th scope="col" className="text-left py-2 px-3">{t("inventory.col.lastDry")}</th>
                          <th scope="col" className="text-right py-2 px-3">{t("inventory.col.actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.spools.map((row) => (
                          <SpoolEditRow
                            key={`${row.filamentId}-${row._id}`}
                            row={row}
                            locations={locations}
                            updateSpool={updateSpool}
                            confirmRetire={confirm}
                            onChanged={() => fetchInventory()}
                            selected={selectedKeys.has(spoolKey(row))}
                            onToggleSelected={() => toggleSelected(spoolKey(row))}
                            selectLabel={t("inventory.selectRow")}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {printLocation && (
        <PrintDryBoxLabelDialog
          open
          onClose={() => setPrintLocation(null)}
          location={printLocation}
        />
      )}
    </main>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}

interface RowProps {
  row: SpoolRow;
  locations: LocationOption[];
  updateSpool: (row: SpoolRow, patch: Record<string, unknown>) => Promise<boolean>;
  confirmRetire: ReturnType<typeof useConfirm>;
  onChanged: () => void;
  /** GH #420: selection state for batch actions. */
  selected: boolean;
  onToggleSelected: () => void;
  selectLabel: string;
}

function SpoolEditRow({
  row,
  locations,
  updateSpool,
  confirmRetire,
  onChanged,
  selected,
  onToggleSelected,
  selectLabel,
}: RowProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const { formatDate } = useDateFormat();
  const { formatGrams } = useNumberFormat();
  // Carry the CURRENT url back, so a detour to create a location returns to
  // THIS page rather than stranding the user on /locations.
  const newLocationHref = useCallback(
    () =>
      withReturnTo(
        "/locations/new",
        typeof window === "undefined"
          ? null
          : `${window.location.pathname}${window.location.search}`,
      ),
    [],
  );
  const grams = remainingGrams(row);
  const pct = remainingPct(row);

  // Inline weight editor — opens on click, saves on Enter / Save button.
  const [editingWeight, setEditingWeight] = useState(false);
  const [weightDraft, setWeightDraft] = useState(row.totalWeight?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [weightError, setWeightError] = useState<WeightInputProblem | null>(null);

  const saveWeight = async () => {
    // GH #509: short-circuit re-entry while a save is in flight. The Save
    // button is `disabled={saving}`, but the input's Enter handler keeps
    // firing during the in-flight PUT — holding Enter would race a second
    // PUT against the refresh.
    if (saving) return;
    // GH #1105: MUST go through parseWeightInput — a bare `Number()` guard
    // passes an EMPTY field (Number("") is 0), silently writing 0 g.
    const parsed = parseWeightInput(weightDraft);
    if (!parsed.ok) {
      setWeightError(parsed.reason);
      return;
    }
    setWeightError(null);
    const patch: Record<string, unknown> = { totalWeight: parsed.grams };
    // Set `saving` BEFORE the confirm below, so the Enter-key re-entry guard
    // above covers the dialog's whole lifetime.
    setSaving(true);
    try {
      // GH #381: zeroing the weight prompts to retire, with the same skips
      // as the detail page: never when already retired, never when the prior
      // weight was already 0. A null prior weight is `!== 0`, so it prompts —
      // matching the detail page exactly.
      if (parsed.grams === 0 && !row.retired && row.totalWeight !== 0) {
        const alsoRetire = await confirmRetire({
          message: t("detail.spool.confirmRetireOnZero"),
          confirmLabel: t("inventory.retire"),
        });
        if (alsoRetire) patch.retired = true;
      }
      const ok = await updateSpool(row, patch);
      if (ok) {
        setEditingWeight(false);
        onChanged();
      }
    } finally {
      // try/finally because of the await above: a throw inside the confirm
      // would otherwise strand this row disabled with no way back.
      setSaving(false);
    }
  };

  // GH #404: per-handler busy flags — without them a second click on a slow
  // LAN races the first PUT, and on retire toggle the response order could
  // end in the wrong state.
  const [movePending, setMovePending] = useState(false);
  const [retirePending, setRetirePending] = useState(false);

  const moveTo = async (locId: string) => {
    if (movePending) return;
    setMovePending(true);
    try {
      const ok = await updateSpool(row, { locationId: locId || null });
      if (ok) onChanged();
    } finally {
      setMovePending(false);
    }
  };

  const toggleRetire = async () => {
    if (retirePending) return;
    if (!row.retired) {
      // Retiring removes the spool from inventory totals — confirm
      // because it's the kind of action a click can fire by mistake.
      if (!(await confirmRetire({
        message: t("inventory.confirmRetire", { label: row.label || row.filamentName }),
        confirmLabel: t("inventory.retire"),
      }))) return;
    }
    setRetirePending(true);
    try {
      const ok = await updateSpool(row, { retired: !row.retired });
      if (ok) onChanged();
    } finally {
      setRetirePending(false);
    }
  };

  // GH #783: a legacy single-spool row has no real spools[] subdoc, so the
  // inline edit/move/retire endpoints (which match spools._id) would 404.
  // Render it read-only with a link to the filament, where the user can add a
  // managed spool (which migrates the legacy roll). No checkbox → it can't be
  // batch-selected either.
  if (row.legacySingleSpool) {
    return (
      <tr className="border-b border-gray-100 dark:border-gray-900">
        <td className="py-2 px-2" aria-hidden="true" />
        <td className="py-2 px-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <FilamentSwatch
              color={row.filamentColor}
              secondaryColors={row.secondaryColors}
              arrangement={deriveArrangement(row.optTags)}
              finish={deriveFinish(row.optTags)}
              shape="square"
              size={32}
              title={row.filamentColor ?? undefined}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <Link href={`/filaments/${row.filamentId}`} className="text-blue-600 hover:underline truncate">
                  {row.filamentName}
                </Link>
                <span className="text-xs text-gray-500 shrink-0">{row.filamentType}</span>
              </div>
              <div className="text-xs text-gray-500 truncate">{row.filamentVendor}</div>
            </div>
          </div>
        </td>
        <td className="py-2 px-3">
          <span
            className="inline-block text-xs px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300"
            title={t("inventory.legacyHint")}
          >
            {t("inventory.legacyBadge")}
          </span>
        </td>
        <td className="py-2 px-3 text-right">{row.totalWeight != null ? `${formatGrams(row.totalWeight)} g` : "—"}</td>
        <td className="py-2 px-3 text-right">{grams != null ? `${formatGrams(grams)} g` : "—"}</td>
        <td className="py-2 px-3">—</td>
        <td className="py-2 px-3 text-right">
          <Link href={`/filaments/${row.filamentId}`} className="text-xs text-blue-600 hover:underline">
            {t("inventory.legacyManage")}
          </Link>
        </td>
      </tr>
    );
  }

  return (
    <tr
      className={`border-b border-gray-100 dark:border-gray-900 ${
        row.retired ? "opacity-50" : "hover:bg-gray-50 dark:hover:bg-gray-900/40"
      } ${selected ? "bg-blue-50 dark:bg-blue-900/20" : ""}`}
    >
      <td className="py-2 px-2 text-center">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          aria-label={selectLabel}
          className="accent-blue-600"
        />
      </td>
      <td className="py-2 px-3">
        {/* 32px rounded-square swatch spanning both text lines — larger
            color area without growing the row (GH #1050). */}
        <div className="flex items-center gap-2.5 min-w-0">
          <FilamentSwatch
            color={row.filamentColor}
            secondaryColors={row.secondaryColors}
            arrangement={deriveArrangement(row.optTags)}
            finish={deriveFinish(row.optTags)}
            shape="square"
            size={32}
            title={row.filamentColor ?? undefined}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <Link
                href={`/filaments/${row.filamentId}`}
                className="text-blue-600 hover:underline truncate"
              >
                {row.filamentName}
              </Link>
              <span className="text-xs text-gray-500 shrink-0">{row.filamentType}</span>
            </div>
            <div className="text-xs text-gray-500 truncate">
              {row.filamentVendor}
              {row.lotNumber && ` · lot ${row.lotNumber}`}
            </div>
          </div>
        </div>
      </td>
      <td className="py-2 px-3">
        <div className="font-medium">{row.label || <span className="text-gray-400 italic">{t("inventory.unnamed")}</span>}</div>
        {/* Per-spool id (read-only; edit on the detail page). */}
        {row.instanceId && (
          <code className="block max-w-[14rem] truncate text-[11px] text-gray-400 dark:text-gray-500 font-mono" title={row.instanceId}>
            {row.instanceId}
          </code>
        )}
        {row.retired && (
          <span className="inline-block text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
            {t("inventory.retiredBadge")}
          </span>
        )}
      </td>
      <td className="py-2 px-3 text-right">
        {editingWeight ? (
          <span className="inline-flex flex-col items-end gap-0.5">
            <span className="inline-flex items-center gap-1">
              <input
                type="number"
                min="0"
                step="1"
                autoFocus
                value={weightDraft}
                onChange={(e) => {
                  setWeightDraft(e.target.value);
                  setWeightError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveWeight();
                  if (e.key === "Escape") {
                    setWeightDraft(row.totalWeight?.toString() ?? "");
                    setWeightError(null);
                    setEditingWeight(false);
                  }
                }}
                aria-label={t("inventory.updateWeight")}
                aria-invalid={weightError != null}
                className="w-20 px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={saveWeight}
                // GH #1105: also disabled while the field is empty, matching
                // the detail page's editor.
                disabled={saving || weightDraft.trim() === ""}
                className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? "…" : t("common.save")}
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setWeightDraft(row.totalWeight?.toString() ?? "");
                  setWeightError(null);
                  setEditingWeight(false);
                }}
                className="px-2 py-0.5 border border-gray-300 dark:border-gray-700 rounded text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                {t("common.cancel")}
              </button>
            </span>
            {/* This editor is pre-seeded with the current value, so a silent
                no-op on Enter reads as "the app is broken" more than it would
                on the detail page's blank "new reading" field. */}
            {weightError && (
              <span role="alert" className="text-xs text-amber-600 dark:text-amber-400">
                {t("detail.weight.invalidInput")}
              </span>
            )}
          </span>
        ) : (
          // GH #445: pencil indicator + dotted underline — the "click to
          // edit" idiom used elsewhere (SpoolCard label edit).
          <button
            type="button"
            onClick={() => {
              // Reseed the draft from the current row value on open. The row
              // survives fetchInventory() refreshes (stable key), so the
              // once-seeded useState value goes stale when the weight
              // changed server-side — opening then saving would write the
              // old weight back. Mirrors the GH #263 SpoolCard label fix.
              setWeightDraft(row.totalWeight?.toString() ?? "");
              setWeightError(null);
              setEditingWeight(true);
            }}
            className="inline-flex items-center gap-1 border-b border-dashed border-gray-400 dark:border-gray-600 hover:text-blue-600 hover:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 transition-colors"
            aria-label={t("inventory.updateWeight")}
            title={t("inventory.updateWeight")}
          >
            {row.totalWeight != null ? `${formatGrams(row.totalWeight)}g` : <span className="text-gray-400">—</span>}
            <span aria-hidden="true" className="text-xs opacity-50">✎</span>
          </button>
        )}
      </td>
      <td className="py-2 px-3 text-right">
        {pct != null ? (
          <div className="inline-flex items-center gap-2">
            <div className="w-16 bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
              <div
                className={`h-2 rounded-full transition-all ${
                  pct > 25 ? "bg-green-500" : pct > 10 ? "bg-yellow-500" : "bg-red-500"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs text-gray-500 w-12 text-right">
              {grams != null ? `${formatGrams(grams)}g` : `${pct}%`}
            </span>
          </div>
        ) : grams != null ? (
          <span className="text-xs">{formatGrams(grams)}g</span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="py-2 px-3 text-xs text-gray-500">
        {row.lastDryAt ? (
          <div className="inline-flex items-center gap-1.5">
            <span>{formatDate(row.lastDryAt)}</span>
            {/* GH #443: a visible chip, not a title= tooltip — touch-only
                users never see tooltips. */}
            {row.dryCycleCount > 0 && (
              <span
                className="inline-block px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-[10px] leading-none"
                aria-label={t("inventory.dryCycleCount", { count: row.dryCycleCount })}
              >
                {t("inventory.dryCycleBadge", { count: row.dryCycleCount })}
              </span>
            )}
          </div>
        ) : (
          <span className="text-gray-400">{t("inventory.neverDried")}</span>
        )}
      </td>
      <td className="py-2 px-3 text-right">
        <div className="inline-flex items-center gap-1">
          {/* Show the spool's CURRENT location selected. Mirrors the
              home-page spool dropdown: value "" is the "No location" option,
              so moveTo("") clears the location. Controlled by
              row.locationId, which refreshes after a successful move. */}
          <select
            value={row.locationId ?? ""}
            disabled={movePending}
            onChange={(e) => {
              if (e.target.value === NEW_LOCATION_OPTION) {
                // Nothing moves; the select is controlled by row.locationId
                // and snaps back on re-render.
                router.push(newLocationHref());
                return;
              }
              moveTo(e.target.value);
            }}
            aria-label={t("inventory.location")}
            title={t("inventory.location")}
            className="text-xs px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 disabled:opacity-50"
          >
            <option value="">{t("inventory.noLocation")}</option>
            {locations.map((loc) => (
              <option key={loc._id} value={loc._id}>
                {loc.name}
              </option>
            ))}
            {/* Same affordance as the filament list — with no locations
                defined this menu would be a single "No location" entry and
                no route to creating one. */}
            <option value={NEW_LOCATION_OPTION}>
              {t("filaments.spools.newLocation")}
            </option>
          </select>
          <button
            type="button"
            onClick={toggleRetire}
            disabled={retirePending}
            className={`text-xs px-2 py-0.5 rounded disabled:opacity-50 ${
              row.retired
                ? "border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
                : "text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950"
            }`}
            title={row.retired ? t("inventory.unretire") : t("inventory.retire")}
          >
            {row.retired ? t("inventory.unretire") : t("inventory.retire")}
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * Header checkbox for a group: unchecked / indeterminate / checked. Click
 * toggles the whole group — full→empty when fully selected, otherwise →full.
 */
function GroupSelectAllCheckbox({
  rows,
  selectedKeys,
  spoolKey,
  setSelected,
  label,
}: {
  rows: SpoolRow[];
  selectedKeys: Set<string>;
  spoolKey: (row: SpoolRow) => string;
  setSelected: (updater: (prev: Set<string>) => Set<string>) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const total = rows.length;
  const selectedInGroup = rows.reduce(
    (n, r) => (selectedKeys.has(spoolKey(r)) ? n + 1 : n),
    0,
  );
  const allChecked = total > 0 && selectedInGroup === total;
  const indeterminate = selectedInGroup > 0 && selectedInGroup < total;

  // Indeterminate is a DOM property, not an HTML attribute — React
  // doesn't expose it via JSX so we sync it on each render.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const onChange = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) {
        for (const r of rows) next.delete(spoolKey(r));
      } else {
        for (const r of rows) next.add(spoolKey(r));
      }
      return next;
    });
  };

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={allChecked}
      onChange={onChange}
      disabled={total === 0}
      aria-label={label}
      className="accent-blue-600"
    />
  );
}

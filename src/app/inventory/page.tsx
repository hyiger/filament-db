"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useDateFormat } from "@/hooks/useDateFormat";
import { Skeleton, SkeletonRegion } from "@/components/Skeleton";
import {
  groupAndSortInventory,
  INVENTORY_NO_GROUP_KEY,
  type InventoryGroupBy,
  type InventorySortKey,
  type InventorySortDir,
} from "@/lib/inventorySort";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { isKnownLocationKind } from "@/lib/locationKind";

/**
 * GH #389 — Spool Inventory page.
 *
 * Lists every active spool grouped by storage Location, so you can:
 *   - see at a glance how many spools you have and where they live
 *   - audit a physical location ("are the spools on this shelf the same
 *     ones the app thinks are here?")
 *   - update the most common per-spool things (weight, location, retire)
 *     without first navigating to the parent filament's detail page
 *
 * Counterpart to the filament list (/): same data, different lens.
 * Where the filament list groups spools UNDER their filament, this page
 * groups filaments under their LOCATION.
 *
 * Data comes from `/api/spools/by-location` which does the aggregation
 * server-side (groups by `spools[].locationId`, lookups the Location
 * doc, surfaces parent inheritance hints for the % remaining math).
 * Inline edits hit the existing `PUT /api/filaments/{id}/spools/{spoolId}`
 * endpoint — no new mutation route was needed for v1.
 */

interface SpoolRow {
  _id: string;
  /** #732 Phase 4: the durable per-spool id, surfaced read-only here. */
  instanceId?: string;
  /** GH #806: the spool's current location, so the move-to dropdown
   * pre-selects it instead of always showing the "Move to…" placeholder. */
  locationId: string | null;
  label: string;
  totalWeight: number | null;
  lotNumber: string | null;
  purchaseDate: string | null;
  openedDate: string | null;
  retired: boolean;
  /** GH #429: not in the by-location aggregation payload anymore — the
   * inventory list doesn't render photos and the per-row data URLs
   * could push the response into the megabytes range on large
   * catalogs. Kept optional in the type so a future row-expand can
   * lazy-load it from `/api/filaments/{id}`. */
  photoDataUrl?: string | null;
  dryCycleCount: number;
  lastDryAt: string | null;
  filamentId: string;
  filamentName: string;
  filamentVendor: string;
  filamentType: string;
  filamentColor: string;
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
  location: { _id: string; name: string; kind: string; humidity: number | null; notes: string } | null;
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
 * GH #795 — persisted group/sort/filter prefs (localStorage). A single JSON
 * blob avoids key sprawl; unknown enum values fall back to the default so a
 * corrupt/old blob can't wedge the page. `includeRetired` rides along since it
 * also drives the server query.
 */
const INVENTORY_PREFS_KEY = "filamentdb-inventory-prefs";
const GROUP_BY_VALUES: InventoryGroupBy[] = ["location", "type", "vendor", "none"];
const SORT_KEY_VALUES: InventorySortKey[] = ["remaining", "name", "type", "vendor", "purchase", "opened"];

interface InventoryPrefs {
  groupBy: InventoryGroupBy;
  sortKey: InventorySortKey;
  sortDir: InventorySortDir;
  includeRetired: boolean;
}
const DEFAULT_INVENTORY_PREFS: InventoryPrefs = {
  groupBy: "location",
  // #795: default to remaining-weight ascending — surfaces near-empty spools to
  // reorder, the issue's primary use case.
  sortKey: "remaining",
  sortDir: "asc",
  includeRetired: false,
};

function loadInventoryPrefs(): InventoryPrefs {
  if (typeof window === "undefined") return DEFAULT_INVENTORY_PREFS;
  try {
    const raw = window.localStorage.getItem(INVENTORY_PREFS_KEY);
    if (!raw) return DEFAULT_INVENTORY_PREFS;
    const p = JSON.parse(raw) as Partial<InventoryPrefs>;
    return {
      groupBy: GROUP_BY_VALUES.includes(p.groupBy as InventoryGroupBy)
        ? (p.groupBy as InventoryGroupBy)
        : DEFAULT_INVENTORY_PREFS.groupBy,
      sortKey: SORT_KEY_VALUES.includes(p.sortKey as InventorySortKey)
        ? (p.sortKey as InventorySortKey)
        : DEFAULT_INVENTORY_PREFS.sortKey,
      sortDir: p.sortDir === "desc" ? "desc" : "asc",
      includeRetired: p.includeRetired === true,
    };
  } catch {
    return DEFAULT_INVENTORY_PREFS;
  }
}

export default function InventoryPage() {
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

  // GH #795: distinct type/vendor option lists for the filter dropdowns
  // (mirrors the main filament list). Fetched once on mount.
  const [types, setTypes] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);

  // GH #795: grouping + sorting. Persisted in localStorage, but loaded
  // post-mount (in an effect) so the server and client first paint both use the
  // defaults — no hydration mismatch on the controls or the group order.
  const [groupBy, setGroupBy] = useState<InventoryGroupBy>(DEFAULT_INVENTORY_PREFS.groupBy);
  const [sortKey, setSortKey] = useState<InventorySortKey>(DEFAULT_INVENTORY_PREFS.sortKey);
  const [sortDir, setSortDir] = useState<InventorySortDir>(DEFAULT_INVENTORY_PREFS.sortDir);
  const prefsLoaded = useRef(false);

  // GH #444: debounce the search input. The filtered-groups memo
  // walks every group + every spool on each keystroke; on a slow
  // host with 1000+ spools that's a noticeable per-keystroke pause.
  // 200ms feels responsive (well below conscious-lag threshold) and
  // collapses bursts of typing into one recompute. The main filaments
  // list uses 300ms for the same reason; this is on the snappier
  // side because the search runs purely client-side here.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(id);
  }, [search]);

  // Per-group expand/collapse state. Default: every group expanded.
  // The set holds COLLAPSED group keys (locationId or "_none") so a
  // brand-new group from a refresh defaults to expanded without us
  // having to seed it.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // GH #420: per-spool selection state for batch actions ("move N to…",
  // "retire N"). Keyed by `filamentId:spoolId` so the same selection
  // set works across groups and survives filter changes (rows that
  // dropped out of the current view stay selected but invisible —
  // the action bar count reflects the current visible-AND-selected
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

  // GH #795: load persisted group/sort prefs once, after mount, so the first
  // client paint matches the server HTML (both use the defaults), then adopt
  // the stored values. The persist effect below is gated on `prefsLoaded` so it
  // doesn't clobber storage with the defaults before this runs.
  useEffect(() => {
    const p = loadInventoryPrefs();
    setGroupBy(p.groupBy); // eslint-disable-line react-hooks/set-state-in-effect -- persisted prefs
    setSortKey(p.sortKey);
    setSortDir(p.sortDir);
    setIncludeRetired(p.includeRetired);
    prefsLoaded.current = true;
  }, []);

  // Persist prefs whenever they change (after the initial load).
  useEffect(() => {
    if (!prefsLoaded.current) return;
    try {
      window.localStorage.setItem(
        INVENTORY_PREFS_KEY,
        JSON.stringify({ groupBy, sortKey, sortDir, includeRetired }),
      );
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [groupBy, sortKey, sortDir, includeRetired]);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Client-side search filter — runs over the already-server-filtered
  // groups so the filament/type/vendor server filters compose with a
  // free-text local match against filament name / spool label / lot.
  //
  // Codex P2 on PR #391 round 2: recompute `count` and `totalGrams`
  // from the FILTERED spools — previously the cloned group kept the
  // server-side counts, so a one-result search on a 20-spool shelf
  // still rendered "20 spools · 18000g" in the header.
  //
  // Codex P2 on PR #400 round 4: when summing the search-filtered
  // total, mirror the server's 0g-tare fallback for legacy spools
  // (totalWeight set, no own/parent spoolWeight). `remainingGrams()`
  // returns null in that shape — correct for the per-row "?" display,
  // but wrong for the group total. Inline the math here so an
  // unsearched group's total and the same group's searched total
  // (matching all rows) agree.
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

  // Stats for the header — derived from the SERVER groups so they
  // reflect the active server filters, not the client-side text search
  // (which is a "find within results" rather than a true filter).
  const stats = useMemo(() => {
    if (!data) return { spoolCount: 0, locationCount: 0, totalGrams: 0 };
    return {
      spoolCount: data.totalSpools,
      // #575.5: count every group the inventory is spread across, including
      // the synthetic "no location" bucket when it holds spools. Counting
      // only real locations rendered "LOCATIONS 0" while 13 spools sat under
      // "No location" — confusing, and out of step with the groups actually
      // shown on the page. (Empty groups are never emitted by the
      // aggregation, so this is exactly the number of buckets on screen.)
      locationCount: data.groups.length,
      totalGrams: data.groups.reduce((s, g) => s + g.totalGrams, 0),
    };
  }, [data]);

  // GH #795: regroup (location / type / vendor / none) + sort within each
  // group. Pure transform over the already-search-filtered rows — the
  // by-location payload carries filamentType / filamentVendor / dates / weights
  // per row, so switching grouping or sorting needs no server round-trip. Each
  // group's count + remaining-gram total are recomputed inside the helper.
  const displayGroups = useMemo(
    () => groupAndSortInventory(filteredGroups, groupBy, sortKey, sortDir),
    [filteredGroups, groupBy, sortKey, sortDir],
  );

  // For the inline edit handlers we use the existing per-spool PUT —
  // the same one the SpoolCard component uses on the filament detail
  // page — so retire / move / weight-update semantics stay identical
  // across both surfaces.
  const updateSpool = useCallback(
    async (row: SpoolRow, patch: Record<string, unknown>): Promise<boolean> => {
      const res = await fetch(`/api/filaments/${row.filamentId}/spools/${row._id}`, {
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

  // GH #420: rows currently selected AND visible in the filtered view.
  // A row that scrolled out via a search refinement still lives in
  // `selectedKeys` (so changing filter back resurrects it) but doesn't
  // count toward the action-bar tally — the user only sees what they
  // can act on.
  //
  // Codex P2 on PR #476 round 2: ALSO skip rows whose group is
  // currently collapsed. The user can't see those rows, so including
  // them in the batch count + applying move/retire to them would be
  // the same hidden-write surprise this selection logic exists to
  // avoid. Collapsing a group with selected rows quietly drops them
  // from the action-bar tally; re-expanding the group re-includes them
  // (the underlying selection set is unchanged so the round-trip is
  // lossless).
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

  // GH #420: run the same PUT for every selected row, sequentially so
  // a transient failure doesn't trigger a thundering-herd of retries.
  // Surface partial-success ("3 of 5") explicitly because dropping the
  // failed-row count silently would be a data-loss-shaped UX surprise.
  const applyBatchPatch = useCallback(
    async (patch: Record<string, unknown>): Promise<void> => {
      if (visibleSelectedRows.length === 0) return;
      setBatchBusy(true);
      let okCount = 0;
      let failCount = 0;
      // Codex P2 on PR #476 round 2: wrap the per-row loop in try/finally
      // so a network rejection (LAN drop before the fetch resolves) can't
      // escape with `batchBusy` still true. Pre-fix, the sticky action
      // bar stayed disabled with the same selection and no aggregate
      // toast — the user had no signal that the batch had failed.
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
            {types.map((tp) => (
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
            {vendors.map((vn) => (
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
            onChange={(e) => setGroupBy(e.target.value as InventoryGroupBy)}
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
              onChange={(e) => setSortKey(e.target.value as InventorySortKey)}
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
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
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
            onChange={(e) => setIncludeRetired(e.target.checked)}
            className="accent-blue-600"
          />
          {t("inventory.filter.includeRetired")}
        </label>
      </div>

      {/* GH #420: batch-action bar — appears only when at least one
          visible spool is selected. Sticky to the top of the viewport
          so a user scrolling a long shelf list keeps the controls in
          reach. Hits the same per-spool PUT the inline edits use, so
          retire/move semantics stay consistent across the page. */}
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
        // GH #449: skeleton placeholders instead of a single "Loading…"
        // line. Three card-shaped blocks mirror the group cards that
        // arrive once the fetch completes, so the layout doesn't
        // reflow when content lands.
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
            // GH #795: the header label depends on the grouping mode — the
            // location name (+ kind/humidity) when grouped by location, the
            // type/vendor value otherwise, and a generic label for the
            // ungrouped / no-value buckets.
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
            return (
              <section
                key={key}
                className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => toggleCollapse(key)}
                  aria-expanded={!isCollapsed}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-900/50 hover:bg-gray-100 dark:hover:bg-gray-900 text-left"
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
                    {/* GH #528: proper pluralization — "1 spool" / "2 spools",
                        "1 Spule" / "2 Spulen". inventory.group.summary
                        stays as a no-suffix fallback so any stale callers
                        keep working, but this site uses the singular/
                        plural variants the renderer picks based on count. */}
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
                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b border-gray-200 dark:border-gray-800 text-xs text-gray-500">
                        <tr>
                          <th scope="col" className="w-8 py-2 px-2">
                            {/* GH #420: header checkbox toggles the
                                whole group's selection in/out. Indeterminate
                                when partial, checked when all rows
                                selected. */}
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
    </main>
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
  const { t } = useTranslation();
  const { formatDate } = useDateFormat();
  const { formatGrams } = useNumberFormat();
  const grams = remainingGrams(row);
  const pct = remainingPct(row);

  // Inline weight editor — opens on click, saves on Enter / Save button.
  const [editingWeight, setEditingWeight] = useState(false);
  const [weightDraft, setWeightDraft] = useState(row.totalWeight?.toString() ?? "");
  const [saving, setSaving] = useState(false);

  const saveWeight = async () => {
    // GH #509: short-circuit re-entry while a save is in flight. The
    // Save button is `disabled={saving}` so the click path is safe,
    // but the input's onKeyDown Enter handler kept firing during the
    // in-flight PUT — holding Enter (or two-tapping on a slow link)
    // raced a second PUT against the refresh. Mirrors the
    // movePending / retirePending guards added for #404.
    if (saving) return;
    const n = Number(weightDraft);
    if (!Number.isFinite(n) || n < 0) return;
    setSaving(true);
    const ok = await updateSpool(row, { totalWeight: n });
    setSaving(false);
    if (ok) {
      setEditingWeight(false);
      onChanged();
    }
  };

  // GH #404: the move-to <select> and retire button used to fire
  // PUTs without a busy guard. On a slow LAN (Pi-hosted instance,
  // etc.) a second click would race the first PUT; on retire toggle
  // the response order could end in the wrong state. Per-handler
  // saving flags disable the matching control until the round-trip
  // completes. The weight editor already did this via its own
  // `saving` state.
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
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="inline-block w-3.5 h-3.5 rounded-full border border-gray-300 dark:border-gray-700 shrink-0"
              style={{ backgroundColor: row.filamentColor || "#808080" }}
              aria-hidden="true"
            />
            <Link href={`/filaments/${row.filamentId}`} className="text-blue-600 hover:underline truncate">
              {row.filamentName}
            </Link>
            <span className="text-xs text-gray-500 shrink-0">{row.filamentType}</span>
          </div>
          <div className="text-xs text-gray-500 truncate">{row.filamentVendor}</div>
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
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block w-3.5 h-3.5 rounded-full border border-gray-300 dark:border-gray-700 shrink-0"
            style={{ backgroundColor: row.filamentColor || "#808080" }}
            aria-hidden="true"
          />
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
      </td>
      <td className="py-2 px-3">
        <div className="font-medium">{row.label || <span className="text-gray-400 italic">{t("inventory.unnamed")}</span>}</div>
        {/* #732 Phase 4: the per-spool id (read-only; edit on the detail page). */}
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
          <span className="inline-flex items-center gap-1">
            <input
              type="number"
              min="0"
              step="1"
              autoFocus
              value={weightDraft}
              onChange={(e) => setWeightDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveWeight();
                if (e.key === "Escape") {
                  setWeightDraft(row.totalWeight?.toString() ?? "");
                  setEditingWeight(false);
                }
              }}
              aria-label={t("inventory.updateWeight")}
              className="w-20 px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
            />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={saveWeight}
              disabled={saving}
              className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "…" : t("common.save")}
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setWeightDraft(row.totalWeight?.toString() ?? "");
                setEditingWeight(false);
              }}
              className="px-2 py-0.5 border border-gray-300 dark:border-gray-700 rounded text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              {t("common.cancel")}
            </button>
          </span>
        ) : (
          // GH #445: visible affordance for the inline weight editor.
          // Pre-fix the trigger rendered in default text color with
          // no underline, no icon, no hover ring — keyboard users
          // tabbed past it without realising it was editable. Adding
          // a pencil indicator + a dotted underline matches the
          // visual idiom for "click to edit" used elsewhere in the
          // app (SpoolCard label edit).
          <button
            type="button"
            onClick={() => {
              // GH #640: reseed the draft from the current row value on
              // open. The row survives fetchInventory() refreshes (stable
              // key), so the once-seeded useState value goes stale when
              // the weight changed server-side — opening then saving
              // would write the old weight back. Mirrors the GH #263
              // SpoolCard label-edit fix.
              setWeightDraft(row.totalWeight?.toString() ?? "");
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
            {/* GH #443: dry-cycle count was buried inside a title=
                tooltip — touch-only iPad / tablet users never see it.
                Surface as a visible chip next to the date. */}
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
          {/* GH #806: show the spool's CURRENT location selected (not a static
              "Move to…" placeholder), and let the user change it. Mirrors the
              home-page spool dropdown: value "" is the "No location" option, so
              moveTo("") clears the location. Controlled by row.locationId, which
              refreshes after a successful move. */}
          <select
            value={row.locationId ?? ""}
            disabled={movePending}
            onChange={(e) => moveTo(e.target.value)}
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
 * GH #420: header checkbox in each group's table that mirrors the
 * three states the selection set can be in for this group's rows:
 *   - none selected → unchecked
 *   - some selected → indeterminate (browsers render a dash)
 *   - all selected → checked
 *
 * Click toggles the whole group: full→empty when fully selected,
 * partial/empty→full otherwise. Using `useRef` to set the
 * `indeterminate` property because there's no React JSX attribute
 * for it.
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
        // Drop every row in this group from the selection.
        for (const r of rows) next.delete(spoolKey(r));
      } else {
        // Add every row in this group.
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

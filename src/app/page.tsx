"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import ImportAtlasDialog from "@/components/ImportAtlasDialog";
import PrusamentImportDialog from "@/components/PrusamentImportDialog";
import SpoolCsvImportDialog from "@/components/SpoolCsvImportDialog";
import QuickFilterChips, { type QuickFilter } from "@/components/QuickFilterChips";
import FilamentSwatch from "@/components/FilamentSwatch";
import FinishChip from "@/components/FinishChip";
import { Skeleton, SkeletonRegion } from "@/components/Skeleton";
import { deriveFinish } from "@/lib/filamentFinish";
import { deriveArrangement } from "@/lib/filamentColors";
import { useCurrency } from "@/hooks/useCurrency";
import { useTranslation } from "@/i18n/TranslationProvider";
import type { FilamentSummary } from "@/types/filament";
import { getRemainingGrams, getRemainingPct, getSpoolCount } from "@/lib/inventoryStats";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { compareFilaments, nextSortState, earliestSpoolDate, type SortKey, type SortDir } from "@/lib/sortFilamentList";
import { useDateFormat } from "@/hooks/useDateFormat";
import { buildFilamentGroups } from "@/lib/groupFilaments";

type Filament = FilamentSummary;

function isLowStock(f: Filament): boolean {
  const threshold = f.lowStockThreshold;
  if (!threshold || threshold <= 0) return false;
  const remaining = getRemainingGrams(f);
  return remaining !== null && remaining < threshold;
}

function SortIcon({ column, sortKey, sortDir }: { column: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  const isActive = column === sortKey;
  return (
    <span className="inline-flex flex-col ml-1 leading-none -mb-0.5" aria-hidden="true">
      <span className={`text-xs leading-none ${isActive && sortDir === "asc" ? "text-blue-500" : "text-gray-400"}`}>&#9650;</span>
      <span className={`text-xs leading-none ${isActive && sortDir === "desc" ? "text-blue-500" : "text-gray-400"}`}>&#9660;</span>
    </span>
  );
}

interface GroupedFilament {
  parent: Filament;
  variants: Filament[];
}

function FilamentStats({ filaments }: { filaments: Filament[] }) {
  const { t } = useTranslation();
  const byType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of filaments) {
      counts.set(f.type, (counts.get(f.type) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [filaments]);

  const byVendor = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of filaments) {
      counts.set(f.vendor, (counts.get(f.vendor) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [filaments]);

  const colorGroups = useMemo(() => {
    const counts = new Map<string, { color: string; count: number }>();
    for (const f of filaments) {
      const hex = (f.color || "#808080").toLowerCase();
      const existing = counts.get(hex);
      if (existing) {
        existing.count++;
      } else {
        counts.set(hex, { color: hex, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [filaments]);

  const maxType = byType.length > 0 ? byType[0][1] : 1;
  const maxVendor = byVendor.length > 0 ? byVendor[0][1] : 1;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-800">
      {/* By Type */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{t("filaments.stats.byType")}</h3>
        <div className="space-y-1.5">
          {byType.map(([type, count]) => (
            <div key={type} className="flex items-center gap-2 text-sm">
              {/* w-24 matches the vendor row below (was w-16, which clipped
                  "PLA Tough" to "PLA TO…" — GH #89). title= is the
                  fallback for any type name that still exceeds 96px. */}
              <span title={type} className="w-24 truncate text-gray-600 dark:text-gray-300 font-medium">{type}</span>
              <div className="flex-1 bg-gray-200 dark:bg-gray-800 rounded-full h-3">
                <div
                  className="h-3 rounded-full bg-blue-500"
                  style={{ width: `${(count / maxType) * 100}%` }}
                />
              </div>
              <span className="text-xs text-gray-500 w-6 text-right">{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* By Vendor */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{t("filaments.stats.byVendor")}</h3>
        <div className="space-y-1.5">
          {byVendor.map(([vendor, count]) => (
            <div key={vendor} className="flex items-center gap-2 text-sm">
              <span title={vendor} className="w-24 truncate text-gray-600 dark:text-gray-300 font-medium">{vendor}</span>
              <div className="flex-1 bg-gray-200 dark:bg-gray-800 rounded-full h-3">
                <div
                  className="h-3 rounded-full bg-amber-500"
                  style={{ width: `${(count / maxVendor) * 100}%` }}
                />
              </div>
              <span className="text-xs text-gray-500 w-6 text-right">{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* By Color */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          {t("filaments.stats.colors", { count: colorGroups.length })}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {colorGroups.map(({ color, count }) => (
            <div
              key={color}
              className="relative group"
              title={`${color} (${count})`}
            >
              <div
                className="w-6 h-6 rounded-full border border-gray-400 dark:border-gray-600"
                style={{ backgroundColor: color }}
                aria-label={t("swatch.colorSwatch", { color })}
              />
              {count > 1 && (
                <span className="absolute -top-1.5 -right-1.5 bg-gray-700 text-white text-[9px] w-3.5 h-3.5 rounded-full flex items-center justify-center leading-none">
                  {count}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// #831: persist the home list's sort across reloads (mirrors the /inventory
// prefs pattern, #795). Only sort is persisted — persisting the type/vendor/
// quick filters would land a returning user on a filtered subset of their
// catalog, which reads as "filaments missing". Loaded post-mount so SSR /
// first paint stay on defaults (no hydration mismatch).
const HOME_PREFS_KEY = "filamentdb-home-prefs";
const SORT_KEY_VALUES: SortKey[] = ["name", "vendor", "type", "nozzle", "bed", "cost", "remaining", "purchased", "opened"];

function loadHomePrefs(): { sortKey: SortKey; sortDir: SortDir } {
  if (typeof window === "undefined") return { sortKey: "name", sortDir: "asc" };
  try {
    const raw = window.localStorage.getItem(HOME_PREFS_KEY);
    if (!raw) return { sortKey: "name", sortDir: "asc" };
    const p = JSON.parse(raw) as { sortKey?: unknown; sortDir?: unknown };
    return {
      sortKey: SORT_KEY_VALUES.includes(p.sortKey as SortKey) ? (p.sortKey as SortKey) : "name",
      sortDir: p.sortDir === "desc" ? "desc" : "asc",
    };
  } catch {
    return { sortKey: "name", sortDir: "asc" };
  }
}

export default function Home() {
  const { t } = useTranslation();
  const { format: formatCurrency } = useCurrency();
  const { formatDate } = useDateFormat();
  const { formatGrams } = useNumberFormat();
  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const [typeFilter, setTypeFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [types, setTypes] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [showStats, setShowStats] = useState(false);
  // Main list hides filaments with no active (non-retired) spools by default —
  // retiring the last spool drops it off the main screen without deleting it
  // (re-adding / un-retiring a spool brings it back). Toggle to reveal them.
  const [showOutOfStock, setShowOutOfStock] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // #831: gate the persist effect so it doesn't fire on the default state
  // before the post-mount load runs.
  const homePrefsLoaded = useRef(false);
  const [importing, setImporting] = useState(false);
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  // #717: per-filament spool panel (location display + quick change). Keyed by
  // filament id. Separate from expandedParents (which toggles parent→variants).
  const [expandedSpools, setExpandedSpools] = useState<Set<string>>(new Set());
  const [locations, setLocations] = useState<{ _id: string; name: string; kind: string }[]>([]);
  // Set of `${filamentId}:${spoolId}` keys with a location change in flight, so
  // each spool's dropdown disables independently. A Set (not a single key) so
  // concurrent moves don't re-enable each other's select mid-request (Codex P2
  // on PR #721) — only the completed key is cleared.
  const [pendingMoves, setPendingMoves] = useState<Set<string>>(new Set());
  const [showAtlasImport, setShowAtlasImport] = useState(false);
  const [showPrusamentImport, setShowPrusamentImport] = useState(false);
  const [showSpoolCsvImport, setShowSpoolCsvImport] = useState(false);
  const [showImportExport, setShowImportExport] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // GH #525.2: track live progress + allow aborting a long bulk delete.
  // `bulkProgress` is { done, total } while a delete is running so the
  // button can show "Deleting 12/40" instead of an indeterminate spinner.
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const bulkAbortRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importExportRef = useRef<HTMLDivElement>(null);
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  const [stickyHeaderHeight, setStickyHeaderHeight] = useState(0);
  const { toast } = useToast();
  const confirm = useConfirm();

  const fetchFilamentsRef = useRef<AbortController | null>(null);
  // GH #292: dedicated controller for the post-import filter-options
  // refresh, aborted on unmount so it can't setState after the page is
  // gone or race the main list fetch un-cancellably.
  const filterOptionsAcRef = useRef<AbortController | null>(null);
  useEffect(() => () => filterOptionsAcRef.current?.abort(), []);

  // #831: load the persisted sort post-mount (SSR / first paint use defaults to
  // avoid a hydration mismatch), then persist on change. Mirrors /inventory.
  useEffect(() => {
    const p = loadHomePrefs();
    setSortKey(p.sortKey); // eslint-disable-line react-hooks/set-state-in-effect -- persisted prefs
    setSortDir(p.sortDir);
    homePrefsLoaded.current = true;
  }, []);
  useEffect(() => {
    if (!homePrefsLoaded.current) return;
    try {
      window.localStorage.setItem(HOME_PREFS_KEY, JSON.stringify({ sortKey, sortDir }));
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [sortKey, sortDir]);

  // #717: load locations for the per-spool "move to" dropdowns. Best-effort —
  // if it fails the panel just shows the ids' current selection with no
  // options, and the rest of the page is unaffected.
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/locations", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => setLocations(Array.isArray(list) ? list : []))
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // Debounce search input by 300ms
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Track sticky header height for positioning the table thead below it
  useEffect(() => {
    const el = stickyHeaderRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setStickyHeaderHeight(el.offsetHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fetchFilaments = useCallback(async () => {
    // Abort previous in-flight request to prevent stale data
    fetchFilamentsRef.current?.abort();
    const controller = new AbortController();
    fetchFilamentsRef.current = controller;

    setLoading(true);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (typeFilter) params.set("type", typeFilter);
    if (vendorFilter) params.set("vendor", vendorFilter);

    try {
      const res = await fetch(`/api/filaments?${params}`, { signal: controller.signal });
      if (!res.ok) {
        toast(t("filaments.loadError"), "error");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setFilaments(data);
      // Derive filter options from unfiltered results (initial load / no filters)
      if (!debouncedSearch && !typeFilter && !vendorFilter) {
        const typeList = [...new Set(data.map((f: Filament) => f.type))].sort() as string[];
        const vendorList = [...new Set(data.map((f: Filament) => f.vendor))].sort() as string[];
        setTypes(typeList);
        setVendors(vendorList);
      }
      setLoading(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast(t("filaments.loadError"), "error");
      setLoading(false);
    }
  }, [debouncedSearch, typeFilter, vendorFilter, toast, t]);

  // Refresh the type / vendor filter dropdowns from the full, unfiltered
  // filament list. fetchFilaments only recomputes these when no filter
  // is active, so an import performed while a filter is on would leave
  // the dropdowns stale without this. GH #292: own AbortController so it
  // doesn't race the main list fetch un-cancellably or setState after
  // unmount.
  const refreshFilterOptions = useCallback(async () => {
    filterOptionsAcRef.current?.abort();
    const ac = new AbortController();
    filterOptionsAcRef.current = ac;
    try {
      const res = await fetch("/api/filaments", { signal: ac.signal });
      if (!res.ok) return;
      const all = await res.json();
      if (ac.signal.aborted) return;
      setTypes([...new Set(all.map((f: Filament) => f.type))].sort() as string[]);
      setVendors([...new Set(all.map((f: Filament) => f.vendor))].sort() as string[]);
    } catch (err) {
      // Non-fatal — the list itself still refreshed via fetchFilaments.
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }, []);

  // Close import/export dropdown on outside click
  useEffect(() => {
    if (!showImportExport) return;
    const handleClick = (e: MouseEvent) => {
      if (importExportRef.current && !importExportRef.current.contains(e.target as Node)) {
        setShowImportExport(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showImportExport]);

  useEffect(() => {
    // Fetch whenever search/filter deps change. fetchFilaments sets loading=true
    // synchronously, which the set-state-in-effect rule flags, but this is the
    // standard fetch-on-param-change pattern with AbortController.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchFilaments();
  }, [fetchFilaments]);

  // Refetch when an Electron sync cycle finishes — picks up parent links
  // and variant edits that landed from another device without waiting for
  // the user to navigate away and back (GH #127). No-op in the web app.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onSyncComplete) return;
    return api.onSyncComplete(() => {
      fetchFilaments();
    });
  }, [fetchFilaments]);

  // Inventory aggregates exclude parent filaments. Parents don't
  // represent a physical roll on the shelf — they're a template for
  // their color variants (the variants own the spools, calibrations,
  // and remaining weight). Counting them in totals double-counted what
  // the user actually has and made "By Type" / "By Vendor" disagree
  // with the headline number. Auto-detected via the `hasVariants` flag
  // shipped by `/api/filaments`; parents collapse out of every count
  // here but still render in the list as grouping headers.
  const inventoryFilaments = useMemo(
    () => filaments.filter((f) => !f.hasVariants),
    [filaments],
  );

  // #575.1: the header type/vendor counts derive from the CURRENTLY-FETCHED
  // set (which already reflects the search / type / vendor filters), not the
  // global `types`/`vendors` dropdown options — otherwise filtering updates
  // the filament count while "21 type(s) · 18 vendor(s)" stays frozen.
  const filteredTypeCount = useMemo(
    () => new Set(inventoryFilaments.map((f) => f.type)).size,
    [inventoryFilaments],
  );
  const filteredVendorCount = useMemo(
    () => new Set(inventoryFilaments.map((f) => f.vendor)).size,
    [inventoryFilaments],
  );

  // #616: total active spools + distinct spool locations, for the headline
  // stat line. Counts every non-retired spool across the fetched set —
  // parents included, since a parent can carry its own roll (see the #552
  // note on `hasSpools`).
  const spoolStats = useMemo(() => {
    let spools = 0;
    const locations = new Set<string>();
    // Active spools with no location count as one synthetic "no location"
    // bucket, exactly like the Inventory page's location total (it derives
    // `locationCount` from `groups.length`, which includes that bucket).
    // Without it, a shelf of unassigned spools reads "13 spool(s) in 0
    // location(s)" — confusing, and out of step with /inventory (Codex P2
    // on #658).
    let hasUnlocated = false;
    for (const f of filaments) {
      // getSpoolCount handles the legacy single-spool shape (empty spools[]
      // but a top-level totalWeight) and excludes retired spools, matching
      // the "Has spools" chip and the list helpers — a manual `f.spools`
      // loop would undercount pre-migration rows (Codex P2 on #658).
      const count = getSpoolCount(f);
      spools += count;
      if (f.spools && f.spools.length > 0) {
        for (const s of f.spools) {
          if (s.retired) continue;
          if (s.locationId) locations.add(String(s.locationId));
          else hasUnlocated = true;
        }
      } else if (count > 0) {
        // Legacy single-spool row — no subdocument, so it's unassigned.
        hasUnlocated = true;
      }
    }
    return { spools, locations: locations.size + (hasUnlocated ? 1 : 0) };
  }, [filaments]);

  // Group filaments: parents with their variants, standalone filaments as-is
  // Client-side quick filter (low stock / has spools / missing calibrations).
  // Applied before grouping so a parent whose variants are filtered out is
  // still shown standalone if it matches itself.
  const quickFilterCounts = useMemo(() => {
    const counts: Record<QuickFilter, number> = {
      all: inventoryFilaments.length,
      lowStock: 0,
      hasSpools: 0,
      noCalibration: 0,
    };
    for (const f of inventoryFilaments) {
      if (isLowStock(f)) counts.lowStock++;
      if (!f.hasCalibrations) counts.noCalibration++;
    }
    // #552: "Has spools" is a presence check, not an inventory aggregate.
    // A parent is excluded from `inventoryFilaments` because its gram/spool
    // totals live on its variants — but a parent can still carry its OWN
    // spool, and that roll is real. Count every filament with its own
    // spool, parents included, so the chip badge matches the rows the
    // filter renders (see the matching source switch in `visibleFilaments`).
    counts.hasSpools = filaments.filter(
      (f) => (f.spools?.length ?? 0) > 0,
    ).length;
    return counts;
  }, [filaments, inventoryFilaments]);

  // "Out of stock" = no active (non-retired) spools. Parents own no spools, so
  // a parent counts as in-stock when any of its variants is — otherwise hiding
  // out-of-stock would drop a parent whose variants are fully stocked.
  const parentsWithStock = useMemo(() => {
    const s = new Set<string>();
    for (const f of filaments) {
      if (f.parentId && getSpoolCount(f) > 0) s.add(f.parentId);
    }
    return s;
  }, [filaments]);
  const inStock = useCallback(
    (f: Filament) => getSpoolCount(f) > 0 || parentsWithStock.has(f._id),
    [parentsWithStock],
  );
  // Count of hidden inventory rows — drives the toggle's badge. Parents are
  // grouping headers (not stock). A variant of a STOCKED family is now always
  // rendered under its parent (#786), so it isn't "hidden" even with no spool
  // of its own — only standalone rows and variants of a fully-out-of-stock
  // family are actually hidden by the default filter.
  const outOfStockCount = useMemo(() => {
    const shownParents = new Set(
      filaments.filter((f) => f.hasVariants && inStock(f)).map((f) => f._id),
    );
    return filaments.filter((f) => {
      if (f.hasVariants) return false;
      if (getSpoolCount(f) > 0) return false;
      if (f.parentId && shownParents.has(f.parentId)) return false;
      return true;
    }).length;
  }, [filaments, inStock]);

  // #847: when NOTHING is in stock (e.g. a catalog with 0 spools), the "all"
  // view falls back to showing every filament, so the "Show out of stock"
  // toggle would be a no-op — suppress it unless at least one filament is
  // actually in stock (i.e. the hide is genuinely hiding something).
  const hasAnyInStock = useMemo(() => filaments.some(inStock), [filaments, inStock]);

  const visibleFilaments = useMemo(() => {
    // The "all" view keeps parents in the dataset so the list renders them as
    // grouping headers above their color variants. By default it hides
    // out-of-stock filaments (no active spools); the toggle reveals them.
    // The hide runs ONLY on the UNFILTERED view: search/type/vendor are applied
    // server-side, so a filtered response can return a parent WITHOUT its
    // (stocked) variants — parentsWithStock would then miss it and wrongly hide
    // the family. While a filter is active, show every match in or out of stock
    // (Codex P2 on #712).
    if (quickFilter === "all") {
      const filterActive = !!debouncedSearch || !!typeFilter || !!vendorFilter;
      if (showOutOfStock || filterActive) return filaments;
      const inStockList = filaments.filter(inStock);
      // #847: don't let the default out-of-stock hide empty the unfiltered "All"
      // view. A catalog with nothing in stock (e.g. filaments but 0 spools)
      // would otherwise render "No filaments match" under "All (N)". Show
      // everything when there's nothing to declutter to; the #712 hide still
      // applies whenever at least one filament IS stocked.
      return inStockList.length === 0 ? filaments : inStockList;
    }
    // #552: "Has spools" resolves against the full list (parents
    // included) because a parent carrying its own spool genuinely has
    // one — see the matching note in `quickFilterCounts`. Dropping it
    // here is what made the filter return no rows for a parent whose
    // only spool sat on the parent itself.
    if (quickFilter === "hasSpools") {
      return filaments.filter((f) => (f.spools?.length ?? 0) > 0);
    }
    // Every other filter resolves against `inventoryFilaments` instead —
    // otherwise the chip badge (derived from `inventoryFilaments`, see
    // `quickFilterCounts` above) disagrees with the rendered row count
    // whenever a parent happens to match the filter criterion.
    // `noCalibration` is the obvious case: a parent without calibrations
    // would otherwise appear in the list even though the badge excluded
    // it from the count. Codex round-1 P2 on PR #356.
    return inventoryFilaments.filter((f) => {
      if (quickFilter === "lowStock") return isLowStock(f);
      if (quickFilter === "noCalibration") return !f.hasCalibrations;
      return true;
    });
  }, [filaments, inventoryFilaments, quickFilter, showOutOfStock, inStock, debouncedSearch, typeFilter, vendorFilter]);

  // Parent lookup built from the *full* filament list so variant
  // enrichment (inherited nozzle/bed/cost/density/spool/net) works
  // even when the parent has been filtered out of `visibleFilaments`.
  // Codex round-2 P2 on PR #356 — previously the inheritance merge in
  // `groupedFilaments` only ran when a parent row was present in
  // `visibleFilaments`, so on filtered views (e.g. `noCalibration`)
  // orphaned variants rendered with `—` for fields they should
  // inherit from their parent.
  const parentLookup = useMemo(() => {
    const map = new Map<string, Filament>();
    for (const f of filaments) {
      if (!f.parentId) map.set(f._id, f);
    }
    return map;
  }, [filaments]);

  const groupedFilaments = useMemo(() => {
    // Apply parent-field fallbacks to a variant so inherited nozzle/bed/cost/
    // density/spool values render even when the variant left them blank.
    const enrichVariant = (v: Filament, parent: Filament | undefined): Filament => {
      if (!parent) return v;
      return {
        ...v,
        temperatures: {
          nozzle: v.temperatures?.nozzle ?? parent.temperatures?.nozzle,
          bed: v.temperatures?.bed ?? parent.temperatures?.bed,
        },
        cost: v.cost ?? parent.cost,
        density: v.density ?? parent.density,
        spoolWeight: v.spoolWeight ?? parent.spoolWeight,
        netFilamentWeight: v.netFilamentWeight ?? parent.netFilamentWeight,
      };
    };

    // #744 / #786: in the unfiltered "all" view a shown parent's group carries
    // EVERY variant from the full fetched list, not just those left after the
    // #712 out-of-stock hide — there the hide is a visibility declutter, not a
    // content filter, so a shown family shows all its colors and the chip
    // (rendered as group.variants.length below) counts them all.
    //
    // Under a CONTENT filter the variants must respect it, so source from
    // `visibleFilaments` instead (Codex P2 on #788): otherwise a parent visible
    // under `hasSpools` (its own spool) would pull in no-spool variants the
    // filter excluded, and expand → select-all would then include them.
    // (`lowStock`/`noCalibration` drop parents entirely, so they have no group
    // either way.) When a server-side search/type/vendor filter is active,
    // `quickFilter` is "all" but `filaments` is already that filtered set.
    const variantSource = quickFilter === "all" ? filaments : visibleFilaments;
    const { groups, standalone } = buildFilamentGroups(variantSource, visibleFilaments, {
      enrichVariant,
      parentLookup,
    });

    const all: (Filament | GroupedFilament)[] = [...groups, ...standalone];
    const cmp = compareFilaments(sortKey, sortDir);
    all.sort((a, b) => {
      const fa = "parent" in a ? a.parent : a;
      const fb = "parent" in b ? b.parent : b;
      return cmp(fa, fb);
    });

    return all;
  }, [filaments, visibleFilaments, parentLookup, quickFilter, sortKey, sortDir]);

  const toggleExpanded = (parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  };

  // #717: expand/collapse a filament's per-spool panel.
  const toggleSpools = (filamentId: string) => {
    setExpandedSpools((prev) => {
      const next = new Set(prev);
      if (next.has(filamentId)) next.delete(filamentId);
      else next.add(filamentId);
      return next;
    });
  };

  // #717: change one spool's location from the home page. Optimistically
  // patches local state (location isn't a filter/sort/visibility input, so the
  // row stays put and the panel stays open) instead of a full refetch that
  // would collapse the expansion. PUT is same-origin so the CSRF guard passes.
  const moveSpool = useCallback(
    async (filamentId: string, spoolId: string, locationId: string | null) => {
      const key = `${filamentId}:${spoolId}`;
      setPendingMoves((prev) => new Set(prev).add(key));
      try {
        const res = await fetch(`/api/filaments/${filamentId}/spools/${spoolId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locationId }),
        });
        if (!res.ok) {
          toast(t("filaments.spools.moveError"), "error");
          return;
        }
        setFilaments((prev) =>
          prev.map((f) =>
            f._id === filamentId
              ? {
                  ...f,
                  spools: f.spools?.map((s) =>
                    s._id === spoolId ? { ...s, locationId } : s,
                  ) ?? [],
                }
              : f,
          ),
        );
      } catch {
        toast(t("filaments.spools.moveError"), "error");
      } finally {
        // Clear ONLY this key so a concurrent move on another spool keeps its
        // select disabled until its own request settles.
        setPendingMoves((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [toast, t],
  );

  const handleSort = (key: SortKey) => {
    const next = nextSortState({ sortKey, sortDir }, key);
    setSortKey(next.sortKey);
    setSortDir(next.sortDir);
  };

  /** GH #500: Select-all and bulk delete operate on the CURRENTLY VISIBLE
   *  rows only — not the full fetched set. Pre-fix, ticking the header
   *  checkbox while a quick-filter chip was active selected every fetched
   *  filament including invisible rows, and the bulk delete then
   *  soft-deleted all of them with no UI cue. Mirrors the inventory
   *  page's #420 pattern. Flatten parents + variants so a group whose
   *  parent passed the filter pulls in its visible children too. */
  const visibleFilamentIds = useMemo(() => {
    const ids: string[] = [];
    for (const item of groupedFilaments) {
      if ("parent" in item) {
        ids.push(item.parent._id);
        // Codex P2 round 2 on PR #540: a collapsed parent group does
        // NOT render its variant rows (renderParentRow only calls
        // renderRow for variants when expanded), so they have no
        // visible checkbox. Including them here would let select-all
        // tick + bulk-delete hidden variants with no UI cue — the
        // exact no-cue-deletion bug #500 was about. Only count variant
        // ids as visible when the parent is actually expanded.
        if (expandedParents.has(item.parent._id)) {
          for (const v of item.variants) ids.push(v._id);
        }
      } else {
        ids.push(item._id);
      }
    }
    return ids;
  }, [groupedFilaments, expandedParents]);

  // Codex P2 round 1 on PR #540: derive select-all state by MEMBERSHIP,
  // not a count comparison. `selected.size === visible.length` is wrong
  // when the user has N hidden rows selected and the filter now shows N
  // DIFFERENT visible rows — the count matches but none of the visible
  // rows are actually selected, so the header checkbox renders "checked"
  // and a click would CLEAR the hidden selection instead of selecting
  // the visible rows. Membership check: every visible id present.
  const visibleSelectedCount = useMemo(
    () => visibleFilamentIds.filter((id) => selected.has(id)).length,
    [visibleFilamentIds, selected],
  );
  const allVisibleSelected =
    visibleFilamentIds.length > 0 &&
    visibleSelectedCount === visibleFilamentIds.length;

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    // When every visible row is already selected, clear ONLY the visible
    // rows (preserve any off-screen selection the user might still want);
    // otherwise add all visible rows to the selection.
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleFilamentIds) next.delete(id);
      } else {
        for (const id of visibleFilamentIds) next.add(id);
      }
      return next;
    });
  };

  const handleBulkDelete = async () => {
    // GH #500: intersect against visible IDs at delete time too — if the
    // user toggles a filter AFTER selecting, the count + deletion target
    // should reflect what they currently SEE. Selections that fell out
    // of view are dropped (the same posture inventory uses).
    const visibleSet = new Set(visibleFilamentIds);
    const targets = Array.from(selected).filter((id) => visibleSet.has(id));
    const count = targets.length;
    if (count === 0) return;
    if (!(await confirm({ message: t("filaments.deleteConfirm", { count }), destructive: true, confirmLabel: t("common.delete") }))) return;
    bulkAbortRef.current = false;
    setBulkDeleting(true);
    setBulkProgress({ done: 0, total: count });
    let deleted = 0;
    const errors: string[] = [];
    const succeeded = new Set<string>();
    let aborted = false;
    for (const id of targets) {
      // GH #525.2: honour an abort request between rows. In-flight rows
      // already issued aren't interrupted, but no further deletes start.
      if (bulkAbortRef.current) {
        aborted = true;
        break;
      }
      const res = await fetch(`/api/filaments/${id}`, { method: "DELETE" });
      if (res.ok) {
        deleted++;
        succeeded.add(id);
      } else {
        const body = await res.json().catch(() => null);
        const name = filaments.find((f) => f._id === id)?.name ?? id;
        errors.push(body?.error || t("filaments.deleteError", { name }));
      }
      setBulkProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
    }
    if (deleted > 0) {
      toast(
        aborted
          ? t("filaments.bulk.abortedCount", { count: deleted })
          : t("filaments.deletedCount", { count: deleted }),
      );
    }
    // GH #525.2: aggregate failures into a single scrollable dialog instead
    // of one ever-growing toast that overflows the screen on a large batch.
    if (errors.length > 0) {
      const MAX_SHOWN = 10;
      const shown = errors.slice(0, MAX_SHOWN);
      const overflow = errors.length - shown.length;
      const lines = shown.join("\n") + (overflow > 0 ? "\n" + t("filaments.bulk.errorsOverflow", { count: overflow }) : "");
      await confirm({
        title: t("filaments.bulk.errorsTitle", { count: errors.length }),
        message: lines,
        confirmLabel: t("common.close"),
        hideCancel: true,
      });
    }
    setBulkProgress(null);
    setBulkDeleting(false);
    // Drop only the rows we actually deleted from the selection so a user
    // who aborted (or hit per-row failures) keeps the un-processed rows
    // selected and can retry.
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of succeeded) next.delete(id);
      return next;
    });
    fetchFilaments();
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.split(".").pop()?.toLowerCase();
    let endpoint = "/api/filaments/import";
    if (ext === "csv") endpoint = "/api/filaments/import-csv";
    else if (ext === "xlsx") endpoint = "/api/filaments/import-xlsx";

    setImporting(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        toast(data.message);
        fetchFilaments();
        refreshFilterOptions();
      } else {
        toast(t("filaments.importFailed", { error: data.error }), "error");
      }
    } catch {
      toast(t("filaments.importNetworkError"), "error");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const thClass = "py-3 px-2 cursor-pointer select-none hover:text-blue-500 transition-colors";

  // #717: shared spool-location controls, used by BOTH renderRow (standalones +
  // variants) and renderParentRow (a parent can carry its own spools — Codex P2
  // on PR #721). The toggle sits in the remaining-stock cell; the panel is the
  // sub-row rendered just below the filament's main row when expanded.
  const renderSpoolToggle = (f: Filament) => {
    const spools = f.spools ?? [];
    if (spools.length === 0) return null;
    const expanded = expandedSpools.has(f._id);
    return (
      <button
        type="button"
        onClick={() => toggleSpools(f._id)}
        aria-expanded={expanded}
        aria-label={expanded ? t("filaments.spools.collapse") : t("filaments.spools.expand")}
        title={expanded ? t("filaments.spools.collapse") : t("filaments.spools.expand")}
        className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-0.5"
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span>×{spools.length}</span>
      </button>
    );
  };

  const renderSpoolPanel = (f: Filament) => {
    const spools = f.spools ?? [];
    if (!expandedSpools.has(f._id) || spools.length === 0) return null;
    return (
      <tr className="border-b border-gray-200 dark:border-gray-800 bg-blue-50/40 dark:bg-blue-950/20">
        <td colSpan={12} className="py-2 px-2 pl-10">
          <div className="space-y-1.5">
            {spools.map((s, i) => (
              <div key={s._id} className="flex items-center gap-3 text-xs flex-wrap">
                <span className="font-medium text-gray-700 dark:text-gray-300 min-w-[110px]">
                  {s.label || t("filaments.spools.spoolN", { n: i + 1 })}
                </span>
                {/* #732 Phase 4: surface the per-spool id (read-only; edit on
                    the filament detail page). */}
                {s.instanceId && (
                  <code className="inline-block max-w-[12rem] truncate align-bottom text-[10px] text-gray-400 dark:text-gray-500 font-mono" title={s.instanceId}>
                    {s.instanceId}
                  </code>
                )}
                {s.retired && (
                  <span className="text-[10px] text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 px-1 py-0.5 rounded">
                    {t("filaments.spools.retired")}
                  </span>
                )}
                {/* GH #804: show remaining filament weight (gross − empty-spool
                    tare) as subtext under the total, so a glance answers "do I
                    have enough?" without recalling the empty-spool weight.
                    GH #805: formatGrams trims float noise to 2 dp. Remaining is
                    only shown when the tare (filament spoolWeight) is known. */}
                <span className="text-gray-500 dark:text-gray-400 flex flex-col leading-tight">
                  {s.totalWeight == null ? (
                    "—"
                  ) : (
                    <>
                      <span>{formatGrams(s.totalWeight)} g</span>
                      {f.spoolWeight != null && (
                        <span className="text-[10px] text-gray-400 dark:text-gray-500">
                          {t("filaments.spools.remainingGrams", {
                            grams: formatGrams(Math.max(0, s.totalWeight - f.spoolWeight)),
                          })}
                        </span>
                      )}
                    </>
                  )}
                </span>
                <label className="flex items-center gap-1.5 ml-auto">
                  <span className="text-gray-500">{t("filaments.spools.location")}</span>
                  <select
                    value={s.locationId ?? ""}
                    disabled={pendingMoves.has(`${f._id}:${s._id}`)}
                    onChange={(e) => moveSpool(f._id, s._id, e.target.value || null)}
                    aria-label={t("filaments.spools.location")}
                    className="px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                  >
                    <option value="">{t("filaments.spools.noLocation")}</option>
                    {locations.map((l) => (
                      <option key={l._id} value={l._id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
        </td>
      </tr>
    );
  };

  // #941: Purchased / Opened cells — the earliest date across this filament's
  // own spools (matches the sort value from earliestSpoolDate). "—" when unset.
  const dateCells = (spools: Filament["spools"] | undefined) => {
    const purchased = earliestSpoolDate(spools, "purchaseDate");
    const opened = earliestSpoolDate(spools, "openedDate");
    const cls = "py-2 px-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400";
    // purchaseDate/openedDate are calendar-day values stored as UTC midnight
    // (the SpoolCard date picker sends a bare YYYY-MM-DD → Mongoose casts it to
    // UTC midnight). Format in UTC so the day matches the detail page + CSV
    // export and doesn't shift back a day for users west of UTC (#941 review).
    const fmt = (iso: string) => formatDate(iso, { timeZone: "UTC" });
    return (
      <>
        <td className={cls}>{purchased ? fmt(purchased) : "—"}</td>
        <td className={cls}>{opened ? fmt(opened) : "—"}</td>
      </>
    );
  };

  const renderRow = (f: Filament, isVariant = false) => (
    <React.Fragment key={f._id}>
    <tr
      className={`border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 ${isVariant ? "bg-gray-50/50 dark:bg-gray-950/50" : ""} ${selected.has(f._id) ? "bg-red-50 dark:bg-red-900/25" : ""}`}
    >
      <td className="py-2 px-2">
        <input
          type="checkbox"
          checked={selected.has(f._id)}
          onChange={() => toggleSelect(f._id)}
          aria-label={f.name || t("common.select")}
          className="accent-red-600"
        />
      </td>
      <td className="py-2 px-2">
        <div className="flex items-center gap-1">
          {isVariant && <span className="text-gray-400 text-xs ml-2">&#8627;</span>}
          <FilamentSwatch
            color={f.color}
            secondaryColors={f.secondaryColors}
            arrangement={deriveArrangement(f.optTags)}
            isParent={!isVariant && f.hasVariants === true}
            finish={deriveFinish(f.optTags)}
            size={isVariant ? 20 : 24}
            title={f.color ?? undefined}
          />
        </div>
      </td>
      <td className="py-2 px-2 min-w-[260px] break-words">
        <Link
          href={`/filaments/${f._id}`}
          className="text-blue-600 hover:underline"
        >
          {f.name}
        </Link>
        {isVariant && (
          <span className="ml-1.5 text-[10px] text-gray-400 bg-gray-200 dark:bg-gray-800 px-1 py-0.5 rounded">
            {t("filaments.variant")}
          </span>
        )}
        {(() => {
          const finish = deriveFinish(f.optTags);
          return finish ? <FinishChip finish={finish} className="ml-1.5" /> : null;
        })()}
        {isLowStock(f) && (
          <span
            className="ml-1.5 text-[10px] text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 rounded"
            title={t("filaments.lowStockTooltip", {
              remaining: Math.round(getRemainingGrams(f) ?? 0),
              threshold: Math.round(f.lowStockThreshold ?? 0),
            })}
          >
            {t("filaments.lowStockBadge")}
          </span>
        )}
      </td>
      <td className="py-2 px-2">{f.vendor}</td>
      <td className="py-2 px-2">
        <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-800 rounded text-xs">
          {f.type}
        </span>
      </td>
      <td className="py-2 px-2 text-right">
        {f.temperatures.nozzle ? `${f.temperatures.nozzle}°C` : "—"}
      </td>
      <td className="py-2 px-2 text-right">
        {f.temperatures.bed ? `${f.temperatures.bed}°C` : "—"}
      </td>
      <td className="py-2 px-2 text-right">
        {f.cost != null ? formatCurrency(f.cost) : "—"}
      </td>
      <td className="py-2 px-2 text-right">
        {(() => {
          const pct = getRemainingPct(f);
          const spoolCt = getSpoolCount(f);
          const color =
            pct == null ? "" : pct > 25 ? "bg-green-500" : pct > 10 ? "bg-yellow-500" : "bg-red-500";
          return (
            <div className="flex items-center gap-1.5 justify-end">
              {pct == null ? (
                <span className="text-gray-400">—</span>
              ) : (
                <div
                  className="flex items-center gap-1.5"
                  title={spoolCt > 1 ? t("filaments.remainingWithSpools", { pct, spools: spoolCt }) : t("filaments.remaining", { pct })}
                >
                  <div className="w-12 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
                </div>
              )}
              {/* #717: per-spool location panel toggle (shared with parents) */}
              {renderSpoolToggle(f)}
            </div>
          );
        })()}
      </td>
      {dateCells(f.spools)}
      <td className="py-2 px-2 text-right">
        <Link
          href={`/filaments/${f._id}/edit`}
          className="text-blue-600 hover:underline text-xs"
        >
          {t("common.edit")}
        </Link>
      </td>
    </tr>
    {/* #717: per-spool location panel (shared with parents) */}
    {renderSpoolPanel(f)}
    </React.Fragment>
  );

  const renderParentRow = (group: GroupedFilament) => {
    const f = group.parent;
    const isExpanded = expandedParents.has(f._id);
    return (
      <>
        <tr
          key={f._id}
          className={`border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 ${selected.has(f._id) ? "bg-red-50 dark:bg-red-900/25" : ""}`}
        >
          <td className="py-2 px-2">
            <input
              type="checkbox"
              checked={selected.has(f._id)}
              onChange={() => toggleSelect(f._id)}
              aria-label={f.name || t("common.select")}
              className="accent-red-600"
            />
          </td>
          <td className="py-2 px-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => toggleExpanded(f._id)}
                className="text-gray-500 hover:text-gray-700 dark:text-gray-300 dark:hover:text-gray-100 text-base leading-none w-5 flex-shrink-0"
                title={isExpanded ? t("filaments.collapseVariants") : t("filaments.expandVariants")}
                // GH #416: a SR user could neither read the chevron glyph
                // nor tell whether it was expanded. The translated label
                // names the row and the `aria-expanded` state announces
                // open/closed; `aria-controls` ties it to the variant
                // tbody that gets toggled below.
                aria-label={isExpanded
                  ? t("filaments.collapseVariants")
                  : t("filaments.expandVariants")}
                aria-expanded={isExpanded}
              >
                {isExpanded ? "▾" : "▸"}
              </button>
              <FilamentSwatch
                color={f.color}
                secondaryColors={f.secondaryColors}
                isParent
                variantColors={group.variants.flatMap((v) => [
                  v.color,
                  ...(v.secondaryColors ?? []),
                ])}
                size={24}
                title={f.color ?? undefined}
              />
            </div>
          </td>
          <td className="py-2 px-2 min-w-[260px] break-words">
            <Link
              href={`/filaments/${f._id}`}
              className="text-blue-600 hover:underline"
            >
              {f.name}
            </Link>
            <span className="ml-1.5 text-[10px] text-gray-500 bg-gray-200 dark:bg-gray-800 px-1 py-0.5 rounded">
              {t("filaments.colorCount", {
                count: group.variants.length,
              })}
            </span>
          </td>
          <td className="py-2 px-2">{f.vendor}</td>
          <td className="py-2 px-2">
            <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-800 rounded text-xs">
              {f.type}
            </span>
          </td>
          <td className="py-2 px-2 text-right">
            {f.temperatures.nozzle ? `${f.temperatures.nozzle}°C` : "—"}
          </td>
          <td className="py-2 px-2 text-right">
            {f.temperatures.bed ? `${f.temperatures.bed}°C` : "—"}
          </td>
          <td className="py-2 px-2 text-right">
            {f.cost != null ? formatCurrency(f.cost) : "—"}
          </td>
          <td className="py-2 px-2 text-right">
            {(() => {
              const pct = getRemainingPct(f);
              const color =
                pct == null ? "" : pct > 25 ? "bg-green-500" : pct > 10 ? "bg-yellow-500" : "bg-red-500";
              return (
                <div className="flex items-center gap-1.5 justify-end">
                  {pct == null ? (
                    <span className="text-gray-400">—</span>
                  ) : (
                    <div className="flex items-center gap-1.5" title={t("filaments.remaining", { pct })}>
                      <div className="w-12 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
                    </div>
                  )}
                  {/* #717: a parent can carry its own spools (Codex P2 on #721) */}
                  {renderSpoolToggle(f)}
                </div>
              );
            })()}
          </td>
          {dateCells(f.spools)}
          <td className="py-2 px-2 text-right">
            <Link
              href={`/filaments/${f._id}/edit`}
              className="text-blue-600 hover:underline text-xs"
            >
              {t("common.edit")}
            </Link>
          </td>
        </tr>
        {/* #717: the parent's own spools (if any) — shared panel */}
        {renderSpoolPanel(f)}
        {isExpanded && group.variants.map((v) => renderRow(v, true))}
        {!isExpanded && (
          <tr key={`${f._id}-colors`} className="border-b border-gray-200">
            <td colSpan={12} className="py-1 px-2 pl-10">
              <div className="flex items-center gap-1.5">
                {group.variants.map((v) => (
                  <Link
                    key={v._id}
                    href={`/filaments/${v._id}`}
                    title={v.name}
                  >
                    <FilamentSwatch
                      color={v.color}
                      secondaryColors={v.secondaryColors}
                      arrangement={deriveArrangement(v.optTags)}
                      finish={deriveFinish(v.optTags)}
                      size={16}
                      className="hover:ring-2 hover:ring-blue-400 transition-all"
                      title={v.name}
                    />
                  </Link>
                ))}
              </div>
            </td>
          </tr>
        )}
      </>
    );
  };

  return (
    <main id="main-content" className="w-full px-4 py-8">
      {/* GH #411: visually-hidden h1 so screen-reader users navigating
          by heading land on the page title. Sighted users already get
          the "Filaments" cue from the AppHeader brand pill + active
          nav link, so keeping the heading visible was rejected in
          #176; the a11y need is met by sr-only. */}
      <h1 className="sr-only">{t("filaments.pageTitle")}</h1>
      {mounted && (
        <input
          ref={fileInputRef}
          type="file"
          accept=".ini,.csv,.xlsx"
          onChange={handleImport}
          className="hidden"
        />
      )}
      <div ref={stickyHeaderRef} className="sticky top-[var(--app-header-h)] z-20 bg-white dark:bg-gray-950 pb-3 -mt-8 pt-8 border-b border-gray-200 dark:border-gray-800 shadow-sm">
      {/* Page heading was removed (#176) — the brand "Filament DB" + version
          pill in AppHeader (and the active "Filaments" nav link) already
          identify the page. The action buttons used to share this row so
          there'd be no wasted vertical space above the metadata, but they
          were moved down to the search-filter row so all the controls
          actually used together live together. */}
      {filaments.length > 0 && (
        <button
          onClick={() => setShowStats((s) => !s)}
          className="text-sm text-gray-500 hover:text-gray-300 flex items-center gap-1 mb-3"
        >
          <span>{showStats ? "▾" : "▸"}</span>
          {/* #573: the list collapses each parent's variants into one group,
              so the headline count (parents excluded) disagrees with the
              Dashboard/export totals that count every record. Surface both
              numbers when variants exist instead of one unexplained figure. */}
          <span>
            {filaments.length > inventoryFilaments.length
              ? t("filaments.stats.totalWithVariants", {
                  count: inventoryFilaments.length,
                  total: filaments.length,
                })
              : t("filaments.stats.total", { count: inventoryFilaments.length })}
          </span>
          <span className="text-gray-600">·</span>
          <span>{t("filaments.stats.typeCount", { count: filteredTypeCount })}</span>
          <span className="text-gray-600">·</span>
          <span>{t("filaments.stats.vendorCount", { count: filteredVendorCount })}</span>
          {/* #616: surface spool + location totals at a glance, like the
              Inventory page header. */}
          {spoolStats.spools > 0 && (
            <>
              <span className="text-gray-600">·</span>
              <span>
                {t("filaments.stats.spoolsLocations", {
                  spools: spoolStats.spools,
                  locations: spoolStats.locations,
                })}
              </span>
            </>
          )}
        </button>
      )}
      {/* Statistics expansion — toggle lives on the stats text above; this
          just renders the expanded grid when the user opens it. */}
      {filaments.length > 0 && showStats && (
        <div className="mb-4">
          <FilamentStats filaments={inventoryFilaments} />
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
        <QuickFilterChips
          active={quickFilter}
          onChange={setQuickFilter}
          counts={quickFilterCounts}
          trailing={
            quickFilter === "all" && !debouncedSearch && !typeFilter && !vendorFilter && outOfStockCount > 0 && hasAnyInStock ? (
              <button
                onClick={() => setShowOutOfStock((s) => !s)}
                aria-pressed={showOutOfStock}
                className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                  showOutOfStock
                    ? "bg-gray-700 text-white border-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:border-gray-200"
                    : "bg-transparent text-gray-600 border-gray-300 hover:bg-gray-100 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700"
                }`}
              >
                {showOutOfStock
                  ? t("filaments.hideOutOfStock")
                  : t("filaments.showOutOfStock", { count: outOfStockCount })}
              </button>
            ) : null
          }
        />
        <div className="flex gap-2 shrink-0">
          {/* Import / Export dropdown */}
          <div className="relative" ref={importExportRef}>
            <button
              onClick={() => setShowImportExport((s) => !s)}
              className="px-4 py-2 bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600 rounded text-sm flex items-center gap-1.5"
            >
              {t("filaments.importExport")}
              <svg className={`w-3.5 h-3.5 transition-transform ${showImportExport ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {showImportExport && (
              <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-xl z-50 py-1">
                <button
                  onClick={() => { setShowImportExport(false); setShowPrusamentImport(true); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                >
                  <span className="w-2 h-2 rounded-full bg-orange-500" />
                  {t("filaments.import.prusamentQR")}
                </button>
                <button
                  onClick={() => { setShowImportExport(false); setShowAtlasImport(true); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                >
                  <span className="w-2 h-2 rounded-full bg-purple-500" />
                  {t("filaments.import.fromAtlas")}
                </button>
                <a
                  href="/openprinttag"
                  className="block px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => setShowImportExport(false)}
                >
                  <span className="w-2 h-2 rounded-full bg-teal-500" />
                  {t("filaments.import.browseOpenPrintTag")}
                </a>
                <button
                  onClick={() => { setShowImportExport(false); setShowSpoolCsvImport(true); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                >
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                  {t("filaments.import.spoolCsv")}
                </button>
                <button
                  onClick={() => { setShowImportExport(false); fileInputRef.current?.click(); }}
                  disabled={importing}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 flex items-center gap-2"
                >
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  {importing ? t("filaments.import.importing") : t("filaments.import.file")}
                </button>
                <div className="border-t border-gray-200 dark:border-gray-600 my-1" />
                <div className="px-4 py-1">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t("filaments.export")}</span>
                </div>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/api/filaments/export"
                  className="block px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => setShowImportExport(false)}
                >
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  {t("filaments.export.ini")}
                </a>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/api/filaments/export-csv"
                  className="block px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => setShowImportExport(false)}
                >
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  {t("filaments.export.csv")}
                </a>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/api/filaments/export-xlsx"
                  className="block px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => setShowImportExport(false)}
                >
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  {t("filaments.export.xlsx")}
                </a>
                <div className="border-t border-gray-200 dark:border-gray-600 my-1" />
                <div className="px-4 py-1">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t("spools.export")}</span>
                </div>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a CSV download endpoint, not a page; the new dynamic /api/spools/[spoolId] route makes the linter match this static export-csv path as a "page" */}
                <a
                  href="/api/spools/export-csv"
                  className="block px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => setShowImportExport(false)}
                >
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  {t("spools.export.csv")}
                </a>
              </div>
            )}
          </div>
          <Link
            href="/filaments/new"
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            {t("filaments.addNew")}
          </Link>
        </div>
      </div>

      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          type="search"
          placeholder={t("common.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
        >
          <option value="">{t("filaments.filter.allTypes")}</option>
          {types.map((tp) => (
            <option key={tp} value={tp}>
              {tp}
            </option>
          ))}
        </select>
        <select
          value={vendorFilter}
          onChange={(e) => setVendorFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
        >
          <option value="">{t("filaments.filter.allVendors")}</option>
          {vendors.map((vn) => (
            <option key={vn} value={vn}>
              {vn}
            </option>
          ))}
        </select>
      </div>

      {/* Codex P2 round 1 on PR #540: gate the bar + count on the VISIBLE
          selection, not raw `selected.size`. Deletion is intersected with
          visible IDs, so the bar must report the count it will actually
          act on — otherwise it reads "5 selected · Delete 5" while only
          2 are visible and deletable. */}
      {visibleSelectedCount > 0 && (
        // GH #196: previously the bar used `bg-red-950/30` + `text-red-300`
        // + small text-sm — pink-on-dark-red is a low-contrast pairing on
        // a near-black page and the small thin font compounded the problem.
        // Bumped the bg to red-900/50 (deeper, less transparent), the count
        // text to red-100 with font-medium, and the Clear button to
        // gray-200 hover-white so all three elements meet WCAG-AA contrast
        // on dark mode.
        <div className="mb-4 flex items-center gap-3 px-3 py-2.5 bg-red-50 dark:bg-red-900/50 border border-red-200 dark:border-red-700 rounded-lg">
          <span className="text-sm font-medium text-red-700 dark:text-red-100">{t("filaments.bulk.selected", { count: visibleSelectedCount })}</span>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="px-3 py-1.5 bg-red-700 text-white rounded text-sm font-medium hover:bg-red-600 disabled:opacity-50"
          >
            {bulkDeleting
              ? bulkProgress
                ? t("filaments.bulk.deletingProgress", { done: bulkProgress.done, total: bulkProgress.total })
                : t("filaments.bulk.deleting")
              : t("filaments.bulk.delete", { count: visibleSelectedCount })}
          </button>
          {bulkDeleting ? (
            // GH #525.2: let the user stop a long bulk delete partway.
            <button
              onClick={() => { bulkAbortRef.current = true; }}
              className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-200 dark:hover:text-white"
            >
              {t("filaments.bulk.stop")}
            </button>
          ) : (
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-200 dark:hover:text-white"
            >
              {t("common.clear")}
            </button>
          )}
          <span className="ml-auto text-xs text-red-600 dark:text-red-200">
            {t("filaments.bulk.deleteHint")}{" "}
            <Link href="/trash" className="underline hover:text-red-800 dark:hover:text-white">
              {t("filaments.bulk.openTrash")}
            </Link>
          </span>
        </div>
      )}
      </div>{/* end sticky header */}

      {loading ? (
        // #830: row-shaped skeletons instead of a one-line loader so the
        // landing route doesn't reflow when the list lands (matches the
        // dashboard / inventory / analytics pages, GH #449).
        <SkeletonRegion label={t("common.loading")} className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 px-3 py-2 border border-gray-200 dark:border-gray-800 rounded"
            >
              <Skeleton className="h-8 w-8 rounded-full flex-shrink-0" />
              <Skeleton className="h-4 flex-1 rounded" />
              <Skeleton className="h-4 w-16 rounded flex-shrink-0" />
              <Skeleton className="h-4 w-12 rounded flex-shrink-0" />
            </div>
          ))}
        </SkeletonRegion>
      ) : filaments.length === 0 ? (
        <p className="text-gray-500">{t("filaments.noResults")}</p>
      ) : groupedFilaments.length === 0 ? (
        // #575.2: a client-side quick filter (e.g. Low stock) can empty the
        // grouped list even though the fetch returned rows. Show a message
        // instead of a bare header-only table.
        <p className="text-gray-500">{t("filaments.noMatch")}</p>
      ) : (
        <div>
          {/* Expand-all / collapse-all — only worth showing when there's
            * actually a parent group to expand. (GH #127) */}
          {(() => {
            const parentIds = groupedFilaments
              .filter((g): g is GroupedFilament => "parent" in g)
              .map((g) => g.parent._id);
            if (parentIds.length === 0) return null;
            const allExpanded = parentIds.every((id) => expandedParents.has(id));
            return (
              <div className="flex justify-end mb-2">
                <button
                  type="button"
                  onClick={() =>
                    setExpandedParents(allExpanded ? new Set() : new Set(parentIds))
                  }
                  className="text-xs text-blue-600 hover:underline"
                >
                  {allExpanded
                    ? t("filaments.collapseAll")
                    : t("filaments.expandAll")}
                </button>
              </div>
            );
          })()}
          <table className="w-full text-sm border-collapse min-w-[900px]">
            <thead className="sticky z-10 bg-white dark:bg-gray-950 shadow-[0_1px_0_0_rgba(209,213,219,0.5)]" style={{ top: `${stickyHeaderHeight}px` }}>
              <tr className="border-b border-gray-300">
                <th scope="col" className="py-3 px-2 w-8">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label={t("filaments.bulk.selectAll") || "Select all"}
                    className="accent-red-600"
                  />
                </th>
                <th scope="col" className="text-left py-3 px-2">{t("filaments.table.color")}</th>
                {(["name", "vendor", "type", "nozzle", "bed", "cost", "remaining", "purchased", "opened"] as SortKey[]).map((col) => (
                  <th
                    key={col}
                    scope="col"
                    className={`${["nozzle", "bed", "cost", "remaining"].includes(col) ? "text-right" : "text-left"} ${thClass}`}
                    onClick={() => handleSort(col)}
                    role="columnheader"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSort(col); } }}
                    title={t("filaments.table.sortBy", { column: t(`filaments.table.${col}`) })}
                    aria-sort={sortKey === col ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    {t(`filaments.table.${col}`)}{" "}
                    <SortIcon column={col} sortKey={sortKey} sortDir={sortDir} />
                  </th>
                ))}
                <th scope="col" className="text-right py-3 px-2">{t("filaments.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {groupedFilaments.map((item) => {
                if ("parent" in item) {
                  return <React.Fragment key={item.parent._id}>{renderParentRow(item)}</React.Fragment>;
                }
                return renderRow(item);
              })}
            </tbody>
          </table>
        </div>
      )}

      {showAtlasImport && (
        <ImportAtlasDialog
          onClose={() => setShowAtlasImport(false)}
          onImported={(message) => {
            toast(message, "success");
            fetchFilaments();
            setShowAtlasImport(false);
          }}
        />
      )}

      {showPrusamentImport && (
        <PrusamentImportDialog
          onClose={() => setShowPrusamentImport(false)}
          onImported={(message) => {
            toast(message, "success");
            fetchFilaments();
            setShowPrusamentImport(false);
          }}
        />
      )}

      {showSpoolCsvImport && (
        <SpoolCsvImportDialog
          onClose={() => setShowSpoolCsvImport(false)}
          onImported={() => {
            fetchFilaments();
          }}
        />
      )}
    </main>
  );
}

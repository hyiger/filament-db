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
import { deriveFinish } from "@/lib/filamentFinish";
import { useCurrency } from "@/hooks/useCurrency";
import { useTranslation } from "@/i18n/TranslationProvider";
import type { FilamentSummary } from "@/types/filament";
import { getRemainingGrams, getRemainingPct, getSpoolCount } from "@/lib/inventoryStats";
import { compareFilaments, nextSortState, type SortKey, type SortDir } from "@/lib/sortFilamentList";

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
                aria-label={`Color swatch: ${color}`}
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

export default function Home() {
  const { t } = useTranslation();
  const { format: formatCurrency } = useCurrency();
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
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [importing, setImporting] = useState(false);
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [showAtlasImport, setShowAtlasImport] = useState(false);
  const [showPrusamentImport, setShowPrusamentImport] = useState(false);
  const [showSpoolCsvImport, setShowSpoolCsvImport] = useState(false);
  const [showImportExport, setShowImportExport] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
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
      if ((f.spools?.length ?? 0) > 0) counts.hasSpools++;
      if (!f.hasCalibrations) counts.noCalibration++;
    }
    return counts;
  }, [inventoryFilaments]);

  const visibleFilaments = useMemo(() => {
    // The "all" view keeps parents in the dataset so the list renders
    // them as grouping headers above their color variants. Every other
    // filter resolves against `inventoryFilaments` instead — otherwise
    // the chip badge (derived from `inventoryFilaments`, see
    // `quickFilterCounts` above) disagrees with the rendered row count
    // whenever a parent happens to match the filter criterion.
    // `noCalibration` is the obvious case: a parent without
    // calibrations would otherwise appear in the list even though the
    // badge excluded it from the count. Codex round-1 P2 on PR #356.
    const source = quickFilter === "all" ? filaments : inventoryFilaments;
    if (quickFilter === "all") return source;
    return source.filter((f) => {
      if (quickFilter === "lowStock") return isLowStock(f);
      if (quickFilter === "hasSpools") return (f.spools?.length ?? 0) > 0;
      if (quickFilter === "noCalibration") return !f.hasCalibrations;
      return true;
    });
  }, [filaments, inventoryFilaments, quickFilter]);

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
    const parentMap = new Map<string, GroupedFilament>();
    const standalone: Filament[] = [];
    const variantsByParent = new Map<string, Filament[]>();

    // Apply parent-field fallbacks to a variant. Used both for the
    // grouped-under-parent and orphaned-variant paths so the same
    // inheritance is visible regardless of whether the parent row
    // happens to be in the current filter result set.
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

    // First pass: collect variants
    for (const f of visibleFilaments) {
      if (f.parentId) {
        const variants = variantsByParent.get(f.parentId) || [];
        variants.push(f);
        variantsByParent.set(f.parentId, variants);
      }
    }

    // Second pass: build groups, resolving inherited fields for variants
    for (const f of visibleFilaments) {
      if (f.parentId) continue; // variants are handled by their parent
      const variants = (variantsByParent.get(f._id) || []).map((v) =>
        enrichVariant(v, f),
      );
      if (variants.length > 0) {
        parentMap.set(f._id, { parent: f, variants });
      } else {
        standalone.push(f);
      }
    }

    // Also include orphaned variants (parent not in current filter
    // results). Enrich from `parentLookup` so the inheritance still
    // applies — the parent existing-but-filtered-out shouldn't change
    // what the variant renders.
    for (const [parentId, variants] of variantsByParent) {
      if (!parentMap.has(parentId)) {
        const parent = parentLookup.get(parentId);
        standalone.push(...variants.map((v) => enrichVariant(v, parent)));
      }
    }

    // Combine and sort
    const all: (Filament | GroupedFilament)[] = [
      ...parentMap.values(),
      ...standalone.map((f) => f),
    ];

    const cmp = compareFilaments(sortKey, sortDir);
    all.sort((a, b) => {
      const fa = "parent" in a ? a.parent : a;
      const fb = "parent" in b ? b.parent : b;
      return cmp(fa, fb);
    });

    return all;
  }, [visibleFilaments, parentLookup, sortKey, sortDir]);

  const toggleExpanded = (parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  };

  const handleSort = (key: SortKey) => {
    const next = nextSortState({ sortKey, sortDir }, key);
    setSortKey(next.sortKey);
    setSortDir(next.sortDir);
  };

  const allFilamentIds = useMemo(() => filaments.map((f) => f._id), [filaments]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === allFilamentIds.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allFilamentIds));
    }
  };

  const handleBulkDelete = async () => {
    const count = selected.size;
    if (!(await confirm({ message: t("filaments.deleteConfirm", { count }), destructive: true, confirmLabel: t("common.delete") }))) return;
    setBulkDeleting(true);
    let deleted = 0;
    const errors: string[] = [];
    for (const id of selected) {
      const res = await fetch(`/api/filaments/${id}`, { method: "DELETE" });
      if (res.ok) {
        deleted++;
      } else {
        const body = await res.json().catch(() => null);
        const name = filaments.find((f) => f._id === id)?.name ?? id;
        errors.push(body?.error || t("filaments.deleteError", { name }));
      }
    }
    if (deleted > 0) toast(t("filaments.deletedCount", { count: deleted }));
    if (errors.length > 0) toast(errors.join("; "), "error");
    setBulkDeleting(false);
    setSelected(new Set());
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

  const renderRow = (f: Filament, isVariant = false) => (
    <tr
      key={f._id}
      className={`border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 ${isVariant ? "bg-gray-50/50 dark:bg-gray-950/50" : ""} ${selected.has(f._id) ? "bg-red-900/25" : ""}`}
    >
      <td className="py-2 px-2">
        <input
          type="checkbox"
          checked={selected.has(f._id)}
          onChange={() => toggleSelect(f._id)}
          aria-label={f.name || "Select"}
          className="accent-red-600"
        />
      </td>
      <td className="py-2 px-2">
        <div className="flex items-center gap-1">
          {isVariant && <span className="text-gray-400 text-xs ml-2">&#8627;</span>}
          <FilamentSwatch
            color={f.color}
            isParent={!isVariant && f.hasVariants === true}
            finish={deriveFinish(f.optTags)}
            size={isVariant ? 20 : 24}
            title={f.color}
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
          if (pct == null) return <span className="text-gray-400">—</span>;
          const color = pct > 25 ? "bg-green-500" : pct > 10 ? "bg-yellow-500" : "bg-red-500";
          return (
            <div className="flex items-center gap-1.5 justify-end" title={spoolCt > 1 ? t("filaments.remainingWithSpools", { pct, spools: spoolCt }) : t("filaments.remaining", { pct })}>
              <div className="w-12 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
              {spoolCt > 1 && <span className="text-xs text-gray-400">×{spoolCt}</span>}
            </div>
          );
        })()}
      </td>
      <td className="py-2 px-2 text-right">
        <Link
          href={`/filaments/${f._id}/edit`}
          className="text-blue-600 hover:underline text-xs"
        >
          {t("common.edit")}
        </Link>
      </td>
    </tr>
  );

  const renderParentRow = (group: GroupedFilament) => {
    const f = group.parent;
    const isExpanded = expandedParents.has(f._id);
    return (
      <>
        <tr
          key={f._id}
          className={`border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 ${selected.has(f._id) ? "bg-red-900/25" : ""}`}
        >
          <td className="py-2 px-2">
            <input
              type="checkbox"
              checked={selected.has(f._id)}
              onChange={() => toggleSelect(f._id)}
              aria-label={f.name || "Select"}
              className="accent-red-600"
            />
          </td>
          <td className="py-2 px-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => toggleExpanded(f._id)}
                className="text-gray-400 hover:text-gray-600 text-xs w-4 flex-shrink-0"
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
                isParent
                size={24}
                title={f.color}
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
              {t("filaments.colorCount", { count: group.variants.length })}
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
              if (pct == null) return <span className="text-gray-400">—</span>;
              const color = pct > 25 ? "bg-green-500" : pct > 10 ? "bg-yellow-500" : "bg-red-500";
              return (
                <div className="flex items-center gap-1.5 justify-end" title={t("filaments.remaining", { pct })}>
                  <div className="w-12 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
                </div>
              );
            })()}
          </td>
          <td className="py-2 px-2 text-right">
            <Link
              href={`/filaments/${f._id}/edit`}
              className="text-blue-600 hover:underline text-xs"
            >
              {t("common.edit")}
            </Link>
          </td>
        </tr>
        {isExpanded && group.variants.map((v) => renderRow(v, true))}
        {!isExpanded && (
          <tr key={`${f._id}-colors`} className="border-b border-gray-200">
            <td colSpan={10} className="py-1 px-2 pl-10">
              <div className="flex items-center gap-1.5">
                {group.variants.map((v) => (
                  <Link
                    key={v._id}
                    href={`/filaments/${v._id}`}
                    title={v.name}
                  >
                    <FilamentSwatch
                      color={v.color}
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
          <span>{t("filaments.stats.total", { count: inventoryFilaments.length })}</span>
          <span className="text-gray-600">·</span>
          <span>{t("filaments.stats.typeCount", { count: types.length })}</span>
          <span className="text-gray-600">·</span>
          <span>{t("filaments.stats.vendorCount", { count: vendors.length })}</span>
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
              <div className="absolute right-0 top-full mt-1 w-52 bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-50 py-1">
                <button
                  onClick={() => { setShowImportExport(false); setShowPrusamentImport(true); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                >
                  <span className="w-2 h-2 rounded-full bg-orange-500" />
                  {t("filaments.import.prusamentQR")}
                </button>
                <button
                  onClick={() => { setShowImportExport(false); setShowAtlasImport(true); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                >
                  <span className="w-2 h-2 rounded-full bg-purple-500" />
                  {t("filaments.import.fromAtlas")}
                </button>
                <a
                  href="/openprinttag"
                  className="block px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => setShowImportExport(false)}
                >
                  <span className="w-2 h-2 rounded-full bg-teal-500" />
                  {t("filaments.import.browseOpenPrintTag")}
                </a>
                <button
                  onClick={() => { setShowImportExport(false); setShowSpoolCsvImport(true); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                >
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                  {t("filaments.import.spoolCsv")}
                </button>
                <button
                  onClick={() => { setShowImportExport(false); fileInputRef.current?.click(); }}
                  disabled={importing}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50 flex items-center gap-2"
                >
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  {importing ? t("filaments.import.importing") : t("filaments.import.file")}
                </button>
                <div className="border-t border-gray-600 my-1" />
                <div className="px-4 py-1">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t("filaments.export")}</span>
                </div>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/api/filaments/export"
                  className="block px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => setShowImportExport(false)}
                >
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  {t("filaments.export.ini")}
                </a>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/api/filaments/export-csv"
                  className="block px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => setShowImportExport(false)}
                >
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  {t("filaments.export.csv")}
                </a>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/api/filaments/export-xlsx"
                  className="block px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => setShowImportExport(false)}
                >
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  {t("filaments.export.xlsx")}
                </a>
                <div className="border-t border-gray-600 my-1" />
                <div className="px-4 py-1">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t("spools.export")}</span>
                </div>
                <a
                  href="/api/spools/export-csv"
                  className="block px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2"
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
          type="text"
          placeholder={t("common.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm bg-transparent"
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm bg-transparent"
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
          className="px-3 py-2 border border-gray-300 rounded text-sm bg-transparent"
        >
          <option value="">{t("filaments.filter.allVendors")}</option>
          {vendors.map((vn) => (
            <option key={vn} value={vn}>
              {vn}
            </option>
          ))}
        </select>
      </div>

      {selected.size > 0 && (
        // GH #196: previously the bar used `bg-red-950/30` + `text-red-300`
        // + small text-sm — pink-on-dark-red is a low-contrast pairing on
        // a near-black page and the small thin font compounded the problem.
        // Bumped the bg to red-900/50 (deeper, less transparent), the count
        // text to red-100 with font-medium, and the Clear button to
        // gray-200 hover-white so all three elements meet WCAG-AA contrast
        // on dark mode.
        <div className="mb-4 flex items-center gap-3 px-3 py-2.5 bg-red-900/50 border border-red-700 rounded-lg">
          <span className="text-sm font-medium text-red-100">{t("filaments.bulk.selected", { count: selected.size })}</span>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="px-3 py-1.5 bg-red-700 text-white rounded text-sm font-medium hover:bg-red-600 disabled:opacity-50"
          >
            {bulkDeleting ? t("filaments.bulk.deleting") : t("filaments.bulk.delete", { count: selected.size })}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-gray-200 hover:text-white"
          >
            {t("common.clear")}
          </button>
          <span className="ml-auto text-xs text-red-200">
            {t("filaments.bulk.deleteHint")}{" "}
            <Link href="/trash" className="underline hover:text-white">
              {t("filaments.bulk.openTrash")}
            </Link>
          </span>
        </div>
      )}
      </div>{/* end sticky header */}

      {loading ? (
        <p className="text-gray-500">{t("common.loading")}</p>
      ) : filaments.length === 0 ? (
        <p className="text-gray-500">{t("filaments.noResults")}</p>
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
                    checked={selected.size === allFilamentIds.length && allFilamentIds.length > 0}
                    onChange={toggleAll}
                    aria-label={t("filaments.bulk.selectAll") || "Select all"}
                    className="accent-red-600"
                  />
                </th>
                <th scope="col" className="text-left py-3 px-2">{t("filaments.table.color")}</th>
                {(["name", "vendor", "type", "nozzle", "bed", "cost", "remaining"] as SortKey[]).map((col) => (
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

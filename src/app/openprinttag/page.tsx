"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";

// ── Types ──────────────────────────────────────────────────────────────

interface OPTBrand {
  slug: string;
  name: string;
  materialCount: number;
}

interface OPTMaterial {
  slug: string;
  uuid: string;
  brandSlug: string;
  brandName: string;
  name: string;
  type: string;
  abbreviation: string;
  color: string | null;
  density: number | null;
  nozzleTempMin: number | null;
  nozzleTempMax: number | null;
  bedTempMin: number | null;
  bedTempMax: number | null;
  chamberTemp: number | null;
  preheatTemp: number | null;
  dryingTemp: number | null;
  dryingTime: number | null;
  hardnessShoreD: number | null;
  transmissionDistance: number | null;
  tags: string[];
  photoUrl: string | null;
  productUrl: string | null;
  completenessScore: number;
  completenessTier: "rich" | "partial" | "stub";
}

interface OPTDatabase {
  brands: OPTBrand[];
  materials: OPTMaterial[];
  cachedAt: string;
  totalFFF: number;
  totalSLA: number;
}

type SortKey = "completeness" | "name" | "type" | "brand";

// ── Completeness indicator ─────────────────────────────────────────────

function CompletenessBar({ score, tier }: { score: number; tier: string }) {
  const { t } = useTranslation();
  const colors = {
    rich: "bg-green-500 dark:bg-green-400",
    partial: "bg-yellow-500 dark:bg-yellow-400",
    stub: "bg-gray-400 dark:bg-gray-500",
  };
  const barColor = colors[tier as keyof typeof colors] || colors.stub;
  const pct = (score / 10) * 100;

  return (
    <div className="flex items-center gap-1.5" title={t("openprinttag.completenessTitle", { score: score })}>
      <div className="w-16 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 dark:text-gray-400 w-6">{score}</span>
    </div>
  );
}

// ── Type badge ─────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  const colorMap: Record<string, string> = {
    PLA: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    PETG: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    ABS: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    ASA: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    TPU: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
    PC: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
    PA6: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    PA11: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    PA12: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    HIPS: "bg-lime-100 text-lime-800 dark:bg-lime-900 dark:text-lime-200",
    PVA: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200",
  };
  const cls =
    colorMap[type] ||
    "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300";

  return (
    <span className={`px-1.5 py-0.5 text-xs font-medium rounded ${cls}`}>
      {type}
    </span>
  );
}

// ── Color swatch ───────────────────────────────────────────────────────

function ColorSwatch({ color }: { color: string | null }) {
  const { t } = useTranslation();
  return (
    <span
      className="inline-block w-5 h-5 rounded-full border border-gray-300 dark:border-gray-600 flex-shrink-0"
      style={{ backgroundColor: color || "#808080" }}
      title={color || t("openprinttag.unknown")}
    />
  );
}

// ── Detail field row ───────────────────────────────────────────────────

function DetailField({ label, value, unit }: { label: string; value: unknown; unit?: string }) {
  if (value == null) return null;
  return (
    <div className="flex justify-between py-1 border-b border-gray-100 dark:border-gray-700/50 last:border-0">
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-xs font-medium text-gray-800 dark:text-gray-200">
        {String(value)}{unit ? ` ${unit}` : ""}
      </span>
    </div>
  );
}

// ── Expanded detail panel ──────────────────────────────────────────────

function MaterialDetail({ m }: { m: OPTMaterial }) {
  const { t } = useTranslation();
  const tierLabel = {
    rich: t("openprinttag.tierRich"),
    partial: t("openprinttag.tierPartial"),
    stub: t("openprinttag.tierStub"),
  }[m.completenessTier];
  const tierColor = {
    rich: "text-green-600 dark:text-green-400",
    partial: "text-yellow-600 dark:text-yellow-400",
    stub: "text-gray-500 dark:text-gray-400",
  }[m.completenessTier];

  const hasAnyProperty = m.density != null || m.nozzleTempMin != null || m.nozzleTempMax != null ||
    m.bedTempMin != null || m.bedTempMax != null || m.chamberTemp != null || m.preheatTemp != null ||
    m.dryingTemp != null || m.dryingTime != null || m.hardnessShoreD != null ||
    m.transmissionDistance != null;

  return (
    <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/40 border-t border-gray-100 dark:border-gray-700/50">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-1 max-w-4xl">
        {/* Identity */}
        <div>
          <h4 className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">
            {t("openprinttag.detail.identity")}
          </h4>
          <DetailField label={t("openprinttag.detail.brand")} value={m.brandName} />
          <DetailField label={t("openprinttag.detail.type")} value={m.type} />
          <DetailField label={t("openprinttag.detail.abbreviation")} value={m.abbreviation} />
          <DetailField label={t("openprinttag.detail.color")} value={m.color} />
          <DetailField label={t("openprinttag.detail.uuid")} value={m.uuid ? m.uuid.slice(0, 8) + "..." : null} />
          {m.tags.length > 0 && (
            <div className="flex justify-between py-1 border-b border-gray-100 dark:border-gray-700/50">
              <span className="text-xs text-gray-500 dark:text-gray-400">{t("openprinttag.detail.tags")}</span>
              <span className="text-xs font-medium text-gray-800 dark:text-gray-200 text-right max-w-[200px]">
                {m.tags.join(", ")}
              </span>
            </div>
          )}
        </div>

        {/* Properties */}
        <div>
          <h4 className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">
            {t("openprinttag.detail.properties")}
          </h4>
          {hasAnyProperty ? (
            <>
              <DetailField label={t("openprinttag.detail.density")} value={m.density} unit="g/cm³" />
              <DetailField label={t("openprinttag.detail.hardnessShoreD")} value={m.hardnessShoreD} />
              <DetailField label={t("openprinttag.detail.transmissionDistance")} value={m.transmissionDistance} />
              {(m.nozzleTempMin != null || m.nozzleTempMax != null) && (
                <DetailField
                  label={t("openprinttag.detail.nozzleTemp")}
                  value={m.nozzleTempMin != null && m.nozzleTempMax != null
                    ? `${m.nozzleTempMin}–${m.nozzleTempMax}`
                    : m.nozzleTempMin ?? m.nozzleTempMax}
                  unit="°C"
                />
              )}
              {(m.bedTempMin != null || m.bedTempMax != null) && (
                <DetailField
                  label={t("openprinttag.detail.bedTemp")}
                  value={m.bedTempMin != null && m.bedTempMax != null
                    ? `${m.bedTempMin}–${m.bedTempMax}`
                    : m.bedTempMin ?? m.bedTempMax}
                  unit="°C"
                />
              )}
              <DetailField label={t("openprinttag.detail.chamberTemp")} value={m.chamberTemp} unit="°C" />
              <DetailField label={t("openprinttag.detail.preheatTemp")} value={m.preheatTemp} unit="°C" />
              <DetailField label={t("openprinttag.detail.dryingTemp")} value={m.dryingTemp} unit="°C" />
              <DetailField label={t("openprinttag.detail.dryingTime")} value={m.dryingTime} unit="h" />
            </>
          ) : (
            <p className="text-xs text-gray-400 dark:text-gray-500 italic py-1">{t("openprinttag.detail.noProperties")}</p>
          )}
        </div>

        {/* Data Quality & Links */}
        <div>
          <h4 className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">
            {t("openprinttag.detail.dataQuality")}
          </h4>
          <div className="flex justify-between py-1 border-b border-gray-100 dark:border-gray-700/50">
            <span className="text-xs text-gray-500 dark:text-gray-400">{t("openprinttag.detail.score")}</span>
            <span className={`text-xs font-medium ${tierColor}`}>
              {m.completenessScore}/10 ({tierLabel})
            </span>
          </div>
          <DetailField label={t("openprinttag.detail.photo")} value={m.photoUrl ? t("openprinttag.detail.yes") : null} />
          <DetailField label={t("openprinttag.detail.productUrl")} value={m.productUrl ? t("openprinttag.detail.yes") : null} />

          {(m.productUrl || m.photoUrl) && (
            <div className="mt-2 flex flex-col gap-1">
              {m.productUrl && (
                <a
                  href={m.productUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate"
                >
                  {t("openprinttag.detail.productPageLink")}
                </a>
              )}
              {m.photoUrl && (
                <a
                  href={m.photoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate"
                >
                  {t("openprinttag.detail.photoLink")}
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────

export default function OpenPrintTagBrowser() {
  const { t } = useTranslation();
  const [db, setDb] = useState<OPTDatabase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [brandFilter, setBrandFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [brandSearch, setBrandSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("completeness");
  const [tierFilter, setTierFilter] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchDatabase = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const url = refresh ? "/api/openprinttag?refresh=true" : "/api/openprinttag";
        const res = await fetch(url);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data: OPTDatabase = await res.json();
        setDb(data);
      } catch (err) {
        setError(String(err));
        toast(t("openprinttag.failedToLoad"), "error");
      } finally {
        setLoading(false);
      }
    },
    [toast, t],
  );

  useEffect(() => {
    fetchDatabase();
  }, [fetchDatabase]);

  // ── Derived data ───────────────────────────────────────────────────

  const types = useMemo(() => {
    if (!db) return [];
    const counts = new Map<string, number>();
    for (const m of db.materials) {
      counts.set(m.type, (counts.get(m.type) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));
  }, [db]);

  const filteredBrands = useMemo(() => {
    if (!db) return [];
    if (!brandSearch) return db.brands;
    const q = brandSearch.toLowerCase();
    return db.brands.filter((b) => b.name.toLowerCase().includes(q));
  }, [db, brandSearch]);

  const filteredMaterials = useMemo(() => {
    if (!db) return [];
    let materials = db.materials;

    if (brandFilter) {
      materials = materials.filter((m) => m.brandSlug === brandFilter);
    }
    if (typeFilter) {
      materials = materials.filter((m) => m.type === typeFilter);
    }
    if (tierFilter) {
      materials = materials.filter((m) => m.completenessTier === tierFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      materials = materials.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.brandName.toLowerCase().includes(q) ||
          m.type.toLowerCase().includes(q),
      );
    }

    // Sort
    materials = [...materials];
    switch (sortKey) {
      case "completeness":
        materials.sort((a, b) => b.completenessScore - a.completenessScore || a.name.localeCompare(b.name));
        break;
      case "name":
        materials.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "type":
        materials.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
        break;
      case "brand":
        materials.sort((a, b) => a.brandName.localeCompare(b.brandName) || a.name.localeCompare(b.name));
        break;
    }

    return materials;
  }, [db, brandFilter, typeFilter, tierFilter, searchQuery, sortKey]);

  // ── Handlers ───────────────────────────────────────────────────────

  const toggleSelect = (slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of filteredMaterials) next.add(m.slug);
      return next;
    });
  };

  const deselectAll = () => setSelected(new Set());

  const handleImport = async () => {
    if (selected.size === 0) return;
    setImporting(true);
    try {
      const res = await fetch("/api/openprinttag/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slugs: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || t("openprinttag.importFailed"), "error");
      } else {
        toast(data.message, "success");
        setSelected(new Set());
      }
    } catch {
      toast(t("openprinttag.importFailedNetwork"), "error");
    } finally {
      setImporting(false);
    }
  };

  // ── Loading state ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-900">
        <div className="text-center">
          <div className="inline-block w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-gray-600 dark:text-gray-300 text-lg">
            {t("openprinttag.fetching")}
          </p>
          <p className="text-gray-400 dark:text-gray-500 text-sm mt-2">
            {t("openprinttag.fetchingDescription")}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-900">
        <div className="text-center max-w-md">
          <p className="text-red-500 text-lg mb-4">{t("openprinttag.failedToLoadDatabase")}</p>
          <p className="text-gray-500 dark:text-gray-400 text-sm mb-4">{error}</p>
          <button
            onClick={() => fetchDatabase(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            {t("openprinttag.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!db) return null;

  const allSelected = filteredMaterials.length > 0 && filteredMaterials.every((m) => selected.has(m.slug));

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      {/* Header */}
      <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-4 py-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <Link
                href="/"
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </Link>
              <div>
                <h1 className="text-lg font-semibold">{t("openprinttag.title")}</h1>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t("openprinttag.subtitle", { fdmCount: db.totalFFF.toLocaleString(), brandCount: db.brands.length })}
                  <span className="ml-2 text-gray-400">•</span>
                  <span className="ml-2">{t("openprinttag.slaFiltered", { slaCount: db.totalSLA.toLocaleString() })}</span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <span className="text-sm text-blue-600 dark:text-blue-400 font-medium">
                  {t("openprinttag.selectedCount", { count: selected.size })}
                </span>
              )}
              <button
                onClick={handleImport}
                disabled={selected.size === 0 || importing}
                className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing ? t("openprinttag.importing") : t("openprinttag.importSelected", { count: selected.size })}
              </button>
              <button
                onClick={() => fetchDatabase(true)}
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700"
                title={t("openprinttag.refreshTitle")}
              >
                {t("openprinttag.refresh")}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto flex">
        {/* Sidebar */}
        <aside className="w-64 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 h-[calc(100vh-64px)] sticky top-[64px] overflow-y-auto">
          {/* Search */}
          <div className="p-3 border-b border-gray-200 dark:border-gray-700">
            <input
              type="text"
              placeholder={t("openprinttag.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400"
            />
          </div>

          {/* Sort */}
          <div className="p-3 border-b border-gray-200 dark:border-gray-700">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              {t("openprinttag.sortBy")}
            </label>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            >
              <option value="completeness">{t("openprinttag.sortCompleteness")}</option>
              <option value="name">{t("openprinttag.sortName")}</option>
              <option value="type">{t("openprinttag.sortType")}</option>
              <option value="brand">{t("openprinttag.sortBrand")}</option>
            </select>
          </div>

          {/* Completeness filter */}
          <div className="p-3 border-b border-gray-200 dark:border-gray-700">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              {t("openprinttag.dataQuality")}
            </label>
            <div className="mt-2 space-y-1">
              <button
                onClick={() => setTierFilter(null)}
                className={`w-full text-left px-2 py-1 text-sm rounded ${!tierFilter ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-gray-700"}`}
              >
                {t("openprinttag.all")}
              </button>
              <button
                onClick={() => setTierFilter(tierFilter === "rich" ? null : "rich")}
                className={`w-full text-left px-2 py-1 text-sm rounded flex items-center gap-2 ${tierFilter === "rich" ? "bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300" : "hover:bg-gray-100 dark:hover:bg-gray-700"}`}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
                {t("openprinttag.filterRich")}
              </button>
              <button
                onClick={() => setTierFilter(tierFilter === "partial" ? null : "partial")}
                className={`w-full text-left px-2 py-1 text-sm rounded flex items-center gap-2 ${tierFilter === "partial" ? "bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300" : "hover:bg-gray-100 dark:hover:bg-gray-700"}`}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                {t("openprinttag.filterPartial")}
              </button>
              <button
                onClick={() => setTierFilter(tierFilter === "stub" ? null : "stub")}
                className={`w-full text-left px-2 py-1 text-sm rounded flex items-center gap-2 ${tierFilter === "stub" ? "bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300" : "hover:bg-gray-100 dark:hover:bg-gray-700"}`}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-gray-400" />
                {t("openprinttag.filterStub")}
              </button>
            </div>
          </div>

          {/* Type filter */}
          <div className="p-3 border-b border-gray-200 dark:border-gray-700">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              {t("openprinttag.materialType")}
            </label>
            <div className="mt-2 space-y-0.5 max-h-48 overflow-y-auto">
              <button
                onClick={() => setTypeFilter(null)}
                className={`w-full text-left px-2 py-1 text-sm rounded ${!typeFilter ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-gray-700"}`}
              >
                {t("openprinttag.allTypes")}
              </button>
              {types.map(({ type, count }) => (
                <button
                  key={type}
                  onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                  className={`w-full text-left px-2 py-1 text-sm rounded flex justify-between ${typeFilter === type ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-gray-700"}`}
                >
                  <span>{type}</span>
                  <span className="text-gray-400 text-xs">{count}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Brand filter */}
          <div className="p-3">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              {t("openprinttag.brand")}
            </label>
            <input
              type="text"
              placeholder={t("openprinttag.filterBrandsPlaceholder")}
              value={brandSearch}
              onChange={(e) => setBrandSearch(e.target.value)}
              className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400"
            />
            <div className="mt-2 space-y-0.5 max-h-[40vh] overflow-y-auto">
              <button
                onClick={() => setBrandFilter(null)}
                className={`w-full text-left px-2 py-1 text-sm rounded ${!brandFilter ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-gray-700"}`}
              >
                {t("openprinttag.allBrands")}
              </button>
              {filteredBrands.map((b) => (
                <button
                  key={b.slug}
                  onClick={() => setBrandFilter(brandFilter === b.slug ? null : b.slug)}
                  className={`w-full text-left px-2 py-1 text-sm rounded flex justify-between ${brandFilter === b.slug ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-gray-700"}`}
                >
                  <span className="truncate">{b.name}</span>
                  <span className="text-gray-400 text-xs flex-shrink-0 ml-1">{b.materialCount}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0">
          {/* Toolbar */}
          <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/30 flex items-center justify-between sticky top-[64px] z-10">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => (allSelected ? deselectAll() : selectAllVisible())}
                  className="rounded border-gray-300 dark:border-gray-600"
                />
                {t("openprinttag.selectAll")}
              </label>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {t("openprinttag.filamentCount", { count: filteredMaterials.length.toLocaleString() })}
              </span>
              {(brandFilter || typeFilter || searchQuery || tierFilter) && (
                <button
                  onClick={() => {
                    setBrandFilter(null);
                    setTypeFilter(null);
                    setSearchQuery("");
                    setTierFilter(null);
                  }}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {t("openprinttag.clearFilters")}
                </button>
              )}
            </div>
            {selected.size > 0 && (
              <button
                onClick={deselectAll}
                className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                {t("openprinttag.deselectAll", { count: selected.size })}
              </button>
            )}
          </div>

          {/* Material list */}
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {filteredMaterials.length === 0 ? (
              <div className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                {t("openprinttag.noResults")}
              </div>
            ) : (
              filteredMaterials.map((m) => {
                const isStub = m.completenessTier === "stub";
                const isExpanded = expanded === m.slug;
                return (
                  <div key={m.slug}>
                    <div
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${
                        selected.has(m.slug) ? "bg-blue-50 dark:bg-blue-900/20" : ""
                      } ${isStub ? "opacity-50" : ""} ${isExpanded ? "bg-gray-50 dark:bg-gray-800/30" : ""}`}
                    >
                      {/* Checkbox — stops propagation so it doesn't toggle expand */}
                      <input
                        type="checkbox"
                        checked={selected.has(m.slug)}
                        onChange={() => toggleSelect(m.slug)}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded border-gray-300 dark:border-gray-600 flex-shrink-0"
                      />
                      {/* Clickable area — toggles expand */}
                      <div
                        className="flex items-center gap-3 flex-1 min-w-0"
                        onClick={() => setExpanded(isExpanded ? null : m.slug)}
                      >
                        <ColorSwatch color={m.color} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`font-medium text-sm truncate ${isStub ? "text-gray-500 dark:text-gray-400" : ""}`}>
                              {m.name}
                            </span>
                            <TypeBadge type={m.type} />
                          </div>
                          <div className="flex items-center gap-3 mt-0.5">
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {m.brandName}
                            </span>
                            {m.nozzleTempMin != null && m.nozzleTempMax != null && (
                              <span className="text-xs text-gray-400 dark:text-gray-500">
                                {m.nozzleTempMin}–{m.nozzleTempMax}°C
                              </span>
                            )}
                            {m.density != null && (
                              <span className="text-xs text-gray-400 dark:text-gray-500">
                                {m.density} g/cm³
                              </span>
                            )}
                            {m.transmissionDistance != null && (
                              <span className="text-xs text-gray-400 dark:text-gray-500">
                                TD {m.transmissionDistance}
                              </span>
                            )}
                          </div>
                        </div>
                        <CompletenessBar score={m.completenessScore} tier={m.completenessTier} />
                        {/* Expand chevron */}
                        <svg
                          className={`w-4 h-4 text-gray-400 dark:text-gray-500 flex-shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                        </svg>
                      </div>
                    </div>
                    {isExpanded && <MaterialDetail m={m} />}
                  </div>
                );
              })
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

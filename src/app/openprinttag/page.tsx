"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { List, type RowComponentProps } from "react-window";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { safeHttpUrl } from "@/lib/safeRenderUrl";
import { formatMinutesAsHm } from "@/lib/formatDuration";

// Row layout constants — the virtualized List needs known heights so it
// can compute the absolute scroll position of every row without mounting
// it. ~52px matches the rendered row height (one line of text + 8px y
// padding × 2). Expanded rows include MaterialDetail which is a 3-column
// property grid; 360px covers it on the typical layout, with overflow
// allowed to scroll inside the row if a material has unusually many
// fields. Pre-virtualization the page mounted ~11.7k rows / 200k DOM
// nodes; this drops it to whatever fits in the viewport (GH #163).
const ROW_HEIGHT_PX = 52;
const EXPANDED_ROW_HEIGHT_PX = 412;

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
  /** #931: upstream commit SHA the cached data was parsed from (or last
   *  confirmed unchanged via the commits-API probe). May be absent on a
   *  very old cache entry. */
  sha?: string;
  /** #931: ISO timestamp of the most recent SHA probe — set to "now" on a
   *  successful tarball parse OR a TTL-slide commits probe. */
  shaCheckedAt?: string;
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
              {/* GH #807: dryingTime is stored in MINUTES (OPT spec key
                  drying_time). Render as "Xh Ym" — was wrongly suffixing the raw
                  minutes with "h" (480 → "480 h" instead of "8h 0m"). */}
              <DetailField label={t("openprinttag.detail.dryingTime")} value={formatMinutesAsHm(m.dryingTime)} />
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

          {(safeHttpUrl(m.productUrl) || safeHttpUrl(m.photoUrl)) && (
            <div className="mt-2 flex flex-col gap-1">
              {safeHttpUrl(m.productUrl) && (
                <a
                  href={safeHttpUrl(m.productUrl)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate"
                >
                  {t("openprinttag.detail.productPageLink")}
                </a>
              )}
              {safeHttpUrl(m.photoUrl) && (
                <a
                  href={safeHttpUrl(m.photoUrl)!}
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

// ── Virtualized row ────────────────────────────────────────────────────

interface MaterialRowProps {
  materials: OPTMaterial[];
  selectedSlugs: Set<string>;
  expandedSlug: string | null;
  toggleSelect: (slug: string) => void;
  setExpanded: (slug: string | null) => void;
}

/**
 * One row in the virtualized list. react-window mounts a window of these
 * (typically ~30–60 rows for a viewport-sized list with overscan) instead
 * of all 11.7k materials. The `style` prop carries absolute positioning
 * computed from the row index — must be applied to the outermost element.
 */
function MaterialRow({
  index,
  style,
  materials,
  selectedSlugs,
  expandedSlug,
  toggleSelect,
  setExpanded,
}: RowComponentProps<MaterialRowProps>) {
  const m = materials[index];
  if (!m) return null;
  const isStub = m.completenessTier === "stub";
  const isExpanded = expandedSlug === m.slug;

  return (
    <div style={style} className="border-b border-gray-100 dark:border-gray-800">
      <div
        className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${
          selectedSlugs.has(m.slug) ? "bg-blue-50 dark:bg-blue-900/20" : ""
        } ${isStub ? "opacity-50" : ""} ${isExpanded ? "bg-gray-50 dark:bg-gray-800/30" : ""}`}
        style={{ height: ROW_HEIGHT_PX }}
      >
        {/* Checkbox — stops propagation so it doesn't toggle expand */}
        <input
          type="checkbox"
          checked={selectedSlugs.has(m.slug)}
          onChange={() => toggleSelect(m.slug)}
          onClick={(e) => e.stopPropagation()}
          className="rounded border-gray-300 dark:border-gray-600 flex-shrink-0"
        />
        {/* GH #637 (#2): the expand/collapse target was a plain <div
            onClick>, so keyboard/SR users could tick the checkbox but never
            open MaterialDetail. role="button" + tabIndex + Enter/Space make
            it keyboard-operable; aria-expanded reports the disclosure
            state. The checkbox sits outside this element (and stops
            propagation), so toggling selection still doesn't expand. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          className="flex items-center gap-3 flex-1 min-w-0"
          onClick={() => setExpanded(isExpanded ? null : m.slug)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded(isExpanded ? null : m.slug);
            }
          }}
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
      {isExpanded && (
        <div style={{ height: EXPANDED_ROW_HEIGHT_PX - ROW_HEIGHT_PX, overflow: "auto" }}>
          <MaterialDetail m={m} />
        </div>
      )}
    </div>
  );
}

// ── Relative-time formatter ────────────────────────────────────────────

/**
 * Mirrors the pattern in `SyncStatusIndicator` — uses the existing
 * `sync.time.*` translation keys (justNow / minutesAgo / hoursAgo / daysAgo)
 * so the OPT browser's "checked Nm ago" line speaks the same language as the
 * rest of the app without duplicating translations. Returns null on a bad
 * timestamp so the caller can omit the suffix gracefully.
 */
function formatRelativeTime(
  iso: string | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (!iso) return null;
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return null;
  const diff = Date.now() - parsed;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("sync.time.justNow");
  if (mins < 60) return t("sync.time.minutesAgo", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("sync.time.hoursAgo", { count: hours });
  return t("sync.time.daysAgo", { count: Math.floor(hours / 24) });
}

// ── Main page ──────────────────────────────────────────────────────────

export default function OpenPrintTagBrowser() {
  const { t } = useTranslation();
  const { formatNumber } = useNumberFormat();
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
  // Issue #753 (approach A): import a single material AS A VARIANT of a chosen
  // parent. `parents` is the list of candidate root filaments, lazily fetched
  // the first time the user narrows to one selected material.
  const [variantParentId, setVariantParentId] = useState("");
  const [parents, setParents] = useState<
    { _id: string; name: string; vendor: string; type: string }[]
  >([]);
  const [parentsLoaded, setParentsLoaded] = useState(false);
  const { toast } = useToast();

  const fetchDatabase = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      // #743: a backstop against a truly-stuck request (the real "whole app
      // hangs" cause — a synchronous parse blocking the event loop — is fixed
      // server-side). This MUST exceed the server's worst-case window so it
      // never pre-empts the legitimate slow paths: the server retries only the
      // GitHub download (3×45s + ~3.2s backoff ≈ 138s), then extracts ONCE
      // under a 120s pipeline deadline (the YAML parse loop that follows is
      // unbounded — CPU-bound, yields every 256 files, runs once per cold
      // load), then serves a stale cached DB (GH #225) — a cached user on a
      // flaky network must still get that stale data, not a premature timeout
      // (PR #933 review). 300s (5 min) clears the ~258s server window with
      // ~42s of margin for the unbounded parse; the single-flight means a
      // retry after a timeout joins the in-progress load rather than
      // duplicating it.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300_000);
      try {
        // GH #427: refresh moved from `GET ?refresh=true` to POST so
        // the cache-mutation isn't a GET-with-side-effect.
        const res = refresh
          ? await fetch("/api/openprinttag", { method: "POST", signal: controller.signal })
          : await fetch("/api/openprinttag", { signal: controller.signal });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data: OPTDatabase = await res.json();
        setDb(data);
      } catch (err) {
        const timedOut = err instanceof DOMException && err.name === "AbortError";
        setError(timedOut ? t("openprinttag.loadTimeout") : String(err));
        toast(
          timedOut ? t("openprinttag.loadTimeout") : t("openprinttag.failedToLoad"),
          "error",
        );
      } finally {
        clearTimeout(timeout);
        setLoading(false);
      }
    },
    [toast, t],
  );

  useEffect(() => {
    // Initial load + manual refresh button both go through fetchDatabase.
    // fetchDatabase synchronously sets loading=true before awaiting, which
    // trips the rule, but this is the standard fetch-on-mount pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchDatabase();
  }, [fetchDatabase]);

  // Issue #753 (approach A): lazily load candidate parents (root filaments) the
  // first time the user narrows to a single material — avoids fetching the
  // whole filament list on every visit when nobody's importing a variant. The
  // setState calls live in an async callback (deferred), not the effect body.
  useEffect(() => {
    if (selected.size !== 1 || parentsLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/filaments");
        if (!res.ok) return;
        const list = (await res.json()) as {
          _id: string;
          name: string;
          vendor: string;
          type: string;
          parentId?: string | null;
        }[];
        if (cancelled) return;
        setParents(
          list
            .filter((f) => !f.parentId)
            .map(({ _id, name, vendor, type }) => ({ _id, name, vendor, type })),
        );
        setParentsLoaded(true);
      } catch {
        // Non-fatal — the variant affordance just stays unavailable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected.size, parentsLoaded]);

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

  // GH #291: `useCallback` keeps `toggleSelect` stable so the memoized
  // `rowProps` below doesn't change identity every render — react-window
  // re-renders a row whenever `rowProps` identity changes, and an
  // unstable callback there means every mounted virtualized row
  // re-renders on every keystroke in the search box.
  const toggleSelect = useCallback((slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of filteredMaterials) next.add(m.slug);
      return next;
    });
  };

  const deselectAll = () => setSelected(new Set());

  // GH #291: memoize the react-window rowProps so its identity only
  // changes when something a row actually renders from changes — not on
  // every parent render (e.g. a keystroke in the search box).
  const rowProps = useMemo(
    () => ({
      materials: filteredMaterials,
      selectedSlugs: selected,
      expandedSlug: expanded,
      toggleSelect,
      setExpanded,
    }),
    [filteredMaterials, selected, expanded, toggleSelect],
  );

  // Issue #753 (approach A): variant mode is only valid for a single selected
  // material with a chosen parent.
  const asVariant = selected.size === 1 && variantParentId !== "";

  const handleImport = async () => {
    if (selected.size === 0) return;
    setImporting(true);
    try {
      const res = await fetch("/api/openprinttag/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          asVariant
            ? { slugs: [...selected], parentId: variantParentId }
            : { slugs: [...selected] },
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || t("openprinttag.importFailed"), "error");
      } else {
        toast(data.message, "success");
        setSelected(new Set());
        setVariantParentId("");
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
      <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 sticky top-[var(--app-header-h)] z-20">
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
                  {t("openprinttag.subtitle", { fdmCount: formatNumber(db.totalFFF, { maxDecimals: 0 }), brandCount: db.brands.length })}
                  <span className="ml-2 text-gray-400">•</span>
                  <span className="ml-2">{t("openprinttag.slaFiltered", { slaCount: formatNumber(db.totalSLA, { maxDecimals: 0 }) })}</span>
                </p>
                {/* #931: surface the upstream-commit provenance — the SHA the
                    cached data was parsed from + when we last confirmed it
                    was current. Gated on `db.sha` so a pre-#931 cache
                    snapshot still renders the page without an empty
                    "commit · " label. */}
                {db.sha && (
                  <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                    {t("openprinttag.lastRefreshedFromCommit", {
                      sha: db.sha.slice(0, 7),
                    })}
                    {formatRelativeTime(db.shaCheckedAt, t) && (
                      <>
                        <span className="mx-1.5">·</span>
                        {t("openprinttag.checkedAgo", {
                          when: formatRelativeTime(db.shaCheckedAt, t)!,
                        })}
                      </>
                    )}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <span className="text-sm text-blue-600 dark:text-blue-400 font-medium">
                  {t("openprinttag.selectedCount", { count: selected.size })}
                </span>
              )}
              {/* Issue #753 (approach A): when exactly one material is selected,
                  offer to import it as a variant of a chosen parent. Picking a
                  parent only pulls the fields DISTINCT from it onto the variant;
                  leaving it on "no parent" keeps the standalone import. */}
              {selected.size === 1 && parents.length > 0 && (
                <select
                  value={variantParentId}
                  onChange={(e) => setVariantParentId(e.target.value)}
                  title={t("openprinttag.variantParentTitle")}
                  aria-label={t("openprinttag.variantParentLabel")}
                  className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 max-w-[16rem]"
                >
                  <option value="">{t("openprinttag.variantParentNone")}</option>
                  {parents.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.name} ({p.vendor} · {p.type})
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={handleImport}
                disabled={selected.size === 0 || importing}
                className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing
                  ? t("openprinttag.importing")
                  : asVariant
                    ? t("openprinttag.importAsVariant")
                    : t("openprinttag.importSelected", { count: selected.size })}
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
        <aside className="w-64 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 h-[calc(100vh-var(--app-header-h)-64px)] sticky top-[calc(var(--app-header-h)+64px)] overflow-y-auto">
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
        <main id="main-content" className="flex-1 min-w-0">
          {/* Toolbar */}
          <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/30 flex items-center justify-between sticky top-[calc(var(--app-header-h)+64px)] z-10">
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
                {t("openprinttag.filamentCount", { count: formatNumber(filteredMaterials.length, { maxDecimals: 0 }) })}
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

          {/* Material list — virtualized via react-window so only the rows
              in the viewport (+ small overscan) are mounted. The List
              fills the remaining viewport height; total scrollable height
              comes from rowHeight × rowCount, so the scroll position
              stays meaningful even with 11.7k entries. (GH #163) */}
          {filteredMaterials.length === 0 ? (
            <div className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
              {t("openprinttag.noResults")}
            </div>
          ) : (
            <div className="h-[calc(100vh-var(--app-header-h)-64px-41px)]">
              <List
                rowComponent={MaterialRow}
                rowCount={filteredMaterials.length}
                // Returning a different height for the expanded row makes
                // react-window remeasure on every change to rowProps —
                // including the expandedSlug change below — so the layout
                // updates without us calling an imperative API.
                rowHeight={(index, props) =>
                  props.materials[index]?.slug === props.expandedSlug
                    ? EXPANDED_ROW_HEIGHT_PX
                    : ROW_HEIGHT_PX
                }
                rowProps={rowProps}
                overscanCount={5}
                style={{ height: "100%" }}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

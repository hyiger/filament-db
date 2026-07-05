"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { Skeleton, SkeletonRegion } from "@/components/Skeleton";
import { niceAxisScale } from "@/lib/chartScale";
import { formatGrams } from "@/lib/formatWeight";
import { useDateFormat } from "@/hooks/useDateFormat";

interface DayFilamentSegment {
  id: string;
  name: string;
  color: string;
  grams: number;
}

interface AnalyticsData {
  since: string;
  days: number;
  totals: { grams: number; cost: number; jobs: number; manualEntries: number };
  /** GH #934: each day carries its total grams (used by the Y-axis math)
   *  plus a per-filament breakdown sorted DESCENDING by grams so the
   *  stacked chart can render largest-at-the-bottom without re-sorting. */
  usageByDay: { date: string; grams: number; byFilament: DayFilamentSegment[] }[];
  byFilament: { _id: string; name: string; vendor: string; cost: number | null; grams: number }[];
  byVendor: { vendor: string; grams: number }[];
  byPrinter: { _id: string; name: string; grams: number }[];
}

const DAY_OPTIONS = [7, 30, 90, 365];

/** GH #934: localStorage key for the per-user "detailed" toggle on the
 *  Usage-by-day chart. Default off — flipping it stacks each bar by
 *  filament with each segment painted in the filament's hex color. */
const DETAILED_STORAGE_KEY = "filamentdb-analytics-usage-detailed";
/** Cap on the in-chart legend chips when Detailed is on. */
const LEGEND_TOP_N = 10;

export default function AnalyticsPage() {
  const { t } = useTranslation();
  const { formatDate } = useDateFormat();
  const { format: formatCurrency } = useCurrency();
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  // GH #288: a failed fetch used to leave `data` null + `loading` false
  // and render a blank page indistinguishable from "no data". Track an
  // explicit error so the user gets a message + retry, like the dashboard.
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // GH #934: opt-in stacked-by-filament render mode for the Usage-by-day
  // chart. Initialised with the default so the SSR HTML and first client
  // paint match; the stored preference loads in a post-mount effect (the
  // same pattern as `src/app/inventory/page.tsx:186`). `detailedLoaded`
  // gates the persist effect so it can't clobber storage with the default
  // before the load runs.
  const [detailed, setDetailed] = useState<boolean>(false);
  const detailedLoaded = useRef(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(DETAILED_STORAGE_KEY) === "1") {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- persisted pref
        setDetailed(true);
      }
    } catch {
      /* localStorage may be unavailable (Safari private mode). */
    }
    detailedLoaded.current = true;
  }, []);

  useEffect(() => {
    if (!detailedLoaded.current) return;
    try {
      window.localStorage.setItem(DETAILED_STORAGE_KEY, detailed ? "1" : "0");
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [detailed]);

  const toggleDetailed = () => setDetailed((prev) => !prev);

  useEffect(() => {
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-lifecycle flag
    setLoading(true);
    fetch(`/api/analytics?days=${days}`, { signal: ac.signal })
      .then((r) =>
        r.ok
          ? r.json()
          : Promise.reject(new Error(r.statusText || `HTTP ${r.status}`)),
      )
      .then((d) => {
        setData(d);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to load analytics:", err);
        setError(t("analytics.loadError"));
        setLoading(false);
      });
    return () => ac.abort();
  }, [days, reloadKey, t]);

  /** Clear the error and re-run the fetch effect. */
  const retry = () => {
    setError(null);
    setReloadKey((k) => k + 1);
  };

  const maxDayGrams = useMemo(() => {
    if (!data) return 0;
    return data.usageByDay.reduce((max, d) => Math.max(max, d.grams), 0);
  }, [data]);

  // #716: a rounded axis scale + tick values so the "Usage by day" bars are
  // readable against gridlines instead of guessing magnitudes by eye.
  const dayScale = useMemo(() => niceAxisScale(maxDayGrams), [maxDayGrams]);

  /** GH #934: pre-format each day's `date` prefix once per data/locale
   *  change. `formatDate` allocates a fresh `Intl.DateTimeFormat` on
   *  every call; without memoisation a 365-day window would rebuild the
   *  formatter 365× per render and re-run on every state change
   *  (Detailed toggle, retry, days-range flip). `timeZone: "UTC"` is
   *  load-bearing — `d.date` is a UTC calendar-day key from the server;
   *  local-timezone rendering shifts it by ±1 day west/east of UTC and
   *  disagrees with the axis endpoint labels below. */
  const dayDateByKey = useMemo(() => {
    const map = new Map<string, string>();
    if (!data) return map;
    for (const d of data.usageByDay) {
      map.set(d.date, formatDate(d.date, { timeZone: "UTC" }));
    }
    return map;
  }, [data, formatDate]);

  /** GH #934: legend chips for the Detailed mode — one entry per filament
   *  that appears anywhere in the window, sorted DESC by total grams, with
   *  the first occurrence's hex color (an inheriting variant resolves the
   *  same color across days, so picking-the-first is stable). Capped at
   *  the top N; the remainder is summarised as "+M more". */
  const dayLegend = useMemo(() => {
    if (!data) return { top: [] as DayFilamentSegment[], more: 0 };
    const totals = new Map<
      string,
      { id: string; name: string; color: string; grams: number }
    >();
    for (const d of data.usageByDay) {
      for (const seg of d.byFilament) {
        const existing = totals.get(seg.id);
        if (existing) existing.grams += seg.grams;
        else
          totals.set(seg.id, {
            id: seg.id,
            name: seg.name,
            color: seg.color,
            grams: seg.grams,
          });
      }
    }
    const sorted = Array.from(totals.values()).sort((a, b) => b.grams - a.grams);
    return {
      top: sorted.slice(0, LEGEND_TOP_N),
      more: Math.max(0, sorted.length - LEGEND_TOP_N),
    };
  }, [data]);

  const maxByFilament = useMemo(() => {
    if (!data) return 0;
    return data.byFilament.reduce((max, f) => Math.max(max, f.grams), 0);
  }, [data]);

  const maxByVendor = useMemo(() => {
    if (!data) return 0;
    return data.byVendor.reduce((max, v) => Math.max(max, v.grams), 0);
  }, [data]);

  return (
    <main id="main-content" className="w-full px-4 py-8">
      <div className="flex items-end justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold">{t("analytics.title")}</h1>
          <p className="text-sm text-gray-500">{t("analytics.subtitle")}</p>
        </div>
        <div className="flex gap-1.5">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                days === d
                  ? "bg-blue-600 text-white border-blue-600"
                  : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-gray-400"
              }`}
            >
              {t("analytics.daysRange", { days: d })}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && (
        // GH #449: skeleton placeholders — totals row + chart area +
        // 4-row table — so the layout doesn't reflow when the
        // analytics fetch lands.
        <SkeletonRegion label={t("common.loading")} className="space-y-6">
          <div className="grid grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-2"
              >
                <Skeleton className="h-3 w-20 rounded" />
                <Skeleton className="h-7 w-16 rounded" />
              </div>
            ))}
          </div>
          <Skeleton className="h-48 w-full rounded" />
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full rounded" />
            ))}
          </div>
        </SkeletonRegion>
      )}

      {error && !loading && (
        <div className="border border-gray-200 dark:border-gray-800 rounded p-6 text-center">
          <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-gray-400"
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {data && !error && (
        <>
          {/* Totals */}
          <div className="grid grid-cols-3 gap-3 mb-8">
            <StatBox label={t("analytics.totalGrams")} value={`${formatGrams(data.totals.grams)} g`} />
            <StatBox
              label={t("analytics.totalCost")}
              value={
                data.totals.cost > 0 ? formatCurrency(data.totals.cost) : "—"
              }
            />
            {/* GH #204: when there are no PrintHistory rows but the
                grams + cost totals are non-zero, the value came from
                manual per-spool usage entries. Show the "+N manual"
                hint underneath the Print jobs counter so the user can
                attribute the totals. */}
            <StatBox
              label={t("analytics.totalJobs")}
              value={String(data.totals.jobs)}
              hint={
                data.totals.manualEntries > 0
                  ? t("analytics.manualEntriesHint", { count: data.totals.manualEntries })
                  : undefined
              }
            />
          </div>

          {/* Single page-level empty state when no usage was recorded in the
              window. Avoids repeating the same "no data" line under every
              section heading. */}
          {data.usageByDay.every((d) => d.grams === 0) &&
            data.byFilament.length === 0 &&
            data.byVendor.length === 0 ? (
              <div className="border border-gray-200 dark:border-gray-800 rounded p-6 text-center">
                <p className="text-sm text-gray-500">{t("analytics.noData")}</p>
              </div>
            ) : (
            <>
          {/* Usage by day */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <h2 className="text-lg font-semibold">
                {t("analytics.usageByDay")}
              </h2>
              {/* GH #934: opt-in stacked-by-filament toggle. Persisted in
                  localStorage so the user's choice survives a reload. */}
              <button
                type="button"
                onClick={toggleDetailed}
                aria-pressed={detailed}
                title={t("analytics.usageByDay.detailed.tooltip")}
                className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                  detailed
                    ? "bg-blue-600 text-white border-blue-600"
                    : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-gray-400"
                }`}
              >
                {t("analytics.usageByDay.detailed")}
              </button>
            </div>
            {data.usageByDay.every((d) => d.grams === 0) ? (
              <p className="text-sm text-gray-500">{t("analytics.noData")}</p>
            ) : (
              <div className="border border-gray-200 dark:border-gray-700 rounded p-3">
                <div className="flex">
                  {/* Y axis: tick labels positioned to line up with the
                      gridlines (bottom = tick/max). */}
                  <div className="relative h-40 w-10 shrink-0 mr-2" aria-hidden="true">
                    {dayScale.ticks.map((tick) => (
                      <span
                        key={tick}
                        className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-gray-400 dark:text-gray-500"
                        style={{ bottom: `${dayScale.max > 0 ? (tick / dayScale.max) * 100 : 0}%` }}
                      >
                        {tick}
                      </span>
                    ))}
                  </div>
                  {/* Plot: gridlines behind, bars in front. Bars scale against
                      dayScale.max so the tallest aligns under the top gridline.
                      The column wrappers are h-full so the % bar height
                      resolves against a definite height (the prior bug: a
                      `flex items-end` row doesn't stretch its children, so
                      `height: N%` collapsed every bar to its 2px minHeight). */}
                  <div className="relative flex-1 h-40">
                    {dayScale.ticks.map((tick) => (
                      <div
                        key={tick}
                        className="absolute inset-x-0 border-t border-gray-200 dark:border-gray-800"
                        style={{ bottom: `${dayScale.max > 0 ? (tick / dayScale.max) * 100 : 0}%` }}
                      />
                    ))}
                    <div className="absolute inset-0 flex items-end gap-0.5">
                      {data.usageByDay.map((d) => {
                        const pct = dayScale.max > 0 ? (d.grams / dayScale.max) * 100 : 0;
                        // GH #934 / Codex P3: route the YYYY-MM-DD prefix
                        // through the memoised formatter map (built with
                        // `timeZone: "UTC"` so the calendar day matches
                        // the server key) rather than allocating a fresh
                        // Intl instance per day per render.
                        const dayDate = dayDateByKey.get(d.date) ?? d.date;
                        const dayLabel = `${dayDate}: ${formatGrams(d.grams)} g`;
                        // GH #934: in Detailed mode, render the bar as a
                        // vertical stack of segments — one per filament,
                        // height proportional to its share of the day,
                        // colored by the filament's hex. The wrapper
                        // carries the per-day aria-label on BOTH branches
                        // so toggling Detailed doesn't silently change
                        // the SR announcement. Segments are decorative —
                        // no `role` / no `tabIndex` — so the chart
                        // doesn't blow out keyboard navigation, and the
                        // 1px contrast stroke is an INSET `box-shadow`
                        // (not an outer `border`) so it doesn't consume
                        // layout pixels on thin slices under
                        // `box-sizing: border-box` (Tailwind preflight).
                        if (detailed && d.grams > 0 && d.byFilament.length > 0) {
                          return (
                            <div
                              key={d.date}
                              className="flex-1 h-full flex flex-col items-center justify-end"
                              title={dayLabel}
                              aria-label={dayLabel}
                            >
                              <div
                                className="w-full flex flex-col-reverse rounded-sm overflow-hidden"
                                style={{ height: `${pct}%`, minHeight: "2px" }}
                              >
                                {d.byFilament.map((seg) => {
                                  const segPct =
                                    d.grams > 0 ? (seg.grams / d.grams) * 100 : 0;
                                  const segLabel = t(
                                    "analytics.usageByDay.tooltipFormat",
                                    { name: seg.name, grams: formatGrams(seg.grams) },
                                  );
                                  const segTooltip = t(
                                    "analytics.usageByDay.segmentTooltipFormat",
                                    { date: dayDate, label: segLabel },
                                  );
                                  return (
                                    <div
                                      key={seg.id}
                                      title={segTooltip}
                                      style={{
                                        height: `${segPct}%`,
                                        backgroundColor: seg.color,
                                        // Inset stroke: doesn't
                                        // participate in the box model,
                                        // so a 5% slice on a 60px bar
                                        // (3px total) keeps 3px of
                                        // seg.color visible instead of
                                        // losing 2px to a border. Two
                                        // rings (semi-transparent black
                                        // + white) so the rim reads
                                        // against both bright and dark
                                        // segment fills without a
                                        // separate dark-mode variant.
                                        boxShadow:
                                          "inset 0 0 0 1px rgba(0,0,0,0.20), inset 0 0 0 2px rgba(255,255,255,0.08)",
                                      }}
                                    />
                                  );
                                })}
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div
                            key={d.date}
                            className="flex-1 h-full flex flex-col items-center justify-end"
                            title={dayLabel}
                            aria-label={dayLabel}
                          >
                            <div
                              className={`w-full ${d.grams > 0 ? "bg-blue-500" : "bg-transparent"} rounded-sm`}
                              style={{ height: `${pct}%`, minHeight: d.grams > 0 ? "2px" : "0" }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="flex justify-between text-xs text-gray-500 mt-2 pl-12">
                  <span>
                    {(() => {
                      const k = data.usageByDay[0]?.date;
                      return k ? (dayDateByKey.get(k) ?? k) : "";
                    })()}
                  </span>
                  <span>
                    {(() => {
                      const k =
                        data.usageByDay[data.usageByDay.length - 1]?.date;
                      return k ? (dayDateByKey.get(k) ?? k) : "";
                    })()}
                  </span>
                </div>
                {/* GH #934: legend, Detailed mode only. One chip per
                    filament in the window, sorted by total grams desc,
                    capped at the top N with a "+M more" tail. */}
                {detailed && dayLegend.top.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-3 pl-12 text-xs text-gray-700 dark:text-gray-300">
                    {dayLegend.top.map((entry) => (
                      <span key={entry.id} className="inline-flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className="inline-block w-2.5 h-2.5 rounded-sm border border-gray-300 dark:border-gray-700"
                          style={{ backgroundColor: entry.color }}
                        />
                        <span className="truncate max-w-[12rem]">{entry.name}</span>
                      </span>
                    ))}
                    {dayLegend.more > 0 && (
                      <span className="text-gray-500 dark:text-gray-400">
                        {t("analytics.usageByDay.moreCount", { count: dayLegend.more })}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Top filaments */}
          <section className="mb-8">
            <h2 className="text-lg font-semibold mb-3">{t("analytics.topFilaments")}</h2>
            {data.byFilament.length === 0 ? (
              <p className="text-sm text-gray-500">{t("analytics.noData")}</p>
            ) : (
              <div className="space-y-1">
                {data.byFilament.slice(0, 10).map((f) => {
                  const pct = maxByFilament > 0 ? (f.grams / maxByFilament) * 100 : 0;
                  return (
                    <Link
                      key={f._id}
                      href={`/filaments/${f._id}`}
                      className="block hover:bg-gray-50 dark:hover:bg-gray-900 rounded px-2 py-1"
                    >
                      <div className="flex items-center gap-3 text-sm">
                        <span className="flex-1 min-w-0 truncate text-gray-900 dark:text-gray-100">
                          {f.name}{" "}
                          <span className="text-gray-500 text-xs">{f.vendor}</span>
                        </span>
                        <span className="w-20 text-right text-xs text-gray-500">
                          {formatGrams(f.grams)} g
                        </span>
                        <div className="w-40 bg-gray-200 dark:bg-gray-800 rounded-full h-2 flex-shrink-0">
                          <div
                            className="h-2 rounded-full bg-blue-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          {/* By vendor */}
          <section className="mb-8">
            <h2 className="text-lg font-semibold mb-3">{t("analytics.byVendor")}</h2>
            {data.byVendor.length === 0 ? (
              <p className="text-sm text-gray-500">{t("analytics.noData")}</p>
            ) : (
              <div className="space-y-1">
                {data.byVendor.map((v) => {
                  const pct = maxByVendor > 0 ? (v.grams / maxByVendor) * 100 : 0;
                  return (
                    <div
                      key={v.vendor}
                      className="flex items-center gap-3 text-sm px-2 py-1"
                    >
                      <span className="flex-1 min-w-0 truncate">{v.vendor}</span>
                      <span className="w-20 text-right text-xs text-gray-500">
                        {formatGrams(v.grams)} g
                      </span>
                      <div className="w-40 bg-gray-200 dark:bg-gray-800 rounded-full h-2 flex-shrink-0">
                        <div
                          className="h-2 rounded-full bg-indigo-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* By printer */}
          {data.byPrinter.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold mb-3">{t("analytics.byPrinter")}</h2>
              <ul className="text-sm">
                {data.byPrinter.map((p) => (
                  <li key={p._id} className="flex justify-between px-2 py-1">
                    <span>{p.name}</span>
                    <span className="text-gray-500">{formatGrams(p.grams)} g</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
            </>
          )}
        </>
      )}
    </main>
  );
}

function StatBox({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded px-3 py-2 bg-white dark:bg-gray-900">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-xl font-semibold mt-0.5">{value}</div>
      {hint ? (
        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">{hint}</div>
      ) : null}
    </div>
  );
}

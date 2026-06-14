"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { Skeleton, SkeletonRegion } from "@/components/Skeleton";
import { niceAxisScale } from "@/lib/chartScale";

interface AnalyticsData {
  since: string;
  days: number;
  totals: { grams: number; cost: number; jobs: number; manualEntries: number };
  usageByDay: { date: string; grams: number }[];
  byFilament: { _id: string; name: string; vendor: string; cost: number | null; grams: number }[];
  byVendor: { vendor: string; grams: number }[];
  byPrinter: { _id: string; name: string; grams: number }[];
}

const DAY_OPTIONS = [7, 30, 90, 365];

export default function AnalyticsPage() {
  const { t } = useTranslation();
  const { format: formatCurrency } = useCurrency();
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  // GH #288: a failed fetch used to leave `data` null + `loading` false
  // and render a blank page indistinguishable from "no data". Track an
  // explicit error so the user gets a message + retry, like the dashboard.
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
            <StatBox label={t("analytics.totalGrams")} value={`${data.totals.grams} g`} />
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
            <h2 className="text-lg font-semibold mb-3">
              {t("analytics.usageByDay")}
            </h2>
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
                        return (
                          <div
                            key={d.date}
                            className="flex-1 h-full flex flex-col items-center justify-end"
                            title={`${d.date}: ${d.grams} g`}
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
                  <span>{data.usageByDay[0]?.date}</span>
                  <span>
                    {data.usageByDay[data.usageByDay.length - 1]?.date}
                  </span>
                </div>
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
                          {f.grams} g
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
                        {v.grams} g
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
                    <span className="text-gray-500">{p.grams} g</span>
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

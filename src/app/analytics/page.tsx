"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useCurrency } from "@/hooks/useCurrency";

interface AnalyticsData {
  since: string;
  days: number;
  totals: { grams: number; cost: number; jobs: number };
  usageByDay: { date: string; grams: number }[];
  byFilament: { _id: string; name: string; vendor: string; cost: number | null; grams: number }[];
  byVendor: { vendor: string; grams: number }[];
  byPrinter: { _id: string; name: string; grams: number }[];
}

const DAY_OPTIONS = [7, 30, 90, 365];

export default function AnalyticsPage() {
  const { t } = useTranslation();
  const { symbol: currencySymbol } = useCurrency();
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-lifecycle flag
    setLoading(true);
    fetch(`/api/analytics?days=${days}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => ac.abort();
  }, [days]);

  const maxDayGrams = useMemo(() => {
    if (!data) return 0;
    return data.usageByDay.reduce((max, d) => Math.max(max, d.grams), 0);
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
    <main className="max-w-5xl mx-auto px-4 py-8">
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

      {loading && !data && <p className="text-sm text-gray-500">{t("common.loading")}</p>}

      {data && (
        <>
          {/* Totals */}
          <div className="grid grid-cols-3 gap-3 mb-8">
            <StatBox label={t("analytics.totalGrams")} value={`${data.totals.grams} g`} />
            <StatBox
              label={t("analytics.totalCost")}
              value={
                data.totals.cost > 0 ? `${currencySymbol}${data.totals.cost.toFixed(2)}` : "—"
              }
            />
            <StatBox label={t("analytics.totalJobs")} value={String(data.totals.jobs)} />
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
                <div className="flex items-end gap-0.5 h-40">
                  {data.usageByDay.map((d) => {
                    const pct = maxDayGrams > 0 ? (d.grams / maxDayGrams) * 100 : 0;
                    return (
                      <div
                        key={d.date}
                        className="flex-1 flex flex-col items-center justify-end"
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
                <div className="flex justify-between text-xs text-gray-500 mt-2">
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

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded px-3 py-2 bg-white dark:bg-gray-900">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-xl font-semibold mt-0.5">{value}</div>
    </div>
  );
}

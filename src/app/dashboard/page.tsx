"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useCurrency } from "@/hooks/useCurrency";

interface DashboardData {
  counts: {
    filaments: number;
    nozzles: number;
    printers: number;
    bedTypes: number;
    spools: number;
    retiredSpools: number;
    totalSpools: number;
  };
  totalGrams: number;
  lowStock: {
    _id: string;
    name: string;
    vendor: string;
    color: string;
    remainingGrams: number;
    threshold: number;
  }[];
  dryDue: {
    filamentId: string;
    filamentName: string;
    spoolId: string;
    spoolLabel: string;
    lastDried: string | null;
  }[];
  recentPrintHistory: {
    _id: string;
    jobLabel: string;
    printerName: string | null;
    startedAt: string;
    source: string;
    totalGrams: number;
  }[];
}

export default function DashboardPage() {
  const { t } = useTranslation();
  useCurrency(); // reserved for per-vendor cost summaries later
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/dashboard", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(setData)
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(String(err));
      });
    return () => ac.abort();
  }, []);

  /** Spool labels imported from Prusament come through as
   * `<instanceId> (<ISO timestamp>)`. The ISO chunk reads as raw
   * machine output in a dashboard list — convert it to the user's
   * locale date so the line scans as "name · 0a1b2c3d4e (Jan 5, 2025)"
   * instead of "name · 0a1b2c3d4e (2025-01-05T08:21:40+01:00)". Other
   * label shapes (e.g. user-typed "Drybox A") pass through unchanged. */
  const prettifySpoolLabel = (label: string): string =>
    label.replace(/\((\d{4}-\d{2}-\d{2}T[\d:+\-Z.]+)\)/g, (_, iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? `(${iso})` : `(${d.toLocaleDateString()})`;
    });

  if (error) {
    return (
      <main className="max-w-5xl mx-auto px-4 py-8">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="max-w-5xl mx-auto px-4 py-8">
        <p className="text-sm text-gray-500">{t("common.loading")}</p>
      </main>
    );
  }

  const kg = (data.totalGrams / 1000).toFixed(2);

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">{t("dashboard.title")}</h1>

      {/* Top metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        <Metric label={t("dashboard.filaments")} value={data.counts.filaments} href="/" />
        <Metric
          label={t("dashboard.spools")}
          value={data.counts.spools}
          hint={
            data.counts.retiredSpools > 0
              ? t("dashboard.spools.retiredHint", { count: data.counts.retiredSpools })
              : undefined
          }
        />
        <Metric label={t("dashboard.totalWeight")} value={`${kg} kg`} />
        <Metric label={t("dashboard.printers")} value={data.counts.printers} href="/printers" />
        <Metric label={t("dashboard.nozzles")} value={data.counts.nozzles} href="/nozzles" />
        <Metric label={t("dashboard.bedTypes")} value={data.counts.bedTypes} href="/bed-types" />
      </div>

      {/* Low stock */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-2">
          {t("dashboard.lowStock.title", { count: data.lowStock.length })}
        </h2>
        {data.lowStock.length === 0 ? (
          <p className="text-sm text-gray-500">{t("dashboard.lowStock.empty")}</p>
        ) : (
          <div className="border border-gray-200 dark:border-gray-700 rounded divide-y divide-gray-200 dark:divide-gray-700">
            {data.lowStock.map((f) => {
              const pct = Math.min(100, (f.remainingGrams / f.threshold) * 100);
              return (
                <Link
                  href={`/filaments/${f._id}`}
                  key={f._id}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <div
                    className="w-6 h-6 rounded-full border border-gray-300 flex-shrink-0"
                    style={{ backgroundColor: f.color }}
                    aria-hidden="true"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{f.name}</p>
                    <p className="text-xs text-gray-500">{f.vendor}</p>
                  </div>
                  <div className="w-24 bg-gray-200 dark:bg-gray-800 rounded-full h-2 flex-shrink-0">
                    <div
                      className="h-2 rounded-full bg-red-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="text-xs text-red-600 dark:text-red-400 w-32 text-right flex-shrink-0">
                    {t("dashboard.lowStock.remaining", {
                      remaining: Math.round(f.remainingGrams),
                      threshold: Math.round(f.threshold),
                    })}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Dry-due */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-2">
          {t("dashboard.dryDue.title", { count: data.dryDue.length })}
        </h2>
        {data.dryDue.length === 0 ? (
          <p className="text-sm text-gray-500">{t("dashboard.dryDue.empty")}</p>
        ) : (
          <ul className="text-sm space-y-1">
            {data.dryDue.map((d) => (
              <li key={`${d.filamentId}-${d.spoolId}`}>
                <Link
                  href={`/filaments/${d.filamentId}`}
                  className="text-blue-600 hover:underline"
                >
                  {d.filamentName}
                  {d.spoolLabel && (
                    <span className="text-gray-500"> · {prettifySpoolLabel(d.spoolLabel)}</span>
                  )}
                </Link>
                <span className="text-gray-500 text-xs ml-2">
                  {d.lastDried
                    ? t("dashboard.dryDue.lastDried", {
                        date: new Date(d.lastDried).toLocaleDateString(),
                      })
                    : t("dashboard.dryDue.never")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent print history */}
      <section>
        <h2 className="text-lg font-semibold mb-2">{t("dashboard.recentPrints")}</h2>
        {data.recentPrintHistory.length === 0 ? (
          <p className="text-sm text-gray-500">{t("dashboard.recentPrints.empty")}</p>
        ) : (
          <ul className="text-sm divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded">
            {data.recentPrintHistory.map((p) => (
              <li key={p._id} className="px-3 py-2 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{p.jobLabel}</p>
                  <p className="text-xs text-gray-500">
                    {p.printerName ? `${p.printerName} · ` : ""}
                    {new Date(p.startedAt).toLocaleString()}
                    {p.source !== "manual" && ` · ${p.source}`}
                  </p>
                </div>
                <span className="text-xs text-gray-500 flex-shrink-0">
                  {p.totalGrams.toFixed(1)} g
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: number | string;
  href?: string;
  hint?: string;
}) {
  const content = (
    <div className="border border-gray-200 dark:border-gray-700 rounded px-3 py-2 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-600 transition-colors h-full">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-xl font-semibold text-gray-900 dark:text-gray-100 mt-0.5">
        {value}
      </div>
      {hint ? (
        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">{hint}</div>
      ) : null}
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}

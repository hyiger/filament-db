"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useCurrency } from "@/hooks/useCurrency";
import { Skeleton, SkeletonRegion } from "@/components/Skeleton";
import LogPrintJobDialog from "@/components/LogPrintJobDialog";

interface DashboardData {
  counts: {
    filaments: number;
    /** GH #1113: how many of `filaments` are TEMPLATES — the records the
     *  filament list removes from its own headline count. */
    filamentTemplates: number;
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
  /** #1117(b): the UNCAPPED count. Optional so a client running against an
   *  older server (or a cached response) still renders — it falls back to the
   *  list length, which is the pre-fix behaviour rather than a crash. */
  dryDueTotal?: number;
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
  const { formatDate, formatDateTime } = useDateFormat();
  const { formatGrams, formatNumber } = useNumberFormat();
  useCurrency(); // reserved for per-vendor cost summaries later
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // GH #1167: in-app "Log print job" dialog — the first first-party writer of
  // POST /api/print-history. onLogged bumps reloadKey so the card refetches.
  const [showLogJob, setShowLogJob] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/dashboard", { signal: ac.signal })
      .then((r) =>
        r.ok
          ? r.json()
          : Promise.reject(new Error(r.statusText || `HTTP ${r.status}`)),
      )
      .then(setData)
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // GH #289: `r.statusText` is often empty on HTTP/2, so the old
        // `setError(String(err))` rendered a raw, untranslated, sometimes
        // "undefined" string. Log the real cause for debugging; show the
        // user a translated message like every other page.
        console.error("Failed to load dashboard:", err);
        setError(t("dashboard.loadError"));
      });
    return () => ac.abort();
  }, [reloadKey, t]);

  /** Clear the error and re-run the fetch effect. */
  const retry = () => {
    setError(null);
    setReloadKey((k) => k + 1);
  };

  /** True when the stored value is exactly UTC midnight — the shape a
   *  date-only entry takes (the Log-print-job picker sends a bare
   *  `YYYY-MM-DD` for past days, stored as `00:00:00.000Z`). Same
   *  detection as the filament detail page's usage disclosure (#941):
   *  real "now" timestamps are effectively never exactly UTC midnight. */
  const isUtcMidnight = (value: string): boolean => {
    const d = new Date(value);
    return (
      !Number.isNaN(d.getTime()) &&
      d.getUTCHours() === 0 &&
      d.getUTCMinutes() === 0 &&
      d.getUTCSeconds() === 0 &&
      d.getUTCMilliseconds() === 0
    );
  };

  /** Spool labels imported from Prusament come through as
   * `<instanceId> (<ISO timestamp>)`. The ISO chunk reads as raw
   * machine output in a dashboard list — convert it to the user's
   * locale date so the line scans as "name · 0a1b2c3d4e (Jan 5, 2025)"
   * instead of "name · 0a1b2c3d4e (2025-01-05T08:21:40+01:00)". Other
   * label shapes (e.g. user-typed "Drybox A") pass through unchanged. */
  const prettifySpoolLabel = (label: string): string =>
    label.replace(/\((\d{4}-\d{2}-\d{2}T[\d:+\-Z.]+)\)/g, (_, iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? `(${iso})` : `(${formatDate(d)})`;
    });

  if (error) {
    return (
      <main id="main-content" className="w-full px-4 py-8">
        <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>
        <button
          type="button"
          onClick={retry}
          className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-gray-400"
        >
          {t("common.retry")}
        </button>
      </main>
    );
  }

  if (!data) {
    // GH #449: skeleton placeholders — 6 metric tiles + a couple of
    // section blocks — so the layout doesn't reflow when content
    // lands. Matches the shape that comes back from /api/dashboard.
    return (
      <main id="main-content" className="w-full px-4 py-8">
        <SkeletonRegion label={t("common.loading")} className="space-y-6">
          <Skeleton className="h-9 w-48 rounded" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-2"
              >
                <Skeleton className="h-3 w-20 rounded" />
                <Skeleton className="h-7 w-16 rounded" />
              </div>
            ))}
          </div>
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-2"
            >
              <Skeleton className="h-5 w-40 rounded" />
              {Array.from({ length: 3 }).map((__, j) => (
                <Skeleton key={j} className="h-4 w-full rounded" />
              ))}
            </div>
          ))}
        </SkeletonRegion>
      </main>
    );
  }

  // #1117(b): the API caps the dry-due LIST but reports the real total. Fall
  // back to the list length when the field is absent (older server / cached
  // response) — that is exactly the pre-fix rendering, not a crash.
  const dryDueTotal = data.dryDueTotal ?? data.dryDue.length;
  const dryDueHidden = Math.max(0, dryDueTotal - data.dryDue.length);

  const kg = formatNumber(data.totalGrams / 1000, {
    minDecimals: 2,
    maxDecimals: 2,
    trimTrailingZeros: false,
  });

  return (
    <main id="main-content" className="w-full px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">{t("dashboard.title")}</h1>

      {/* Top metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        <Metric
          label={t("dashboard.filaments")}
          value={data.counts.filaments}
          href="/"
          // GH #1113: the list headlines the rows it renders (templates
          // excluded); this counts every record. Naming the EXCLUDED records
          // is what explains the gap — counting variants would name a
          // different number.
          hint={
            data.counts.filamentTemplates > 0
              ? t("dashboard.filaments.templateHint", { count: data.counts.filamentTemplates })
              : undefined
          }
        />
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
          {/* #1117(b): the TRUE count, not the capped list length. */}
          {t("dashboard.dryDue.title", { count: dryDueTotal })}
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
                        date: formatDate(d.lastDried),
                      })
                    : t("dashboard.dryDue.never")}
                </span>
              </li>
            ))}
          </ul>
        )}
        {dryDueHidden > 0 && (
          // Not a link: no page lists dry-due spools, so a link would have
          // nowhere honest to go. Saying how many are hidden still beats a
          // silent truncation that reads as a complete list.
          <p className="text-xs text-gray-500 mt-1">
            {t("dashboard.dryDue.more", { count: dryDueHidden })}
          </p>
        )}
      </section>

      {/* Recent print history */}
      <section>
        <div className="flex items-center justify-between mb-2 gap-3">
          <h2 className="text-lg font-semibold">{t("dashboard.recentPrints")}</h2>
          <div className="flex items-center gap-3">
            <Link
              href="/history"
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              {t("history.viewAll")}
            </Link>
            <button
              type="button"
              onClick={() => setShowLogJob(true)}
              className="px-2.5 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              {t("printJob.open")}
            </button>
          </div>
        </div>
        {showLogJob && (
          <LogPrintJobDialog
            onLogged={() => setReloadKey((k) => k + 1)}
            onClose={() => setShowLogJob(false)}
          />
        )}
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
                    {/* Codex P2 (PR #1182): a date-only backfill is stored as
                        UTC midnight — formatted as a LOCAL datetime it reads
                        as the previous evening west of UTC. Render it as a
                        UTC calendar day instead (the #941 convention). */}
                    {isUtcMidnight(p.startedAt)
                      ? formatDate(p.startedAt, { timeZone: "UTC" })
                      : formatDateTime(p.startedAt)}
                    {p.source !== "manual" && ` · ${p.source}`}
                  </p>
                </div>
                <span className="text-xs text-gray-500 flex-shrink-0">
                  {formatGrams(p.totalGrams)} g
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

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { safeGrams, sumUsageGrams } from "@/lib/capUsageHistory";

/**
 * GH #1168 — print-history / usage browser.
 *
 * Two deliberately SEPARATE tabs, because job/slicer-tagged spool ledger
 * entries are projections of PrintHistory rows (the jobs-vs-manual
 * separation documented in docs/api.md) — one merged list would double-show
 * every job:
 *   - "Print jobs": GET /api/print-history rows (label, printer, date,
 *     per-filament breakdown) with delete-with-refund via the existing
 *     DELETE handler.
 *   - "Spool usage ledger": GET /api/spools/usage-search over
 *     spools[].usageHistory — the ONLY surface where a manual entry's
 *     jobLabel can be recalled. Defaults to source=manual (the entries
 *     that exist nowhere else).
 */

interface JobUsageRow {
  /** GH #1074: grams ACTUALLY debited when the job was recorded —
   *  min(spool remaining, grams). The DELETE refund restores THIS, not the
   *  requested grams, so the confirm dialog must sum it (Codex P2 #1184).
   *  Absent on legacy rows predating #1074 (fall back to grams). */
  debitedGrams?: number;
  filamentId: {
    _id: string;
    name: string;
    vendor?: string;
    type?: string;
    color?: string | null;
    /** Populated refs resolve even for trashed filaments — the GET selects
     *  _deletedAt so the UI can render a non-link (Codex P2 #1184). */
    _deletedAt?: string | null;
  } | null;
  spoolId: string | null;
  grams: number;
}

interface PrintJob {
  _id: string;
  jobLabel: string;
  printerId: { _id: string; name: string } | null;
  startedAt: string;
  source: string;
  notes?: string;
  usage: JobUsageRow[];
}

interface LedgerEntry {
  filamentId: string;
  filamentName: string;
  vendor?: string;
  type?: string;
  color?: string | null;
  spoolId: string;
  spoolLabel?: string | null;
  date: string;
  grams: number;
  jobLabel?: string;
  source: string;
}

interface PickerPrinter {
  _id: string;
  name: string;
  /** Present (non-null) when the printer is in the trash — the filter
   *  fetches ?includeTrashed=1 so retained history stays reachable even
   *  when every one of its jobs is older than the fetched window. */
  _deletedAt?: string | null;
}

const JOBS_LIMIT = 200;
const LEDGER_LIMIT = 200;

/** True when the stored value is exactly UTC midnight — the shape a
 *  date-only entry takes (date pickers submit a bare `YYYY-MM-DD`, stored
 *  as `00:00:00.000Z`). Same detection as the filament detail page's usage
 *  disclosure (#941): real "now" timestamps are effectively never exactly
 *  UTC midnight. Rendered as a UTC calendar day, a date-only entry can't
 *  drift to the previous evening west of UTC. */
function isUtcMidnight(value: string): boolean {
  const d = new Date(value);
  return (
    !Number.isNaN(d.getTime()) &&
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

export default function HistoryPage() {
  const { t } = useTranslation();
  const { formatDate, formatDateTime } = useDateFormat();
  const { formatGrams } = useNumberFormat();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [tab, setTab] = useState<"jobs" | "ledger">("jobs");

  // ── Jobs tab state ──────────────────────────────────────────────────
  const [jobs, setJobs] = useState<PrintJob[] | null>(null);
  const [jobsError, setJobsError] = useState(false);
  // Whether the FETCH filled the window — deleting a row locally must not
  // hide the truncation disclosure (Codex P2 #1184): older jobs may exist
  // even though the mutable array now holds fewer than the limit.
  const [jobsTruncated, setJobsTruncated] = useState(false);
  const [printers, setPrinters] = useState<PickerPrinter[]>([]);
  const [printerFilter, setPrinterFilter] = useState("");
  const [jobSearch, setJobSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/printers?includeTrashed=1", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setPrinters)
      .catch(() => {});
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    // No synchronous reset (react-hooks/set-state-in-effect): on a filter
    // change the stale list stays visible until the refetch lands.
    const params = new URLSearchParams({ limit: String(JOBS_LIMIT) });
    if (printerFilter) params.set("printerId", printerFilter);
    fetch(`/api/print-history?${params}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => {
        setJobs(body);
        setJobsTruncated(Array.isArray(body) && body.length >= JOBS_LIMIT);
        setJobsError(false);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setJobsError(true);
      });
    return () => ac.abort();
  }, [printerFilter]);

  // ?includeTrashed=1 carries trashed printers explicitly (Codex #1184
  // r8/r9/r12): their history rows remain queryable, and deriving them from
  // the fetched jobs both raced the lookup and missed printers whose every
  // job is older than the fetched window.
  const printerOptions = useMemo(
    () => printers.map((p) => ({ ...p, trashed: p._deletedAt != null })),
    [printers],
  );

  const visibleJobs = useMemo(() => {
    if (!jobs) return [];
    const q = jobSearch.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) => j.jobLabel.toLowerCase().includes(q));
  }, [jobs, jobSearch]);

  // sumUsageGrams/safeGrams clamp each entry (GH #1030/#1078) — a legacy /
  // snapshot-restored / hybrid-synced row can hold pathological finite values
  // whose raw sum overflows, and formatGrams(Infinity) renders empty.
  const jobGrams = (job: PrintJob): number => sumUsageGrams(job.usage);

  /** What a DELETE would actually restore — debitedGrams where recorded
   *  (a 100 g job against a 50 g spool debited, and refunds, only 50 g).
   *  A row with NO spool deliberately debited nothing (GH #305: all spools
   *  retired → spoolId null, no debitedGrams) and refunds nothing; the
   *  grams fallback applies only to legacy pre-#1074 rows that DID debit
   *  a spool (Codex P2 #1184 r7). */
  const jobRefundableGrams = (job: PrintJob): number =>
    job.usage.reduce(
      (sum, u) => sum + safeGrams(u.debitedGrams ?? (u.spoolId ? u.grams : 0)),
      0,
    );

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDelete = async (job: PrintJob) => {
    const ok = await confirm({
      title: t("history.delete.title"),
      message: t("history.delete.message", {
        label: job.jobLabel,
        grams: formatGrams(jobRefundableGrams(job)),
      }),
      confirmLabel: t("history.delete.confirm"),
    });
    if (!ok) return;
    setDeleting(job._id);
    try {
      const res = await fetch(`/api/print-history/${job._id}`, { method: "DELETE" });
      if (!res.ok) {
        // The 409 concurrent-edit contract says "please retry" — surface the
        // server's own message verbatim rather than a generic failure.
        const body = await res.json().catch(() => null);
        toast(typeof body?.error === "string" ? body.error : t("history.delete.failed"), "error");
        return;
      }
      setJobs((prev) => (prev ? prev.filter((j) => j._id !== job._id) : prev));
      toast(t("history.delete.done"), "success");
    } catch {
      toast(t("history.delete.failed"), "error");
    } finally {
      setDeleting(null);
    }
  };

  // ── Ledger tab state ────────────────────────────────────────────────
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [ledgerError, setLedgerError] = useState(false);
  const [ledgerSearch, setLedgerSearch] = useState("");
  const [ledgerSource, setLedgerSource] = useState("manual");

  useEffect(() => {
    if (tab !== "ledger") return;
    const ac = new AbortController();
    // Debounce keystrokes — the search param compiles a server-side regex.
    const timer = setTimeout(() => {
      setLedger(null);
      setLedgerError(false);
      const params = new URLSearchParams({ limit: String(LEDGER_LIMIT) });
      const q = ledgerSearch.trim().slice(0, 128);
      if (q) params.set("label", q);
      if (ledgerSource) params.set("source", ledgerSource);
      fetch(`/api/spools/usage-search?${params}`, { signal: ac.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((body) => setLedger(body.entries ?? []))
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setLedgerError(true);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [tab, ledgerSearch, ledgerSource]);

  const sourceLabel = (source: string): string => {
    const key = `detail.spool.usageSource.${source}`;
    const translated = t(key);
    return translated === key ? source : translated;
  };

  const inputClass =
    "px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400";
  const tabClass = (active: boolean) =>
    `px-3 py-1.5 text-sm rounded-t border-b-2 ${
      active
        ? "border-blue-600 text-blue-600 dark:text-blue-400 font-medium"
        : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
    }`;

  return (
    <main id="main-content" className="w-full px-4 py-8">
      <h1 className="text-3xl font-bold mb-2">{t("history.title")}</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">{t("history.subtitle")}</p>

      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700 mb-4" role="group" aria-label={t("history.title")}>
        <button type="button" className={tabClass(tab === "jobs")} aria-pressed={tab === "jobs"} onClick={() => setTab("jobs")}>
          {t("history.tab.jobs")}
        </button>
        <button type="button" className={tabClass(tab === "ledger")} aria-pressed={tab === "ledger"} onClick={() => setTab("ledger")}>
          {t("history.tab.ledger")}
        </button>
      </div>

      {tab === "jobs" && (
        <section>
          <div className="flex flex-wrap gap-2 mb-4">
            <input
              type="text"
              value={jobSearch}
              onChange={(e) => setJobSearch(e.target.value)}
              placeholder={t("history.searchJobs")}
              aria-label={t("history.searchJobs")}
              className={`${inputClass} flex-1 min-w-48`}
            />
            <select
              value={printerFilter}
              onChange={(e) => setPrinterFilter(e.target.value)}
              aria-label={t("history.filterPrinter")}
              className={inputClass}
            >
              <option value="">{t("history.allPrinters")}</option>
              {printerOptions.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.trashed ? `${p.name} (${t("history.printerTrashed")})` : p.name}
                </option>
              ))}
            </select>
          </div>

          {jobsError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{t("history.loadFailed")}</p>
          ) : jobs === null ? (
            <p className="text-sm text-gray-500">{t("common.loading")}</p>
          ) : visibleJobs.length === 0 ? (
            <>
              <p className="text-sm text-gray-500">{t("history.jobs.empty")}</p>
              {/* Codex P2 (#1184): the label search runs over the fetched
                  window, so an empty result may just mean the match is
                  OLDER than the newest {limit} jobs — the disclosure must
                  not vanish exactly when it matters most. */}
              {jobsTruncated && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                  {t("history.jobs.limitNote", { limit: JOBS_LIMIT })}
                </p>
              )}
            </>
          ) : (
            <>
              <ul className="text-sm divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded">
                {visibleJobs.map((job) => (
                  <li key={job._id} className="px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(job._id)}
                        className="min-w-0 flex-1 text-left"
                        aria-expanded={expanded.has(job._id)}
                      >
                        <p className="font-medium truncate">
                          <span className="text-gray-400 mr-1">{expanded.has(job._id) ? "▾" : "▸"}</span>
                          {job.jobLabel}
                        </p>
                        <p className="text-xs text-gray-500">
                          {job.printerId?.name ? `${job.printerId.name} · ` : ""}
                          {isUtcMidnight(job.startedAt)
                            ? formatDate(job.startedAt, { timeZone: "UTC" })
                            : formatDateTime(job.startedAt)}
                          {job.source !== "manual" && ` · ${job.source}`}
                        </p>
                      </button>
                      <span className="text-xs text-gray-500 flex-shrink-0">
                        {formatGrams(jobGrams(job))} g
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDelete(job)}
                        disabled={deleting === job._id}
                        className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50 flex-shrink-0"
                      >
                        {t("history.delete.button")}
                      </button>
                    </div>
                    {expanded.has(job._id) && (
                      <div className="mt-2 ml-5 space-y-1">
                        {job.usage.map((u, i) => (
                          <p key={i} className="text-xs text-gray-600 dark:text-gray-300">
                            {u.filamentId && u.filamentId._deletedAt == null ? (
                              <Link
                                href={`/filaments/${u.filamentId._id}${u.spoolId ? `?spool=${u.spoolId}` : ""}`}
                                className="text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                {u.filamentId.name}
                                {u.filamentId.vendor ? ` — ${u.filamentId.vendor}` : ""}
                              </Link>
                            ) : u.filamentId ? (
                              // Trashed: populate still resolves the ref, but the
                              // active-only detail API would 404 — name, no link
                              // (Codex P2 #1184).
                              <span>
                                {u.filamentId.name}
                                {u.filamentId.vendor ? ` — ${u.filamentId.vendor}` : ""}
                                {` (${t("history.filamentTrashed")})`}
                              </span>
                            ) : (
                              <span className="italic">{t("history.filamentGone")}</span>
                            )}
                            {" · "}
                            {formatGrams(safeGrams(u.grams))} g
                          </p>
                        ))}
                        {job.notes && (
                          <p className="text-xs text-gray-500 italic whitespace-pre-wrap">{job.notes}</p>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                {t("history.delete.refundNote")}
                {jobsTruncated && ` ${t("history.jobs.limitNote", { limit: JOBS_LIMIT })}`}
              </p>
            </>
          )}
        </section>
      )}

      {tab === "ledger" && (
        <section>
          <div className="flex flex-wrap gap-2 mb-4">
            <input
              type="text"
              value={ledgerSearch}
              onChange={(e) => setLedgerSearch(e.target.value)}
              placeholder={t("history.searchLedger")}
              aria-label={t("history.searchLedger")}
              maxLength={128}
              className={`${inputClass} flex-1 min-w-48`}
            />
            <select
              value={ledgerSource}
              onChange={(e) => setLedgerSource(e.target.value)}
              aria-label={t("history.filterSource")}
              className={inputClass}
            >
              <option value="manual">{sourceLabel("manual")}</option>
              <option value="job">{sourceLabel("job")}</option>
              <option value="slicer">{sourceLabel("slicer")}</option>
              <option value="nfc">{sourceLabel("nfc")}</option>
              <option value="">{t("history.allSources")}</option>
            </select>
          </div>

          {ledgerError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{t("history.loadFailed")}</p>
          ) : ledger === null ? (
            <p className="text-sm text-gray-500">{t("common.loading")}</p>
          ) : ledger.length === 0 ? (
            <p className="text-sm text-gray-500">{t("history.ledger.empty")}</p>
          ) : (
            <ul className="text-sm divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded">
              {ledger.map((entry, i) => (
                <li key={`${entry.spoolId}-${entry.date}-${i}`} className="px-3 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">
                      {entry.jobLabel || <span className="italic text-gray-400">{t("detail.spool.usageNoLabel")}</span>}
                    </p>
                    <p className="text-xs text-gray-500">
                      <Link
                        href={`/filaments/${entry.filamentId}?spool=${entry.spoolId}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        {entry.filamentName}
                        {entry.vendor ? ` — ${entry.vendor}` : ""}
                      </Link>
                      {entry.spoolLabel ? ` · ${entry.spoolLabel}` : ""}
                      {" · "}
                      {formatDate(entry.date, isUtcMidnight(entry.date) ? { timeZone: "UTC" } : undefined)}
                      {" · "}
                      {sourceLabel(entry.source)}
                    </p>
                  </div>
                  <span className="text-xs text-gray-500 flex-shrink-0">{formatGrams(safeGrams(entry.grams))} g</span>
                </li>
              ))}
            </ul>
          )}
          {ledger !== null && ledger.length >= LEDGER_LIMIT && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              {t("history.ledger.limitNote", { limit: LEDGER_LIMIT })}
            </p>
          )}
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">{t("history.ledger.capNote")}</p>
        </section>
      )}
    </main>
  );
}

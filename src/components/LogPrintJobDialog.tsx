"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useToast } from "@/components/Toast";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import {
  MAX_JOB_LABEL_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_USAGE_ROWS,
  buildPrintJobBody,
  emptyUsageRow,
  validatePrintJobForm,
  type PrintJobFormError,
  type PrintJobFormState,
} from "@/lib/printJobForm";

/**
 * In-app "Log print job" dialog — pure UI over POST /api/print-history:
 * the spool debit, source tagging ("manual" by default), validation, and
 * the legacy-roll migration all live server-side. Validation/body
 * building is the pure, unit-tested src/lib/printJobForm.ts; this
 * component is a thin shell (the OptLinkDialog/OptResyncDialog
 * focus-trap pattern).
 */

interface PickerSpool {
  _id: string;
  label?: string | null;
  instanceId?: string;
  totalWeight: number | null;
  retired?: boolean;
}

interface PickerFilament {
  _id: string;
  name: string;
  vendor: string;
  totalWeight: number | null;
  spools: PickerSpool[];
  hasVariants?: boolean;
}

interface PickerPrinter {
  _id: string;
  name: string;
}

interface Props {
  /** Called after a successful POST so the caller can refetch its list. */
  onLogged: () => void;
  onClose: () => void;
}

/** Local YYYY-MM-DD for <input type="date"> defaults (the filament detail
 *  page's localTodayInput — the picker submits the bare date, stored as UTC
 *  midnight, so analytics day-buckets land on the picked calendar day). */
function localTodayInput(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function errorMessageKey(error: PrintJobFormError): string {
  switch (error.code) {
    case "label_required":
      return "printJob.error.labelRequired";
    case "label_too_long":
      return "printJob.error.labelTooLong";
    case "notes_too_long":
      return "printJob.error.notesTooLong";
    case "date_in_future":
      return "printJob.error.dateInFuture";
    case "no_rows":
      return "printJob.error.noRows";
    case "too_many_rows":
      return "printJob.error.tooManyRows";
    case "row_filament_required":
      return "printJob.error.rowFilament";
    case "row_grams_invalid":
      return "printJob.error.rowGrams";
    case "row_grams_too_large":
      return "printJob.error.rowGramsTooLarge";
  }
}

export default function LogPrintJobDialog({ onLogged, onClose }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatGrams } = useNumberFormat();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filaments, setFilaments] = useState<PickerFilament[]>([]);
  const [printers, setPrinters] = useState<PickerPrinter[]>([]);
  const [form, setForm] = useState<PrintJobFormState>(() => ({
    jobLabel: "",
    printerId: "",
    date: localTodayInput(),
    notes: "",
    usage: [emptyUsageRow()],
  }));
  const [formError, setFormError] = useState<PrintJobFormError | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Mirrors `submitting` for the document-level Escape handler, which is
  // registered once and must read the LIVE value, not a stale closure.
  const submittingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [fRes, pRes] = await Promise.all([
          fetch("/api/filaments"),
          fetch("/api/printers"),
        ]);
        if (cancelled) return;
        if (!fRes.ok || !pRes.ok) {
          setLoadError(true);
        } else {
          const all = (await fRes.json()) as PickerFilament[];
          // Templates hold no inventory (#605) — a job is printed from a
          // variant, so templates stay out of the picker entirely.
          setFilaments(all.filter((f) => !f.hasVariants));
          setPrinters((await pRes.json()) as PickerPrinter[]);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Dismissing while the POST is in flight does NOT abort it — a user who
  // closes on a slow request, reopens, and submits again ends up with TWO
  // jobs debiting inventory. Every dismissal gesture (Escape, backdrop,
  // X, Cancel) funnels through this guard.
  const safeClose = useCallback(() => {
    if (!submittingRef.current) onClose();
  }, [onClose]);

  // Escape to close + Tab focus trap (mirrors OptLinkDialog's mechanics).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        safeClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? focusables.indexOf(active) : -1;
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const next = idx < 0 ? 0 : (idx + dir + focusables.length) % focusables.length;
      focusables[next].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [safeClose]);

  const sortedFilaments = useMemo(
    () => [...filaments].sort((a, b) => a.name.localeCompare(b.name)),
    [filaments],
  );
  const byId = useMemo(
    () => new Map(filaments.map((f) => [f._id, f])),
    [filaments],
  );

  const activeSpools = (f: PickerFilament | undefined): PickerSpool[] =>
    f ? f.spools.filter((s) => !s.retired) : [];

  /** True when logging against this filament cannot debit any inventory:
   *  every spool is retired (GH #305 records the job with no debit), or it
   *  has neither spools nor a legacy top-level weight. A spool-less filament
   *  WITH a totalWeight is fine — the server materializes it as a real spool
   *  and debits it (#1121). */
  const wouldSkipDebit = (f: PickerFilament | undefined): boolean => {
    if (!f) return false;
    if (activeSpools(f).length > 0) return false;
    return !(f.spools.length === 0 && f.totalWeight != null);
  };

  const spoolOptionLabel = (s: PickerSpool): string => {
    const name = s.label || s.instanceId || s._id.slice(-4);
    return s.totalWeight != null ? `${name} (${formatGrams(s.totalWeight)} g)` : name;
  };

  const updateRow = (index: number, patch: Partial<PrintJobFormState["usage"][number]>) => {
    setForm((prev) => ({
      ...prev,
      usage: prev.usage.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  };

  const handleSubmit = async () => {
    setServerError(null);
    // Resolved at SUBMIT time, not mount time — a dialog left open across
    // local midnight must judge "today" (and the today-omission in
    // buildPrintJobBody) against the current day.
    const today = localTodayInput();
    const result = validatePrintJobForm(form, today);
    if (!result.ok) {
      setFormError(result);
      return;
    }
    setFormError(null);
    setSubmitting(true);
    submittingRef.current = true;
    try {
      const res = await fetch("/api/print-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPrintJobBody(form, today)),
      });
      if (!res.ok) {
        // Server messages are English prose (incl. the 409 "please retry"
        // contract) — surface them verbatim rather than collapsing to a
        // generic failure, like the trash page does for the restore 409.
        const body = await res.json().catch(() => null);
        setServerError(
          typeof body?.error === "string" ? body.error : t("printJob.failed"),
        );
        return;
      }
      toast(t("printJob.logged"), "success");
      onLogged();
      onClose();
    } catch {
      setServerError(t("printJob.failed"));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const inputClass =
    "w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400";
  const labelClass = "block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1";

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("printJob.title")}
      onClick={safeClose}
    >
      <div
        ref={dialogRef}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold">{t("printJob.title")}</h2>
          <button
            type="button"
            onClick={safeClose}
            disabled={submitting}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-50"
            aria-label={t("common.close")}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          {loading && <p className="text-sm text-gray-500">{t("common.loading")}</p>}
          {!loading && loadError && (
            <p className="text-sm text-red-500">{t("printJob.loadFailed")}</p>
          )}
          {!loading && !loadError && (
            <div className="space-y-4">
              <div>
                <label htmlFor="print-job-label" className={labelClass}>
                  {t("printJob.jobLabel")}
                </label>
                <input
                  id="print-job-label"
                  type="text"
                  autoFocus
                  maxLength={MAX_JOB_LABEL_LENGTH}
                  className={inputClass}
                  value={form.jobLabel}
                  onChange={(e) => setForm({ ...form, jobLabel: e.target.value })}
                  placeholder={t("printJob.jobLabelPlaceholder")}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="print-job-printer" className={labelClass}>
                    {t("printJob.printer")}
                  </label>
                  <select
                    id="print-job-printer"
                    className={inputClass}
                    value={form.printerId}
                    onChange={(e) => setForm({ ...form, printerId: e.target.value })}
                  >
                    <option value="">{t("printJob.printerNone")}</option>
                    {printers.map((p) => (
                      <option key={p._id} value={p._id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="print-job-date" className={labelClass}>
                    {t("printJob.date")}
                  </label>
                  <input
                    id="print-job-date"
                    type="date"
                    max={localTodayInput()}
                    className={inputClass}
                    value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <p className={labelClass}>{t("printJob.usageHeading")}</p>
                <div className="space-y-3">
                  {form.usage.map((row, i) => {
                    const filament = byId.get(row.filamentId);
                    const spools = activeSpools(filament);
                    return (
                      <div
                        key={i}
                        className="border border-gray-200 dark:border-gray-700 rounded p-3 space-y-2"
                      >
                        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_6rem] gap-2">
                          <select
                            aria-label={t("printJob.filament")}
                            className={inputClass}
                            value={row.filamentId}
                            onChange={(e) =>
                              updateRow(i, { filamentId: e.target.value, spoolId: "" })
                            }
                          >
                            <option value="">{t("printJob.filamentSelect")}</option>
                            {sortedFilaments.map((f) => (
                              <option key={f._id} value={f._id}>
                                {f.vendor ? `${f.name} — ${f.vendor}` : f.name}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label={t("printJob.spool")}
                            className={inputClass}
                            value={row.spoolId}
                            disabled={row.filamentId === "" || spools.length === 0}
                            onChange={(e) => updateRow(i, { spoolId: e.target.value })}
                          >
                            <option value="">{t("printJob.spoolAuto")}</option>
                            {spools.map((s) => (
                              <option key={s._id} value={s._id}>
                                {spoolOptionLabel(s)}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            step="any"
                            min="0"
                            aria-label={t("printJob.grams")}
                            className={inputClass}
                            value={row.grams}
                            onChange={(e) => updateRow(i, { grams: e.target.value })}
                            placeholder={t("printJob.grams")}
                          />
                        </div>
                        {wouldSkipDebit(filament) && (
                          <p className="text-xs text-amber-600 dark:text-amber-400">
                            {t("printJob.noActiveSpool")}
                          </p>
                        )}
                        {form.usage.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setForm((prev) => ({
                                ...prev,
                                usage: prev.usage.filter((_, j) => j !== i),
                              }))
                            }
                            className="text-xs text-red-600 dark:text-red-400 hover:underline"
                          >
                            {t("printJob.removeRow")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {form.usage.length < MAX_USAGE_ROWS && (
                  <button
                    type="button"
                    onClick={() =>
                      setForm((prev) => ({ ...prev, usage: [...prev.usage, emptyUsageRow()] }))
                    }
                    className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {t("printJob.addRow")}
                  </button>
                )}
              </div>

              <div>
                <label htmlFor="print-job-notes" className={labelClass}>
                  {t("printJob.notes")}
                </label>
                <textarea
                  id="print-job-notes"
                  rows={2}
                  maxLength={MAX_NOTES_LENGTH}
                  className={inputClass}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t("printJob.dedupHint")}
              </p>

              {formError && (
                <p className="text-sm text-red-600 dark:text-red-400">
                  {t(errorMessageKey(formError), {
                    row: "rowIndex" in formError ? formError.rowIndex + 1 : 0,
                  })}
                </p>
              )}
              {serverError && (
                <p className="text-sm text-red-600 dark:text-red-400">{serverError}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={safeClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-gray-400 disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || loadError || submitting}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? t("printJob.submitting") : t("printJob.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}

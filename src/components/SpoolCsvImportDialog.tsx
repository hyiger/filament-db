"use client";

import { useState, useRef, useEffect } from "react";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";

interface ImportResult {
  row: number;
  ok: boolean;
  error?: string;
  filament?: string;
}

interface Props {
  onClose: () => void;
  onImported: () => void;
}

const SAMPLE_CSV = `filament,vendor,label,totalWeight,lotNumber,purchaseDate,location
Prusament PLA Galaxy Black,Prusa,Spool 1,1000,LOT-A,2025-01-01,Drybox #1
Bambu PLA Basic,Bambu,,820,,,Garage`;

/**
 * Modal dialog for bulk-importing spools from a pasted or uploaded CSV.
 *
 * Shows a per-row success/failure summary after POST, so users can see which
 * lines matched a filament and which didn't. Intentionally keeps the parsing
 * server-side — the client just forwards the CSV text and renders results.
 */
export default function SpoolCsvImportDialog({ onClose, onImported }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<
    { imported: number; failed: number; results: ImportResult[] } | null
  >(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleFile = async (file: File) => {
    const text = await file.text();
    setCsv(text);
  };

  const handleSubmit = async () => {
    if (!csv.trim()) return;
    setSubmitting(true);
    setResults(null);
    try {
      const res = await fetch("/api/spools/import", {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: csv,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast(body?.error || t("spoolImport.error"), "error");
        return;
      }
      setResults(body);
      if (body.imported > 0) {
        toast(t("spoolImport.success", { imported: body.imported }));
        onImported();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="csv-import-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl max-w-3xl w-full mx-4 max-h-[85vh] flex flex-col"
      >
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 id="csv-import-title" className="text-lg font-semibold">
            {t("spoolImport.title")}
          </h2>
          <p className="text-sm text-gray-500 mt-1">{t("spoolImport.description")}</p>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          <div className="mb-3">
            <h3 className="text-sm font-medium mb-1">{t("spoolImport.columnsHeading")}</h3>
            <p className="text-xs text-gray-500 mb-2">
              {t("spoolImport.columnsDescription")}
            </p>
            <pre className="text-[11px] bg-gray-100 dark:bg-gray-800 rounded px-2 py-1 overflow-x-auto">
{SAMPLE_CSV}
            </pre>
          </div>

          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium">{t("spoolImport.csvLabel")}</label>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400"
              >
                {t("spoolImport.chooseFile")}
              </button>
              <button
                type="button"
                onClick={() => setCsv(SAMPLE_CSV)}
                className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400"
              >
                {t("spoolImport.useSample")}
              </button>
            </div>
          </div>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={10}
            placeholder={SAMPLE_CSV}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-xs font-mono bg-transparent"
          />

          {results && (
            <div className="mt-4">
              <h3 className="text-sm font-medium mb-2">
                {t("spoolImport.resultsHeading", {
                  imported: results.imported,
                  failed: results.failed,
                })}
              </h3>
              <div className="max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded text-xs">
                {results.results.map((r) => (
                  <div
                    key={r.row}
                    className={`px-2 py-1 border-b border-gray-100 dark:border-gray-800 last:border-b-0 flex items-center gap-2 ${
                      r.ok
                        ? "text-green-700 dark:text-green-400"
                        : "text-red-700 dark:text-red-400"
                    }`}
                  >
                    <span className="w-12 font-mono">row {r.row}</span>
                    <span className="flex-1 truncate">
                      {r.ok ? `✓ ${r.filament}` : `✕ ${r.error}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !csv.trim()}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? t("spoolImport.importing") : t("spoolImport.importButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

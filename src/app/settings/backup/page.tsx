"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useConfirm } from "@/components/ConfirmDialog";

export default function BackupSettingsPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ ok: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // GH #1004 F4: in hybrid mode a restore is local-only — the sync engine
  // overwrites the restored docs with the cloud copies on the next cycle,
  // so the backup appears not to "take". Warn before the user acts. Web
  // mode has no sync, so this stays hidden there (no electronAPI).
  const [isHybrid, setIsHybrid] = useState(false);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getConfig) return;
    api
      .getConfig()
      .then((cfg) => setIsHybrid(cfg.connectionMode === "hybrid"))
      .catch(() => {});
  }, []);

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // allow re-selecting the same file
    if (!(await confirm({ message: t("settings.restoreConfirm"), destructive: true, confirmLabel: t("common.restore") }))) return;

    setRestoring(true);
    setRestoreResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/snapshot", { method: "POST", body: formData });
      const data = await res.json();
      if (res.ok) {
        setRestoreResult({
          ok: true,
          message: t("settings.restoreSuccess", { filaments: data.restored.filaments, nozzles: data.restored.nozzles, printers: data.restored.printers }),
        });
      } else {
        setRestoreResult({ ok: false, message: data.error || t("settings.restoreFailed") });
      }
    } catch {
      setRestoreResult({ ok: false, message: t("common.serverError") });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
      <Link href="/settings" className="text-blue-600 hover:underline text-sm">{t("settings.back")}</Link>
      <h1 className="text-3xl font-bold mb-2 mt-2">{t("settings.group.data")}</h1>
      <p className="text-gray-500 text-sm mb-8">{t("settings.group.data.desc")}</p>

      <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-1">{t("settings.snapshots")}</h2>
        <p className="text-sm text-gray-500 mb-4">{t("settings.snapshotsDesc")}</p>

        {isHybrid && (
          <div className="mb-4 flex gap-2 items-start rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
            <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
            </svg>
            <span>{t("settings.backup.hybridWarning")}</span>
          </div>
        )}

        <div className="flex gap-3 items-center flex-wrap">
          <a
            href="/api/snapshot"
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 transition-colors inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            {t("settings.downloadSnapshot")}
          </a>

          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleRestore} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={restoring}
            className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
            </svg>
            {restoring ? t("settings.restoring") : t("settings.restoreFromSnapshot")}
          </button>
        </div>

        {restoreResult && (
          <div className={`mt-3 text-sm px-3 py-2 rounded ${
            restoreResult.ok
              ? "bg-green-50 dark:bg-green-900/50 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800"
              : "bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
          }`}>
            {restoreResult.message}
          </div>
        )}
      </div>
    </main>
  );
}

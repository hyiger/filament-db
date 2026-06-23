"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function DangerSettingsPage() {
  const { t } = useTranslation();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
      <Link href="/settings" className="text-blue-600 hover:underline text-sm">{t("settings.back")}</Link>
      <h1 className="text-3xl font-bold mb-2 mt-2 text-red-600 dark:text-red-400">{t("settings.group.danger")}</h1>
      <p className="text-gray-500 text-sm mb-8">{t("settings.group.danger.desc")}</p>

      <div className="rounded-lg border border-red-200 dark:border-red-900/50 p-5">
        <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-1">{t("settings.dangerZone")}</h2>
        <p className="text-sm text-gray-500 mb-4">{t("settings.dangerZoneDesc")}</p>

        {!showDeleteConfirm ? (
          <button
            onClick={() => { setShowDeleteConfirm(true); setDeleteResult(null); }}
            className="px-4 py-2 bg-red-50 dark:bg-red-900/50 text-red-600 dark:text-red-400 border border-red-300 dark:border-red-800 rounded text-sm hover:bg-red-100 dark:hover:bg-red-900 hover:text-red-700 dark:hover:text-red-300 transition-colors inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
            {t("settings.deleteDatabase")}
          </button>
        ) : (
          <div className="p-4 border border-red-300 dark:border-red-800 rounded-lg bg-red-50 dark:bg-red-950/30">
            <p className="text-sm text-red-700 dark:text-red-300 mb-3">{t("settings.deleteTypeConfirm")}</p>
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={deleteInput}
                onChange={(e) => setDeleteInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setShowDeleteConfirm(false); setDeleteInput(""); }
                }}
                placeholder={t("settings.deleteTypePlaceholder")}
                className="w-40 px-3 py-1.5 border border-red-300 dark:border-red-800 rounded text-sm bg-transparent text-red-700 dark:text-red-200 placeholder-red-300 dark:placeholder-red-800 focus:outline-none focus:border-red-600"
                autoFocus
              />
              <button
                onClick={async () => {
                  setDeleting(true);
                  setDeleteResult(null);
                  try {
                    const res = await fetch("/api/snapshot/delete", { method: "DELETE" });
                    const data = await res.json();
                    if (res.ok) {
                      setDeleteResult({
                        ok: true,
                        message: t("settings.deleteResult", { filaments: data.deleted.filaments, nozzles: data.deleted.nozzles, printers: data.deleted.printers }),
                      });
                    } else {
                      setDeleteResult({ ok: false, message: data.error || t("settings.deleteFailed") });
                    }
                  } catch {
                    setDeleteResult({ ok: false, message: t("common.serverError") });
                  } finally {
                    setDeleting(false);
                    setShowDeleteConfirm(false);
                    setDeleteInput("");
                  }
                }}
                disabled={deleteInput.trim() !== "DELETE" || deleting}
                className="px-4 py-1.5 bg-red-700 text-white rounded text-sm hover:bg-red-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                {deleting ? t("settings.deleting") : t("settings.confirmDelete")}
              </button>
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteInput(""); }}
                className="px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-sm transition-colors"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}

        {deleteResult && (
          <div className={`mt-3 text-sm px-3 py-2 rounded ${
            deleteResult.ok
              ? "bg-green-50 dark:bg-green-900/50 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800"
              : "bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
          }`}>
            {deleteResult.message}
          </div>
        )}
      </div>
    </main>
  );
}

"use client";

import { useTranslation } from "@/i18n/TranslationProvider";

interface Props {
  onCancel: () => void;
  onDiscard: () => void;
}

export default function UnsavedChangesDialog({ onCancel, onDiscard }: Props) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm mx-4">
        <h2 className="text-lg font-semibold mb-2 text-gray-900 dark:text-gray-100">
          {t("edit.unsaved.title")}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {t("edit.unsaved.message")}
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t("edit.unsaved.cancel")}
          </button>
          <button
            onClick={onDiscard}
            className="px-4 py-2 text-sm rounded bg-red-600 text-white hover:bg-red-700"
          >
            {t("edit.unsaved.discard")}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

interface Props {
  onCancel: () => void;
  onDiscard: () => void;
}

export default function UnsavedChangesDialog({ onCancel, onDiscard }: Props) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the cancel button on mount (safer default for destructive dialogs),
  // restore focus to the previously-focused element on unmount, and trap Tab
  // so keyboard users can't escape behind the modal.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === "Tab") {
        // Simple two-element trap — the two action buttons are the only
        // focusable elements inside this dialog.
        const focusables = [cancelRef.current, discardRef.current].filter(
          (el): el is HTMLButtonElement => el !== null,
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [onCancel]);

  // Clicking the backdrop cancels, same as Escape.
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      aria-describedby="unsaved-changes-message"
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm mx-4">
        <h2
          id="unsaved-changes-title"
          className="text-lg font-semibold mb-2 text-gray-900 dark:text-gray-100"
        >
          {t("edit.unsaved.title")}
        </h2>
        <p
          id="unsaved-changes-message"
          className="text-sm text-gray-600 dark:text-gray-400 mb-4"
        >
          {t("edit.unsaved.message")}
        </p>
        <div className="flex justify-end gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t("edit.unsaved.cancel")}
          </button>
          <button
            ref={discardRef}
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

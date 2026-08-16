"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { NTAG_NAME_TO_NDEF_BYTES, type NtagSizeName } from "@/lib/ntagVersion";

/**
 * GH #978 — the NTAG size picker as a shared component, for flows where
 * GET_VERSION cannot size the chip (the ACR1552U rejects the command
 * outright) and the user's pick becomes authoritative. First consumer:
 * Settings → NFC Tools' Erase retry. The filament detail page still carries
 * its own earlier inline copy of this dialog (extracting it is a cosmetic
 * follow-up — this component exists so NEW consumers stop duplicating it).
 *
 * Reuses the detail page's `detail.nfc.ntagSize.*` keys so the two prompts
 * read identically; `body` lets a consumer swap the context line.
 */
export default function NtagSizePromptDialog({
  body,
  onPick,
  onCancel,
}: {
  /** Context line under the title (defaults to the write-flow copy). */
  body?: string;
  onPick: (size: NtagSizeName, remember: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [remember, setRemember] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape-to-cancel at the document level (mirrors the inline original).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-sm rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ntag-size-prompt-title"
        aria-describedby="ntag-size-prompt-body"
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const focusables =
            dialogRef.current?.querySelectorAll<HTMLElement>("button, input");
          if (!focusables || focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            (last as HTMLElement).focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            (first as HTMLElement).focus();
          }
        }}
      >
        <h2
          id="ntag-size-prompt-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t("detail.nfc.ntagSize.title")}
        </h2>
        <p id="ntag-size-prompt-body" className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {body ?? t("detail.nfc.ntagSize.body")}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {(["NTAG213", "NTAG215", "NTAG216"] as NtagSizeName[]).map((size) => (
            <button
              key={size}
              type="button"
              autoFocus={size === "NTAG215"}
              onClick={() => onPick(size, remember)}
              className="flex items-center justify-between rounded-md border border-gray-300 dark:border-gray-600 px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">{size}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {NTAG_NAME_TO_NDEF_BYTES[size]} B
                {size === "NTAG213" ? ` · ${t("detail.nfc.ntagSize.coreOnly")}` : ""}
              </span>
            </button>
          ))}
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          {t("detail.nfc.ntagSize.remember")}
        </label>
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 w-full rounded-md px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          {t("detail.nfc.ntagSize.cancel")}
        </button>
      </div>
    </div>
  );
}

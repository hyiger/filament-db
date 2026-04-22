"use client";

import { useState, useCallback } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

interface Props {
  /** Text that gets written to the clipboard on click. */
  value: string;
  /** Accessible label override. Defaults to "Copy {value}". */
  label?: string;
  /** Tailwind class overrides for the button. */
  className?: string;
}

/**
 * Small icon button that copies `value` to the clipboard and shows a brief
 * "Copied!" confirmation. Renders as an inline element so it can sit next to
 * monospace IDs, hex colors, UIDs, etc. without breaking layout.
 *
 * Uses navigator.clipboard.writeText, which requires a secure context
 * (HTTPS, localhost, or file://). Falls back silently when unavailable
 * rather than throwing, so the button is safe to render everywhere.
 */
export default function CopyButton({ value, label, className = "" }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can reject for permission reasons — fail quietly.
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label ?? t("common.copy", { value }) ?? `Copy ${value}`}
      title={copied ? t("common.copied") : t("common.copy", { value })}
      className={`inline-flex items-center justify-center w-5 h-5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-xs ${className}`}
    >
      {copied ? (
        <span aria-hidden="true">✓</span>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3 h-3"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

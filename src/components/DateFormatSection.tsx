"use client";

import { useMemo } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useDateFormat } from "@/hooks/useDateFormat";
import { type DateFormatMode, isValidPattern } from "@/lib/dateFormatPref";

/** Date-format picker, rendered as a settings card (GH #983). Presets
 *  (System / ISO / US / European) plus a custom token pattern, with a live
 *  preview of today's date and inline validation. Mirrors the Currency /
 *  Theme cards on /settings/ui. */
export default function DateFormatSection() {
  const { t } = useTranslation();
  const { config, setConfig, formatDate } = useDateFormat();

  // The custom-pattern text is derived directly from `config.pattern` (not
  // local state) so it stays correct across the useSyncExternalStore
  // hydration swap — opening /settings/ui with a saved custom format shows
  // the persisted pattern rather than an empty input (Codex P2). Every
  // keystroke already writes through onPatternChange, so config.pattern is
  // always the live value.
  const pattern = config.pattern ?? "";

  // A single "today" instance so the preview doesn't churn every render.
  const sample = useMemo(() => new Date(), []);

  const modes: { code: DateFormatMode; labelKey: string }[] = [
    { code: "system", labelKey: "settings.dateFormat.mode.system" },
    { code: "iso", labelKey: "settings.dateFormat.mode.iso" },
    { code: "us", labelKey: "settings.dateFormat.mode.us" },
    { code: "european", labelKey: "settings.dateFormat.mode.european" },
    { code: "custom", labelKey: "settings.dateFormat.mode.custom" },
  ];

  function selectMode(mode: DateFormatMode) {
    // Preserve any typed custom pattern when switching to a preset so toggling
    // back to Custom doesn't lose it.
    setConfig(pattern ? { mode, pattern } : { mode });
  }

  function onPatternChange(value: string) {
    setConfig({ mode: "custom", pattern: value });
  }

  const customInvalid =
    config.mode === "custom" && pattern !== "" && !isValidPattern(pattern);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-200 mb-1">
        {t("settings.dateFormat")}
      </h2>
      <p className="text-sm text-gray-500 mb-4">{t("settings.dateFormatDesc")}</p>

      <div className="flex flex-wrap gap-2">
        {modes.map((m) => (
          <button
            key={m.code}
            type="button"
            onClick={() => selectMode(m.code)}
            className={`px-4 py-2 text-sm rounded border transition-colors ${
              config.mode === m.code
                ? "border-blue-500 bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-300"
                : "border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-300"
            }`}
          >
            {t(m.labelKey)}
          </button>
        ))}
      </div>

      {config.mode === "custom" && (
        <div className="mt-4">
          <label
            htmlFor="date-format-pattern"
            className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1"
          >
            {t("settings.dateFormat.customLabel")}
          </label>
          <input
            id="date-format-pattern"
            type="text"
            value={pattern}
            onChange={(e) => onPatternChange(e.target.value)}
            placeholder={t("settings.dateFormat.customPlaceholder")}
            maxLength={40}
            className="w-full sm:w-64 px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200 font-mono"
          />
          <p className="mt-1 text-xs text-gray-500">
            {t("settings.dateFormat.customHelp")}
          </p>
          {customInvalid && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {t("settings.dateFormat.invalidPattern")}
            </p>
          )}
        </div>
      )}

      <p className="mt-4 text-sm text-gray-500">
        {t("settings.dateFormat.preview")}:{" "}
        <span className="font-mono text-gray-900 dark:text-gray-200">
          {formatDate(sample)}
        </span>
      </p>
    </div>
  );
}

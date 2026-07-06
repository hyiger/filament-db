"use client";

import { useTranslation } from "@/i18n/TranslationProvider";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { type NumberFormatMode, isValidSeparators } from "@/lib/numberFormatPref";

/** Number-format picker, rendered as a settings card. Presets
 *  (System / US-UK / European / Space) plus a custom separator pair, with a
 *  live preview and inline validation. Mirrors DateFormatSection. */
export default function NumberFormatSection() {
  const { t } = useTranslation();
  const { config, setConfig, formatNumber } = useNumberFormat();

  // Custom separators are derived from config (not local state) so they stay
  // correct across the useSyncExternalStore hydration swap — same fix as the
  // date section. Every keystroke writes through onChange, so config is live.
  const group = config.group ?? "";
  const decimal = config.decimal ?? "";

  const modes: { code: NumberFormatMode; labelKey: string }[] = [
    { code: "system", labelKey: "settings.numberFormat.mode.system" },
    { code: "usuk", labelKey: "settings.numberFormat.mode.usuk" },
    { code: "european", labelKey: "settings.numberFormat.mode.european" },
    { code: "space", labelKey: "settings.numberFormat.mode.space" },
    { code: "none", labelKey: "settings.numberFormat.mode.none" },
    { code: "custom", labelKey: "settings.numberFormat.mode.custom" },
  ];

  function selectMode(mode: NumberFormatMode) {
    // Preserve any typed custom pair when switching to a preset.
    if (group || decimal) setConfig({ mode, group, decimal });
    else setConfig({ mode });
  }

  function setCustom(nextGroup: string, nextDecimal: string) {
    setConfig({ mode: "custom", group: nextGroup, decimal: nextDecimal });
  }

  const customInvalid =
    config.mode === "custom" &&
    group !== "" &&
    decimal !== "" &&
    !isValidSeparators(group, decimal);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-200 mb-1">
        {t("settings.numberFormat")}
      </h2>
      <p className="text-sm text-gray-500 mb-4">{t("settings.numberFormatDesc")}</p>

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
        <div className="mt-4 flex flex-wrap gap-4">
          <div>
            <label
              htmlFor="number-format-group"
              className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1"
            >
              {t("settings.numberFormat.groupLabel")}
            </label>
            <input
              id="number-format-group"
              type="text"
              value={group}
              onChange={(e) => setCustom(e.target.value, decimal)}
              maxLength={1}
              className="w-20 px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200 font-mono text-center"
            />
          </div>
          <div>
            <label
              htmlFor="number-format-decimal"
              className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1"
            >
              {t("settings.numberFormat.decimalLabel")}
            </label>
            <input
              id="number-format-decimal"
              type="text"
              value={decimal}
              onChange={(e) => setCustom(group, e.target.value)}
              maxLength={1}
              className="w-20 px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200 font-mono text-center"
            />
          </div>
        </div>
      )}

      {config.mode === "custom" && (
        <p className="mt-2 text-xs text-gray-500">{t("settings.numberFormat.customHelp")}</p>
      )}
      {customInvalid && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          {t("settings.numberFormat.invalidSeparators")}
        </p>
      )}

      <p className="mt-4 text-sm text-gray-500">
        {t("settings.numberFormat.preview")}:{" "}
        <span className="font-mono text-gray-900 dark:text-gray-200">
          {formatNumber(1245414.45, { maxDecimals: 2 })}
        </span>
      </p>
    </div>
  );
}

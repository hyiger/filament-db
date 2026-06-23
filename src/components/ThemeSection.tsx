"use client";

import { useTranslation } from "@/i18n/TranslationProvider";
import { useTheme, type ThemePreference } from "@/components/ThemeProvider";

/** Light / dark / system theme picker, rendered as a settings card. Extracted
 *  from the Settings page so the /settings/ui sub-page can reuse it (#801). */
export default function ThemeSection() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const options: { code: ThemePreference; labelKey: string }[] = [
    { code: "light", labelKey: "settings.theme.light" },
    { code: "dark", labelKey: "settings.theme.dark" },
    { code: "system", labelKey: "settings.theme.system" },
  ];
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-200 mb-1">
        {t("settings.theme.title")}
      </h2>
      <p className="text-sm text-gray-500 mb-4">{t("settings.theme.desc")}</p>
      <div className="flex gap-2">
        {options.map((opt) => (
          <button
            key={opt.code}
            type="button"
            onClick={() => setPreference(opt.code)}
            className={`px-4 py-2 text-sm rounded border transition-colors ${
              preference === opt.code
                ? "border-blue-500 bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-300"
                : "border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-300"
            }`}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

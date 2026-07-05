"use client";

import Link from "next/link";
import { useState } from "react";
import { CURRENCIES, useCurrency } from "@/hooks/useCurrency";
import type { ValidationError } from "@/lib/customCurrency";
import { useTranslation } from "@/i18n/TranslationProvider";
import { LOCALES } from "@/i18n";
import ThemeSection from "@/components/ThemeSection";
import DateFormatSection from "@/components/DateFormatSection";

export default function UiSettingsPage() {
  const { t, locale, setLocale } = useTranslation();

  // Currency
  const { currency, setCurrency, customCurrencies, addCustom, removeCustom } = useCurrency();
  const [showAddCurrency, setShowAddCurrency] = useState(false);
  const [newCurrCode, setNewCurrCode] = useState("");
  const [newCurrSymbol, setNewCurrSymbol] = useState("");
  const [newCurrName, setNewCurrName] = useState("");
  const [newCurrError, setNewCurrError] = useState<ValidationError | null>(null);

  function currencyValidationMessage(err: ValidationError): string {
    switch (err) {
      case "code-empty": return t("settings.customCurrency.error.codeEmpty");
      case "code-too-short": return t("settings.customCurrency.error.codeTooShort");
      case "code-too-long": return t("settings.customCurrency.error.codeTooLong");
      case "code-invalid-chars": return t("settings.customCurrency.error.codeInvalidChars");
      case "code-collides-builtin": return t("settings.customCurrency.error.codeCollidesBuiltin");
      case "code-duplicate": return t("settings.customCurrency.error.codeDuplicate");
      case "symbol-empty": return t("settings.customCurrency.error.symbolEmpty");
      case "symbol-too-long": return t("settings.customCurrency.error.symbolTooLong");
    }
  }

  function handleAddCustomCurrency() {
    const err = addCustom({ code: newCurrCode, symbol: newCurrSymbol, name: newCurrName });
    if (err) {
      setNewCurrError(err);
      return;
    }
    // `addCustom` auto-selects the new currency; calling setCurrency here too
    // would race React batching and reject the new code (Codex P2 on #142).
    setNewCurrError(null);
    setNewCurrCode("");
    setNewCurrSymbol("");
    setNewCurrName("");
    setShowAddCurrency(false);
  }

  return (
    <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
      <Link href="/settings" className="text-blue-600 hover:underline text-sm">
        {t("settings.back")}
      </Link>
      <h1 className="text-3xl font-bold mb-2 mt-2">{t("settings.group.ui")}</h1>
      <p className="text-gray-500 text-sm mb-8">{t("settings.group.ui.desc")}</p>

      <div className="space-y-4">
        {/* Currency */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-200 mb-1">{t("settings.currency")}</h2>
          <p className="text-sm text-gray-500 mb-4">{t("settings.currencyDesc")}</p>
          <div className="flex flex-wrap gap-2">
            {CURRENCIES.map((c) => (
              <button
                key={c.code}
                type="button"
                onClick={() => setCurrency(c.code)}
                className={`px-4 py-2 text-sm rounded border transition-colors ${
                  currency === c.code
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-300"
                    : "border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-300"
                }`}
                title={c.name}
              >
                {c.symbol} {c.code}
              </button>
            ))}
            {customCurrencies.map((c) => (
              <span
                key={c.code}
                className={`inline-flex items-center text-sm rounded border transition-colors ${
                  currency === c.code
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-300"
                    : "border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500"
                }`}
              >
                <button type="button" onClick={() => setCurrency(c.code)} className="px-3 py-2" title={c.name || c.code}>
                  {c.symbol} {c.code}
                </button>
                <button
                  type="button"
                  onClick={() => removeCustom(c.code)}
                  className="px-2 py-2 border-l border-current opacity-60 hover:opacity-100"
                  aria-label={t("settings.customCurrency.removeAria", { code: c.code })}
                  title={t("settings.customCurrency.remove")}
                >
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setShowAddCurrency((v) => !v)}
              className="px-4 py-2 text-sm rounded border border-dashed border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-300"
            >
              {showAddCurrency ? t("settings.customCurrency.cancel") : t("settings.customCurrency.add")}
            </button>
          </div>

          {showAddCurrency && (
            <div className="mt-4 p-4 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label htmlFor="custom-currency-code" className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                    {t("settings.customCurrency.codeLabel")}
                  </label>
                  <input
                    id="custom-currency-code"
                    type="text"
                    value={newCurrCode}
                    onChange={(e) => { setNewCurrCode(e.target.value); setNewCurrError(null); }}
                    placeholder="SEK"
                    maxLength={6}
                    className="w-full px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200 uppercase"
                  />
                </div>
                <div>
                  <label htmlFor="custom-currency-symbol" className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                    {t("settings.customCurrency.symbolLabel")}
                  </label>
                  <input
                    id="custom-currency-symbol"
                    type="text"
                    value={newCurrSymbol}
                    onChange={(e) => { setNewCurrSymbol(e.target.value); setNewCurrError(null); }}
                    placeholder="kr"
                    maxLength={4}
                    className="w-full px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
                  />
                </div>
                <div>
                  <label htmlFor="custom-currency-name" className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                    {t("settings.customCurrency.nameLabel")}
                  </label>
                  <input
                    id="custom-currency-name"
                    type="text"
                    value={newCurrName}
                    onChange={(e) => setNewCurrName(e.target.value)}
                    placeholder={t("settings.customCurrency.namePlaceholder")}
                    className="w-full px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
                  />
                </div>
              </div>
              {newCurrError && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">{currencyValidationMessage(newCurrError)}</p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={handleAddCustomCurrency}
                  className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white"
                >
                  {t("settings.customCurrency.save")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Theme */}
        <ThemeSection />

        {/* Date format */}
        <DateFormatSection />

        {/* Language */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-200 mb-1">{t("settings.language")}</h2>
          <p className="text-sm text-gray-500 mb-4">{t("settings.languageDesc")}</p>
          <div className="flex gap-2">
            {LOCALES.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => setLocale(l.code)}
                className={`px-4 py-2 text-sm rounded border transition-colors ${
                  locale === l.code
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-300"
                    : "border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-300"
                }`}
              >
                {l.nativeName}
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

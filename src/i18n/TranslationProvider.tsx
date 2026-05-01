"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { Locale } from "./index";
import { DEFAULT_LOCALE, LOCALES } from "./index";
import en from "@filament-db/shared/i18n/locales/en.json";
import de from "@filament-db/shared/i18n/locales/de.json";

type TranslationDict = Record<string, string>;

const dictionaries: Record<Locale, TranslationDict> = {
  en: en as TranslationDict,
  de: de as TranslationDict,
};

interface TranslationContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const TranslationContext = createContext<TranslationContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key: string) => key,
});

const STORAGE_KEY = "filamentdb-locale";

function isValidLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALES.some((l) => l.code === value);
}

function getInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isValidLocale(saved)) {
      return saved;
    }
  } catch {
    // localStorage may not be available
  }
  return DEFAULT_LOCALE;
}

export function TranslationProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);

  // In Electron, electron-store is the source of truth — override localStorage value
  useEffect(() => {
    const api = window.electronAPI;
    if (api?.getConfig) {
      api.getConfig().then((cfg) => {
        const saved = (cfg as Record<string, unknown>).locale;
        if (isValidLocale(saved)) {
          setLocaleState(saved);
        }
      }).catch(() => {});
    }
  }, []);

  // Update document lang attribute when locale changes
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((code: Locale) => {
    setLocaleState(code);
    // Persist to electron-store or localStorage
    const api = window.electronAPI;
    if (api?.saveConfig) {
      api.saveConfig({ locale: code } as Record<string, string>).catch(() => {});
    } else {
      localStorage.setItem(STORAGE_KEY, code);
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let value = dictionaries[locale]?.[key] ?? dictionaries.en?.[key] ?? key;
      if (params) {
        for (const [paramName, paramValue] of Object.entries(params)) {
          value = value.replace(new RegExp(`\\{${paramName}\\}`, "g"), String(paramValue));
        }
      }
      return value;
    },
    [locale],
  );

  return (
    <TranslationContext value={{ locale, setLocale, t }}>
      {children}
    </TranslationContext>
  );
}

export function useTranslation() {
  return useContext(TranslationContext);
}

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Locale } from "@filament-db/shared/i18n";
import { DEFAULT_LOCALE, LOCALES } from "@filament-db/shared/i18n";
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

const STORAGE_KEY = "filamentdb-locale";

const TranslationContext = createContext<TranslationContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key: string) => key,
});

function isValidLocale(value: unknown): value is Locale {
  return LOCALES.some((l) => l.code === value);
}

export function TranslationProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (isValidLocale(stored)) {
        setLocaleState(stored);
      }
    });
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    AsyncStorage.setItem(STORAGE_KEY, l);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let str = dictionaries[locale]?.[key] ?? dictionaries.en[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return str;
    },
    [locale],
  );

  return (
    <TranslationContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </TranslationContext.Provider>
  );
}

export function useTranslation() {
  return useContext(TranslationContext);
}

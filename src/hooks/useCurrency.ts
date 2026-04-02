"use client";

import { useState, useEffect, useCallback } from "react";

export const CURRENCIES = [
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "EUR", symbol: "\u20AC", name: "Euro" },
  { code: "GBP", symbol: "\u00A3", name: "British Pound" },
  { code: "JPY", symbol: "\u00A5", name: "Japanese Yen" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];

const STORAGE_KEY = "filamentdb-currency";
const DEFAULT_CURRENCY: CurrencyCode = "USD";

export function getCurrencySymbol(code: CurrencyCode): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? "$";
}

export function useCurrency() {
  const [currency, setCurrencyState] = useState<CurrencyCode>(DEFAULT_CURRENCY);

  useEffect(() => {
    // Load from electron-store or localStorage
    const api = window.electronAPI;
    if (api?.getConfig) {
      api.getConfig().then((cfg) => {
        const saved = (cfg as Record<string, unknown>).currency as string | undefined;
        if (saved && CURRENCIES.some((c) => c.code === saved)) {
          setCurrencyState(saved as CurrencyCode);
        }
      }).catch(() => {});
    } else {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && CURRENCIES.some((c) => c.code === saved)) {
        setCurrencyState(saved as CurrencyCode);
      }
    }
  }, []);

  const setCurrency = useCallback((code: CurrencyCode) => {
    setCurrencyState(code);
    // Persist to electron-store or localStorage
    const api = window.electronAPI;
    if (api?.saveConfig) {
      api.saveConfig({ currency: code } as Record<string, string>).catch(() => {});
    } else {
      localStorage.setItem(STORAGE_KEY, code);
    }
  }, []);

  const symbol = getCurrencySymbol(currency);

  return { currency, symbol, setCurrency };
}

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  CustomCurrency,
  parseCustomCurrencies,
  serializeCustomCurrencies,
  validateCustomCurrency,
  addCustomCurrency as addCC,
  removeCustomCurrency as removeCC,
  normaliseCode,
  normaliseSymbol,
  type ValidationError,
} from "@/lib/customCurrency";
import { useTranslation } from "@/i18n/TranslationProvider";

/**
 * Built-in currencies. v1.12 expanded the list from 4 to 13 to cover the
 * countries Filament DB users tend to live in (the previous USD/EUR/GBP/JPY
 * was missing the Nordic markets and Switzerland in particular — GH #140).
 * Anything not in this list can be added via the Settings UI's
 * "Add custom currency" form, which writes through `useCurrency.addCustom`.
 */
export const CURRENCIES = [
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen" },
  { code: "SEK", symbol: "kr", name: "Swedish Krona" },
  { code: "NOK", symbol: "kr", name: "Norwegian Krone" },
  { code: "DKK", symbol: "kr", name: "Danish Krone" },
  { code: "CHF", symbol: "Fr", name: "Swiss Franc" },
  { code: "CAD", symbol: "$", name: "Canadian Dollar" },
  { code: "AUD", symbol: "$", name: "Australian Dollar" },
  { code: "CNY", symbol: "¥", name: "Chinese Yuan" },
  { code: "PLN", symbol: "zł", name: "Polish Złoty" },
  { code: "CZK", symbol: "Kč", name: "Czech Koruna" },
] as const;

/**
 * Pre-v1.12.9 this was a const-narrowed union of the four built-in codes.
 * With custom currencies (GH #140) the runtime accepts any string code,
 * so the type is widened to `string` — validators inside the hook keep
 * the value tied to a known list (built-in or custom).
 */
export type CurrencyCode = string;

const STORAGE_KEY = "filamentdb-currency";
const CUSTOM_STORAGE_KEY = "filamentdb-custom-currencies";
const DEFAULT_CURRENCY = "USD";

const BUILTIN_CODES: string[] = CURRENCIES.map((c) => c.code);

/** Build a {code → symbol} lookup over both built-ins and the custom list. */
function buildSymbolMap(custom: CustomCurrency[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of CURRENCIES) m.set(c.code, c.symbol);
  for (const c of custom) m.set(c.code, c.symbol);
  return m;
}

export function getCurrencySymbol(code: string, custom?: CustomCurrency[]): string {
  if (custom) {
    const m = buildSymbolMap(custom);
    return m.get(code) ?? "$";
  }
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? "$";
}

function isKnownCode(code: string, custom: CustomCurrency[]): boolean {
  return BUILTIN_CODES.includes(code) || custom.some((c) => c.code === code);
}

function readStoredCustom(): CustomCurrency[] {
  if (typeof window === "undefined") return [];
  try {
    return parseCustomCurrencies(localStorage.getItem(CUSTOM_STORAGE_KEY), BUILTIN_CODES);
  } catch {
    return [];
  }
}

function readStoredCurrency(custom: CustomCurrency[]): string {
  if (typeof window === "undefined") return DEFAULT_CURRENCY;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && isKnownCode(saved, custom)) return saved;
  } catch {
    // localStorage may not be available
  }
  return DEFAULT_CURRENCY;
}

/**
 * useCurrency — current selection plus the user's custom-currency list.
 *
 * Persistence:
 *   - Selected code:   electron-store key "currency"            / localStorage "filamentdb-currency"
 *   - Custom list:     electron-store key "customCurrencies"    / localStorage "filamentdb-custom-currencies"
 * Electron is the source of truth for the desktop app; the localStorage
 * values seed web-mode users via the post-mount sync effect below.
 */
export function useCurrency() {
  // GH #821: default the Intl locale to the app's chosen language so currency
  // grouping/decimals follow it (the GH #447 intent), matching the locale-aware
  // dateFormat. Callers can still pass an explicit override to format().
  const { locale } = useTranslation();
  const [customCurrencies, setCustomCurrenciesState] = useState<CustomCurrency[]>([]);
  const [currency, setCurrencyState] = useState<string>(DEFAULT_CURRENCY);

  // GH #639: seed from localStorage on mount instead of in the useState
  // initializers. Those run during hydration, so a stored non-default
  // currency made the client's first render disagree with the SSR HTML
  // (USD) — a React 19 hydration mismatch + full client re-render on
  // every page load for a non-default web user. Same pattern as
  // CollapsibleSection / TranslationProvider: default during SSR, one
  // post-hydration sync render. The electron-store hydration effect below
  // resolves asynchronously after this, so on desktop it still wins.
  useEffect(() => {
    const custom = readStoredCustom();
    const saved = readStoredCurrency(custom);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post-hydration sync from localStorage
    if (custom.length > 0) setCustomCurrenciesState(custom);
    if (saved !== DEFAULT_CURRENCY) setCurrencyState(saved);
  }, []);

  // Hydrate from electron-store when running inside the desktop shell. The
  // localStorage values are still useful for SSR / web-mode users.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getConfig) return;
    api
      .getConfig()
      .then((cfg) => {
        const c = cfg as Record<string, unknown>;

        // Resolve the authoritative custom list for this hydration:
        //   - Electron-store has the key (typeof === "string"): apply it
        //     verbatim, INCLUDING the empty array. Otherwise a desktop
        //     user who cleared their list could see localStorage-cached
        //     entries resurrect on next launch (Codex P2 follow-up to
        //     PR #142).
        //   - Key absent (undefined): leave the localStorage-initialised
        //     state alone — first run on desktop after web use survives.
        let resolvedList: CustomCurrency[] | null = null;
        if (typeof c.customCurrencies === "string") {
          resolvedList = parseCustomCurrencies(c.customCurrencies, BUILTIN_CODES);
          setCustomCurrenciesState(resolvedList);
        }

        const saved = typeof c.currency === "string" ? c.currency : "";
        if (saved) {
          // Validate against the just-resolved list so an electron-side
          // entry that still exists in `c.customCurrencies` is accepted
          // even on the first render after mount. When electron didn't
          // override (resolvedList === null), fall back to a fresh
          // localStorage read — NOT the closure's `customCurrencies`,
          // which is always the first-render `[]` since GH #639 moved
          // the localStorage seed out of the useState initializer.
          const validateAgainst = resolvedList ?? readStoredCustom();
          if (isKnownCode(saved, validateAgainst)) {
            setCurrencyState(saved);
          }
        }
      })
      .catch(() => {});
  }, []);

  const persistCurrency = useCallback((code: string) => {
    const api = window.electronAPI;
    if (api?.saveConfig) {
      api.saveConfig({ currency: code } as Record<string, string>).catch(() => {});
    } else {
      try {
        localStorage.setItem(STORAGE_KEY, code);
      } catch {
        // ignore — quota / disabled storage
      }
    }
  }, []);

  const persistCustom = useCallback((list: CustomCurrency[]) => {
    const json = serializeCustomCurrencies(list);
    const api = window.electronAPI;
    if (api?.saveConfig) {
      api.saveConfig({ customCurrencies: json } as Record<string, string>).catch(() => {});
    } else {
      try {
        localStorage.setItem(CUSTOM_STORAGE_KEY, json);
      } catch {
        // ignore
      }
    }
  }, []);

  const setCurrency = useCallback(
    (code: string) => {
      // Validate against known list at the boundary; silent reject keeps
      // bad inputs from poisoning persisted state.
      if (!isKnownCode(code, customCurrencies)) return;
      setCurrencyState(code);
      persistCurrency(code);
    },
    [customCurrencies, persistCurrency],
  );

  const addCustom = useCallback(
    (input: { code: string; symbol: string; name?: string }): ValidationError | null => {
      const entry: CustomCurrency = {
        code: normaliseCode(input.code),
        symbol: normaliseSymbol(input.symbol),
        name: (input.name ?? "").trim(),
      };
      const err = validateCustomCurrency(entry, BUILTIN_CODES, customCurrencies);
      if (err) return err;
      const next = addCC(customCurrencies, entry);
      setCustomCurrenciesState(next);
      persistCustom(next);
      // Auto-select the just-added code. Doing it here closes the
      // closure-stale-state hole: a separate setCurrency() call from the
      // caller would validate against the pre-add `customCurrencies`
      // captured in setCurrency's useCallback memo, and reject the new
      // code (Codex P2 follow-up to PR #142). Since the ergonomic flow
      // is "user adds a currency to use", autoselect is also the right
      // default behaviour.
      setCurrencyState(entry.code);
      persistCurrency(entry.code);
      return null;
    },
    [customCurrencies, persistCurrency, persistCustom],
  );

  const removeCustom = useCallback(
    (code: string) => {
      const target = normaliseCode(code);
      // If the user is currently using this currency, drop selection back
      // to USD so we never end up in an unselectable-state.
      const next = removeCC(customCurrencies, target);
      setCustomCurrenciesState(next);
      persistCustom(next);
      if (currency === target) {
        setCurrencyState(DEFAULT_CURRENCY);
        persistCurrency(DEFAULT_CURRENCY);
      }
    },
    [currency, customCurrencies, persistCurrency, persistCustom],
  );

  const symbol = getCurrencySymbol(currency, customCurrencies);

  /**
   * GH #447 — format a numeric value as currency using Intl.NumberFormat
   * where the code is an ISO 4217 built-in (USD, EUR, GBP, etc.) so
   * screen-readers hear "12 US dollars" rather than "dollar 12" and
   * thousands grouping respects the locale. Custom user-added currency
   * codes fall back to the legacy `${symbol}${value}` shape because
   * Intl.NumberFormat rejects unknown codes.
   *
   * Defensive try/catch: a future Node/Chromium that drops support for
   * a code, or a malformed numeric input, just falls back to the raw
   * shape rather than throwing into the render.
   */
  const format = useCallback(
    (value: number, localeOverride?: string): string => {
      // Default to the app's i18n locale; an explicit arg still wins. (#821)
      const effectiveLocale = localeOverride ?? locale ?? undefined;
      const isBuiltin = CURRENCIES.some((c) => c.code === currency);
      if (isBuiltin) {
        try {
          return new Intl.NumberFormat(effectiveLocale, {
            style: "currency",
            currency,
          }).format(value);
        } catch {
          // fall through
        }
      }
      // Custom-currency fallback: match the legacy `${symbol}${toFixed(2)}`
      // shape so a user who selected a custom code doesn't suddenly see
      // raw decimals (e.g. `¤12.5` for 12.5 or `¤1.234567` for an
      // analytics total). Codex flagged this on PR #470 — the round-1
      // migration of cost render sites would have left custom-currency
      // users with unformatted amounts. Locale-aware Intl is reserved
      // for the built-in ISO 4217 codes above.
      return `${symbol}${value.toFixed(2)}`;
    },
    [currency, symbol, locale],
  );

  return {
    currency,
    symbol,
    format,
    setCurrency,
    customCurrencies,
    addCustom,
    removeCustom,
  };
}

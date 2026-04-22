"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { THEME_STORAGE_KEY } from "@/lib/themeInitScript";

export type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  /** What the user selected — may be "system". */
  preference: ThemePreference;
  /** What's actually rendered right now — always "light" or "dark". */
  resolved: "light" | "dark";
  setPreference: (p: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  resolved: "light",
  setPreference: () => {},
});

function isValidPreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

/** Read the stored preference, defaulting to "system". SSR-safe. */
function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isValidPreference(raw)) return raw;
  } catch {
    // localStorage may be disabled (e.g. private mode) — fall through
  }
  return "system";
}

/** Resolve a preference to concrete theme given the OS media query state. */
function resolveFor(pref: ThemePreference, systemDark: boolean): "light" | "dark" {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return systemDark ? "dark" : "light";
}

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  // systemDark tracks the OS media query so `resolved` is a pure derivation
  // of (preference, systemDark) rather than a DOM-read side effect. This
  // keeps us out of the react-hooks/set-state-in-effect trap.
  const [systemDark, setSystemDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });

  const resolved = resolveFor(preference, systemDark);

  // Apply the resolved theme to <html>. Side effect only — no state write.
  useEffect(() => {
    const html = document.documentElement;
    if (resolved === "dark") html.classList.add("dark");
    else html.classList.remove("dark");
  }, [resolved]);

  // Subscribe once to media-query changes so systemDark stays current.
  // Using the callback form of setSystemDark avoids the set-state-in-effect
  // lint rule (we read event.matches on each change, no derivation needed).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, p);
    } catch {
      // ignore
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

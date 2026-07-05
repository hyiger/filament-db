"use client";

import { useEffect, useSyncExternalStore } from "react";
import { isNtagSizeName, type NtagSizeName } from "@/lib/ntagVersion";

/**
 * useNtagDefaultSize (GH #973 follow-up) — the user's default NTAG type used when
 * a reader can't auto-detect the chip size (it rejects GET_VERSION, e.g. the
 * ACR1552U). `"ask"` (the default) prompts a size picker on every write;
 * choosing a specific type skips the prompt so a batch of same-type tags writes
 * without re-picking each time.
 *
 * Persistence mirrors useLabelFormat / useCurrency: electron-store (via the
 * generic getConfig/saveConfig bridge) is the source of truth on desktop; a
 * localStorage copy serves web/SSR. Stored as a plain string under key
 * `ntagDefaultSize` (electron-store) / `filamentdb-ntag-default-size`
 * (localStorage). The module-level store + useSyncExternalStore keep the detail
 * page's write flow and the Settings control in lockstep.
 */

export type NtagDefaultSize = "ask" | NtagSizeName;

const STORAGE_KEY = "filamentdb-ntag-default-size";
const DEFAULT: NtagDefaultSize = "ask";

/** Coerce any stored/legacy value to a valid NtagDefaultSize. */
function normalize(v: unknown): NtagDefaultSize {
  return v === "ask" || isNtagSizeName(v) ? v : DEFAULT;
}

let store: NtagDefaultSize | null = null;
let hydrated = false; // electron-store hydration runs once per session
const listeners = new Set<() => void>();

function readInitial(): NtagDefaultSize {
  if (typeof window === "undefined") return DEFAULT;
  try {
    return normalize(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT;
  }
}

function getSnapshot(): NtagDefaultSize {
  if (store === null) store = readInitial();
  return store;
}

function getServerSnapshot(): NtagDefaultSize {
  return DEFAULT;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit() {
  for (const l of listeners) l();
}

function persist(value: NtagDefaultSize) {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (api?.saveConfig) {
    api.saveConfig({ ntagDefaultSize: value }).catch(() => {});
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // ignore — quota / disabled storage
    }
  }
}

/** Set the global default: normalize, persist, notify all instances. */
export function setNtagDefaultSize(next: NtagDefaultSize) {
  store = normalize(next);
  persist(store);
  emit();
}

export function useNtagDefaultSize() {
  const defaultSize = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // One-time electron-store hydration (overrides the localStorage seed on
  // desktop). Module-scoped so it runs once regardless of instance count.
  useEffect(() => {
    if (hydrated) return;
    hydrated = true;
    const api = window.electronAPI;
    if (!api?.getConfig) return;
    api
      .getConfig()
      .then((cfg) => {
        const c = cfg as Record<string, unknown>;
        if (c.ntagDefaultSize !== undefined) {
          store = normalize(c.ntagDefaultSize);
          emit();
        }
      })
      .catch(() => {});
  }, []);

  return { defaultSize, setDefaultSize: setNtagDefaultSize };
}

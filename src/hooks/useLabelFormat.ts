"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LabelFormat,
  DEFAULT_LABEL_FORMAT,
  normalizeLabelFormat,
} from "@/lib/labelFormat";

/**
 * useLabelFormat — the global label-formatting config (GH #592).
 *
 * Persistence mirrors useCurrency: electron-store (via the generic
 * getConfig/saveConfig bridge) is the source of truth on desktop; a
 * localStorage copy serves SSR / web-mode users (the web `.bin` download
 * path honors the format too). Stored as a JSON string under key
 * `labelFormat` (electron-store) / `filamentdb-label-format` (localStorage).
 */

const STORAGE_KEY = "filamentdb-label-format";

function readInitial(): LabelFormat {
  if (typeof window === "undefined") return DEFAULT_LABEL_FORMAT;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeLabelFormat(JSON.parse(saved));
  } catch {
    // localStorage unavailable / corrupt JSON → default
  }
  return DEFAULT_LABEL_FORMAT;
}

export function useLabelFormat() {
  const [format, setFormatState] = useState<LabelFormat>(readInitial);

  // Hydrate from electron-store on desktop (overrides the localStorage seed).
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getConfig) return;
    api
      .getConfig()
      .then((cfg) => {
        const c = cfg as Record<string, unknown>;
        if (typeof c.labelFormat === "string") {
          try {
            setFormatState(normalizeLabelFormat(JSON.parse(c.labelFormat)));
          } catch {
            /* corrupt stored value → keep current */
          }
        }
      })
      .catch(() => {});
    // Mount-only hydration.
  }, []);

  const setFormat = useCallback((next: LabelFormat) => {
    const norm = normalizeLabelFormat(next);
    setFormatState(norm);
    const json = JSON.stringify(norm);
    const api = window.electronAPI;
    if (api?.saveConfig) {
      api.saveConfig({ labelFormat: json } as Record<string, string>).catch(() => {});
    } else {
      try {
        localStorage.setItem(STORAGE_KEY, json);
      } catch {
        // ignore — quota / disabled storage
      }
    }
  }, []);

  return { format, setFormat };
}

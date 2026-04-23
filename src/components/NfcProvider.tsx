"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useNfc, type NfcStatus } from "@/hooks/useNfc";
import type { DecodedOpenPrintTag } from "@/lib/openprinttag-decode";

interface FilamentMatch {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
}

export interface NfcTagReadResult {
  data?: DecodedOpenPrintTag;
  error?: string;
  empty?: boolean;
  match?: FilamentMatch | null;
  candidates?: FilamentMatch[];
}

interface NfcContextValue {
  isElectron: boolean;
  status: NfcStatus;
  writing: boolean;
  writeError: string | null;
  writeTag: (payload: Uint8Array, productUrl?: string) => Promise<void>;
  tagReadResult: NfcTagReadResult | null;
  dismissTagRead: () => void;
}

const NfcContext = createContext<NfcContextValue | null>(null);

export function useNfcContext(): NfcContextValue {
  const ctx = useContext(NfcContext);
  if (!ctx) {
    // Return a safe default for non-Electron / outside provider
    return {
      isElectron: false,
      status: { readerConnected: false, readerName: null, tagPresent: false, tagUid: null },
      writing: false,
      writeError: null,
      writeTag: async () => {},
      tagReadResult: null,
      dismissTagRead: () => {},
    };
  }
  return ctx;
}

export default function NfcProvider({ children }: { children: ReactNode }) {
  const { isElectron, status, writing, error: writeError, writeTag } = useNfc();
  const [tagReadResult, setTagReadResult] = useState<NfcTagReadResult | null>(null);

  // Listen for auto-read events from the main process
  useEffect(() => {
    if (!isElectron) return;
    const api = window.electronAPI!;
    const unsub = api.onNfcTagRead(async (raw: unknown) => {
      const event = raw as { data?: DecodedOpenPrintTag; error?: string; empty?: boolean };
      if (event.error) {
        setTagReadResult({ error: event.error });
        return;
      }

      if (event.empty) {
        setTagReadResult({ empty: true });
        return;
      }

      if (!event.data) return;

      // Try to match against existing filaments
      const params = new URLSearchParams();
      if (event.data.materialName) params.set("name", event.data.materialName);
      if (event.data.brandName) params.set("vendor", event.data.brandName);
      if (event.data.materialType) params.set("type", event.data.materialType);

      try {
        const res = await fetch(`/api/filaments/match?${params}`);
        if (!res.ok) {
          // Non-2xx: show the tag data without match info, but don't try
          // to parse the body as if it's a match result — a 5xx error body
          // parses as {error: "..."} which would leave match/candidates
          // as undefined and render nothing useful.
          setTagReadResult({ data: event.data, match: null, candidates: [] });
          return;
        }
        const parsed = await res.json();
        const match = parsed?.match ?? null;
        const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
        setTagReadResult({ data: event.data, match, candidates });
      } catch {
        // Network failure — still show tag data so the user can act on it
        setTagReadResult({ data: event.data, match: null, candidates: [] });
      }
    });
    return unsub;
  }, [isElectron]);

  const dismissTagRead = useCallback(() => setTagReadResult(null), []);

  return (
    <NfcContext.Provider
      value={{
        isElectron,
        status,
        writing,
        writeError,
        writeTag,
        tagReadResult,
        dismissTagRead,
      }}
    >
      {children}
    </NfcContext.Provider>
  );
}

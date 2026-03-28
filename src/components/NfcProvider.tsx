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
  match?: FilamentMatch | null;
  candidates?: FilamentMatch[];
}

interface NfcContextValue {
  isElectron: boolean;
  status: NfcStatus;
  writing: boolean;
  writeError: string | null;
  writeTag: (payload: Uint8Array) => Promise<void>;
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
    const api = (window as any).electronAPI;
    const unsub = api.onNfcTagRead(async (event: { data?: DecodedOpenPrintTag; error?: string }) => {
      if (event.error) {
        setTagReadResult({ error: event.error });
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
        const { match, candidates } = await res.json();
        setTagReadResult({ data: event.data, match, candidates });
      } catch {
        // Show tag data even if matching fails
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

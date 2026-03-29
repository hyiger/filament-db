"use client";

import { useState, useEffect, useCallback } from "react";

export interface NfcStatus {
  readerConnected: boolean;
  readerName: string | null;
  tagPresent: boolean;
  tagUid: string | null;
}

const DEFAULT_STATUS: NfcStatus = {
  readerConnected: false,
  readerName: null,
  tagPresent: false,
  tagUid: null,
};

export function useNfc() {
  const [isElectron] = useState(
    () =>
      typeof window !== "undefined" &&
      !!window.electronAPI?.nfcGetStatus,
  );
  const [status, setStatus] = useState<NfcStatus>(DEFAULT_STATUS);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectron) return;

    const api = window.electronAPI!;

    // Get initial status
    api.nfcGetStatus().then(setStatus).catch(() => {});

    // Subscribe to status changes
    const unsubStatus = api.onNfcStatusChange((s: NfcStatus) => {
      setStatus(s);
    });

    return () => {
      unsubStatus();
    };
  }, [isElectron]);

  const readTag = useCallback(async () => {
    if (!isElectron) throw new Error("NFC only available in Electron");
    setError(null);
    try {
      return await window.electronAPI!.nfcReadTag();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    }
  }, [isElectron]);

  const writeTag = useCallback(
    async (payload: Uint8Array) => {
      if (!isElectron) throw new Error("NFC only available in Electron");
      setError(null);
      setWriting(true);
      try {
        await window.electronAPI!.nfcWriteTag(Array.from(payload));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err;
      } finally {
        setWriting(false);
      }
    },
    [isElectron],
  );

  return { isElectron, status, writing, error, readTag, writeTag };
}

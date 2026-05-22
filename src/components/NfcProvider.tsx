"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useNfc, type NfcStatus } from "@/hooks/useNfc";
import type { DecodedOpenPrintTag } from "@/lib/openprinttag-decode";
import {
  createScanMatchHandler,
  type FilamentMatch,
  type NfcTagReadResult,
} from "@/lib/scanMatchHandler";

export type { NfcTagReadResult } from "@/lib/scanMatchHandler";

interface NfcContextValue {
  isElectron: boolean;
  status: NfcStatus;
  writing: boolean;
  writeError: string | null;
  writeTag: (payload: Uint8Array, productUrl?: string) => Promise<void>;
  /**
   * Last decoded scan result. Survives dialog dismissal so the dialog's
   * action buttons (View Filament / Create New / candidate suggestions)
   * remain usable after the user closes the modal — that's where the
   * decoded tag data lives. Note that this is intentionally NOT cleared
   * on tag removal; the dialog should stay actionable even after the
   * user lifts the tag. The status pill's display name lives in
   * `loadedTagName` instead, which DOES clear on lift so it doesn't
   * report a stale filament after the tag is gone (codex P2 on
   * PR #235).
   */
  tagReadResult: NfcTagReadResult | null;
  /**
   * Display name for the status pill: the matched filament's name, or
   * the tag's declared material name if no match. Cleared the moment
   * the reader reports no tag present, so a brief "Tag detected (uid)"
   * window appears while the next tag is decoding rather than showing
   * the previous tag's name.
   */
  loadedTagName: string | null;
  /** Whether the read-result dialog is currently visible. */
  dialogOpen: boolean;
  /** Hide the dialog without clearing `tagReadResult`. */
  dismissTagRead: () => void;
  /**
   * Call this from the write button on the filament detail page after
   * `writeTag` resolves successfully. Updates the pill to reflect the
   * filament that's now physically on the tag, without having to lift
   * and replace it to trigger a fresh read.
   */
  notifyTagWritten: (filament: FilamentMatch) => void;
  /**
   * Call this after a successful Erase Tag. The tag is now blank, so the
   * status pill's "Loaded: <name>" label and the lingering read result
   * must clear immediately rather than waiting for the user to lift the
   * (now-erased) tag off the reader.
   */
  notifyTagErased: () => void;
}

const NfcContext = createContext<NfcContextValue | null>(null);

/**
 * Fire-and-forget POST to /api/scan/publish so SSE subscribers (the
 * PrusaSlicer / OrcaSlicer FilamentDB module) can react to the scan.
 * Failure is intentionally silent — the user-visible tag dialog must not
 * wait on this, and any error here is logged for diagnostics only.
 */
function publishScan(
  decoded: DecodedOpenPrintTag,
  match: FilamentMatch | null,
  candidates: FilamentMatch[],
): void {
  const body = {
    filament: match,
    candidates,
    decoded: {
      materialName: decoded.materialName,
      brandName: decoded.brandName,
      materialType: decoded.materialType,
      color: decoded.color,
      spoolUid: decoded.spoolUid,
      tagSource: decoded.tagSource,
    },
  };
  void fetch("/api/scan/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => {
    console.warn("[nfc] scan publish failed", err);
  });
}

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
      loadedTagName: null,
      dialogOpen: false,
      dismissTagRead: () => {},
      notifyTagWritten: () => {},
      notifyTagErased: () => {},
    };
  }
  return ctx;
}

function pickLoadedName(result: NfcTagReadResult): string | null {
  // Prefer the matched DB filament's name (what the user thinks of as
  // "what's loaded"), then fall back to the tag's declared material
  // name for unmatched-but-decoded tags.
  return result.match?.name ?? result.data?.materialName ?? null;
}

export default function NfcProvider({ children }: { children: ReactNode }) {
  const { isElectron, status, writing, error: writeError, writeTag } = useNfc();
  const [tagReadResult, setTagReadResult] = useState<NfcTagReadResult | null>(null);
  // The dialog and the "current scan" state used to be one flag —
  // dismissing the dialog cleared tagReadResult and the status pill
  // lost its "Loaded: <name>" label. Decouple them: tagReadResult
  // stays put after dismissal so the dialog's action buttons remain
  // usable; dialogOpen controls the modal independently.
  const [dialogOpen, setDialogOpen] = useState(false);
  // Pill display name, kept separate from tagReadResult so the pill
  // can clear immediately when the reader reports no tag present —
  // codex P2 on PR #235 flagged that an A→B swap would leave the pill
  // showing "Loaded: <A>" until B's decode landed because the dialog's
  // tagReadResult lingered intentionally past dismiss. The dialog
  // doesn't suffer from the same bug because the gate is
  // `dialogOpen && tagReadResult` — only a fresh scan re-opens it.
  const [loadedTagName, setLoadedTagName] = useState<string | null>(null);

  // Clear the pill name as soon as the tag is lifted. We do NOT clear
  // tagReadResult here on purpose — the dialog may still be open and
  // the user may still want to act on its buttons.
  useEffect(() => {
    if (!status.tagPresent) setLoadedTagName(null); // eslint-disable-line react-hooks/set-state-in-effect -- pill-clear in response to external reader state
  }, [status.tagPresent]);

  // Listen for auto-read events from the main process. Match-and-publish
  // sequencing (cancel-stale-fetch + ignore-stale-commit) lives in
  // createScanMatchHandler so the race-prone async path is unit-testable
  // and rapid back-to-back scans can't have the older match clobber the
  // newer one.
  useEffect(() => {
    if (!isElectron) return;
    const api = window.electronAPI!;
    const handler = createScanMatchHandler({
      onResult: (result) => {
        setTagReadResult(result);
        setLoadedTagName(pickLoadedName(result));
        setDialogOpen(true);
      },
      onPublish: publishScan,
    });
    const unsub = api.onNfcTagRead(handler);
    return unsub;
  }, [isElectron]);

  const dismissTagRead = useCallback(() => setDialogOpen(false), []);

  // Called by the filament detail page after a successful Write NFC.
  // Synthesises a `tagReadResult` that mirrors what a fresh read would
  // produce, so the pill flips to "Loaded: <name>" right away rather
  // than waiting for the user to lift + replace the tag.
  const notifyTagWritten = useCallback((filament: FilamentMatch) => {
    setTagReadResult({ match: filament, candidates: [] });
    setLoadedTagName(filament.name);
    // Intentionally not opening the dialog — the user just clicked
    // "Write NFC" on the filament detail page; popping a modal on top
    // of that workflow would be jarring. The pill update is enough.
  }, []);

  // Called by Settings → Erase Tag after a successful erase. The tag is
  // now blank, so clear the pill label and the stale read result rather
  // than reporting the just-erased filament until the user lifts the tag.
  const notifyTagErased = useCallback(() => {
    setLoadedTagName(null);
    setTagReadResult(null);
    setDialogOpen(false);
  }, []);

  return (
    <NfcContext.Provider
      value={{
        isElectron,
        status,
        writing,
        writeError,
        writeTag,
        tagReadResult,
        loadedTagName,
        dialogOpen,
        dismissTagRead,
        notifyTagWritten,
        notifyTagErased,
      }}
    >
      {children}
    </NfcContext.Provider>
  );
}

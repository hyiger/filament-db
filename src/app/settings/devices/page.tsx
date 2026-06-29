"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useIsElectron } from "@/hooks/useIsElectron";
import { useNfcContext } from "@/components/NfcProvider";
import LabelPrinterSettings from "@/components/LabelPrinterSettings";
import LabelFormatEditor from "@/components/LabelFormatEditor";

export default function DevicesSettingsPage() {
  const { t } = useTranslation();
  const isElectron = useIsElectron();
  const { notifyTagErased } = useNfcContext();

  const [nfcStatus, setNfcStatus] = useState<{
    readerConnected: boolean;
    readerName: string | null;
    tagPresent: boolean;
    tagUid: string | null;
  }>({ readerConnected: false, readerName: null, tagPresent: false, tagUid: null });
  const [formatting, setFormatting] = useState(false);
  const [formatResult, setFormatResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showFormatConfirm, setShowFormatConfirm] = useState(false);
  const [settingReadOnly, setSettingReadOnly] = useState(false);
  // #864 OpenTag3D write: the chip + standard of the tag currently on the reader,
  // probed via nfcDetectTag on tag-present so the user knows what they're acting on.
  const [detected, setDetected] = useState<{
    family: "ntag" | "slix2" | "bambu" | "unknown";
    standard: "opentag3d" | "openprinttag" | "bambu" | null;
    formatted: boolean;
    readOnly: boolean;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const api = window.electronAPI;
    if (!api?.nfcGetStatus) return;
    api.nfcGetStatus().then((s) => {
      if (!controller.signal.aborted) setNfcStatus(s);
    }).catch(() => {});
    const unsub = api.onNfcStatusChange(setNfcStatus);
    return () => { controller.abort(); unsub(); };
  }, []);

  // #864: probe the loaded tag whenever one is present (and clear when lifted).
  // Best-effort — a detect failure just leaves the line hidden.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.nfcDetectTag) return;
    if (!nfcStatus.tagPresent) {
      setDetected(null); // eslint-disable-line react-hooks/set-state-in-effect -- clear in response to external reader state
      return;
    }
    let cancelled = false;
    api.nfcDetectTag()
      .then((d) => { if (!cancelled) setDetected(d); })
      .catch(() => { if (!cancelled) setDetected(null); });
    return () => { cancelled = true; };
  }, [nfcStatus.tagPresent, nfcStatus.tagUid]);

  // Re-probe the loaded tag after an action that CHANGES it (erase / read-only
  // toggle). Those mutate the tag in place without a tagPresent/tagUid change, so
  // the detect effect above wouldn't re-run and the card would keep the pre-action
  // label until the user lifts + replaces the tag (Codex P3 #927).
  const refreshDetected = useCallback(() => {
    const api = window.electronAPI;
    if (!api?.nfcDetectTag) return;
    api.nfcDetectTag().then(setDetected).catch(() => setDetected(null));
  }, []);

  // Map a detection result to a human label, reusing the read-dialog provenance
  // wording vocabulary (#864).
  const detectedLabel = (() => {
    if (!detected) return null;
    if (detected.family === "bambu") return t("settings.nfcLoadedBambu");
    if (detected.family === "ntag") {
      if (detected.standard === "opentag3d") return t("settings.nfcLoadedNtagOpenTag3d");
      // Codex P3 #927: a formatted-but-not-OpenTag3D NTAG (foreign URL/contact
      // NDEF) is distinct from a blank one — don't label it "OpenTag3D".
      return detected.formatted
        ? t("settings.nfcLoadedNtagForeign")
        : t("settings.nfcLoadedNtagBlank");
    }
    if (detected.family === "slix2") {
      if (detected.standard === "openprinttag") return t("settings.nfcLoadedSlix2OpenPrintTag");
      if (detected.standard === "opentag3d") return t("settings.nfcLoadedSlix2OpenTag3d");
      // Codex P3 #927: a formatted-but-not-OpenPrintTag SLIX2 (foreign NDEF) is
      // distinct from a blank one — don't label it "OpenPrintTag".
      return detected.formatted
        ? t("settings.nfcLoadedSlix2Foreign")
        : t("settings.nfcLoadedSlix2Blank");
    }
    return t("settings.nfcLoadedUnknown");
  })();

  const showFormatConfirmVisible = showFormatConfirm && nfcStatus.tagPresent;

  const handleFormat = async () => {
    setShowFormatConfirm(false);
    setFormatting(true);
    setFormatResult(null);
    try {
      if (!window.electronAPI?.nfcFormatTag) {
        throw new Error("NFC format not available — restart the app to load updated NFC support");
      }
      await window.electronAPI.nfcFormatTag();
      notifyTagErased();
      setFormatResult({ ok: true, message: t("settings.nfcEraseSuccess") });
      refreshDetected(); // tag is now blank — update the loaded-tag label (#927)
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      let message = raw;
      if (raw.includes("BAMBU_READ_ONLY")) message = t("settings.nfcEraseBambuReadOnly");
      else if (raw.includes("NTAG_SIZE_UNKNOWN")) message = t("settings.nfcNtagSizeUnknown");
      setFormatResult({ ok: false, message });
    } finally {
      setFormatting(false);
    }
  };

  const handleSetReadOnly = async (readOnly: boolean) => {
    setSettingReadOnly(true);
    setFormatResult(null);
    try {
      if (!window.electronAPI?.nfcSetReadOnly) {
        throw new Error("NFC read-only not available — restart the app to load updated NFC support");
      }
      await window.electronAPI.nfcSetReadOnly(readOnly);
      setFormatResult({ ok: true, message: t(readOnly ? "settings.nfcReadOnlySet" : "settings.nfcWritableSet") });
      refreshDetected(); // read-only state changed — refresh the lock badge (#927)
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      let message = raw;
      if (raw.includes("BAMBU_READ_ONLY")) message = t("settings.nfcReadOnlyBambu");
      else if (raw.includes("TAG_NOT_FORMATTED")) message = t("settings.nfcReadOnlyNotFormatted");
      else if (raw.includes("NTAG_READONLY_UNSUPPORTED")) message = t("settings.nfcReadOnlyNtagUnsupported");
      setFormatResult({ ok: false, message });
    } finally {
      setSettingReadOnly(false);
    }
  };

  return (
    <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
      <Link href="/settings" className="text-blue-600 hover:underline text-sm">{t("settings.back")}</Link>
      <h1 className="text-3xl font-bold mb-2 mt-2">{t("settings.group.devices")}</h1>
      <p className="text-gray-500 text-sm mb-8">{t("settings.group.devices.desc")}</p>

      <div className="space-y-4">
        {/* NFC Tools (Electron only) */}
        {isElectron && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-1">{t("settings.nfcTools")}</h2>
            <p className="text-sm text-gray-500 mb-4">{t("settings.nfcToolsDesc")}</p>

            {/* #864: which chip + standard is on the reader right now. */}
            {nfcStatus.tagPresent && detectedLabel && (
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                <span className="text-gray-400 dark:text-gray-500">{t("settings.nfcLoadedTag")}</span>{" "}
                <span className="font-medium">{detectedLabel}</span>
              </p>
            )}

            {!showFormatConfirmVisible ? (
              <button
                onClick={() => { setShowFormatConfirm(true); setFormatResult(null); }}
                disabled={formatting || !nfcStatus.tagPresent}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75 14.25 12m0 0 2.25 2.25M14.25 12l2.25-2.25M14.25 12 12 14.25m-2.58 4.92-6.374-6.375a1.125 1.125 0 0 1 0-1.59L9.42 4.83a1.125 1.125 0 0 1 1.59 0l6.375 6.375a1.125 1.125 0 0 1 0 1.59l-6.375 6.375a1.125 1.125 0 0 1-1.59 0Z" />
                </svg>
                {t("settings.eraseTag")}
              </button>
            ) : (
              <div className="p-4 border border-yellow-300 dark:border-yellow-800 rounded-lg bg-yellow-50 dark:bg-yellow-950/30">
                <p className="text-sm text-yellow-800 dark:text-yellow-300 mb-3">{t("settings.eraseConfirm")}</p>
                <div className="flex gap-2 items-center">
                  <button
                    onClick={handleFormat}
                    disabled={formatting}
                    className="px-4 py-1.5 bg-yellow-700 text-white rounded text-sm hover:bg-yellow-600 disabled:opacity-50 transition-colors"
                  >
                    {formatting ? t("settings.erasing") : t("settings.confirmErase")}
                  </button>
                  <button
                    onClick={() => setShowFormatConfirm(false)}
                    className="px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-sm transition-colors"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => handleSetReadOnly(true)}
                disabled={settingReadOnly || formatting || !nfcStatus.tagPresent || detected?.family === "ntag"}
                className="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
                {settingReadOnly ? t("settings.nfcReadOnlyWorking") : t("settings.nfcSetReadOnly")}
              </button>
              <button
                onClick={() => handleSetReadOnly(false)}
                disabled={settingReadOnly || formatting || !nfcStatus.tagPresent || detected?.family === "ntag"}
                className="px-3 py-1.5 text-gray-600 dark:text-gray-300 rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
                {t("settings.nfcMakeWritable")}
              </button>
            </div>
            {nfcStatus.tagPresent && detected?.family === "ntag" && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t("settings.nfcReadOnlyNtagUnsupported")}
              </p>
            )}
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">{t("settings.nfcReadOnlyHint")}</p>

            {formatResult && (
              <div className={`mt-3 text-sm px-3 py-2 rounded ${
                formatResult.ok
                  ? "bg-green-50 dark:bg-green-900/50 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800"
                  : "bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
              }`}>
                {formatResult.message}
              </div>
            )}
          </div>
        )}

        {/* Brother PT-P710BT label printer — LabelPrinterSettings renders null in
            web, so gate the card to avoid an empty box. */}
        {isElectron && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
            <LabelPrinterSettings />
          </div>
        )}
        {/* Label format — applies to the web .bin-download path too (#592), never gated. */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
          <LabelFormatEditor />
        </div>
      </div>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useToast } from "@/components/Toast";
import { useIsElectron } from "@/hooks/useIsElectron";
import type { LabelPrinterDevice } from "@/types/electron";
import { renderLabelBitmap } from "@/lib/labelBitmap";
import { encodeLabel, packGrayscaleBitmap } from "@/lib/labelEncoder";
import { useLabelFormat } from "@/hooks/useLabelFormat";
import { SAMPLE_FILAMENT } from "@/lib/labelFormat";

/**
 * Settings panel for the Brother PT-P710BT label printer. Electron
 * only — the picker calls into the main process's print transport
 * (the OS print system), which has no browser counterpart. (GH #588)
 *
 * Flow:
 *   1. User connects the printer via USB. On the desktop the PT-P710BT
 *      is a USB printer-class device (its Bluetooth is mobile-only).
 *   2. This panel lists the printers the OS print system can reach
 *      (CUPS queues + available usb:// devices on macOS/Linux; installed
 *      printers on Windows), badging the ones that look like a PT printer.
 *   3. User picks one; we persist the print target in electron-store via
 *      IPC. The PrintLabelDialog reads it before every print.
 *   4. "Test print" sends a small known-good label so the user verifies
 *      the connection + tape feed before the real workflow.
 *
 * Renders nothing in web mode (the hook returns false) so this can
 * sit unconditionally in the settings page.
 */

export default function LabelPrinterSettings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isElectron = useIsElectron();
  const { format } = useLabelFormat();

  type State =
    | { status: "loading" }
    | {
        status: "ready";
        devices: LabelPrinterDevice[];
        selectedPath: string | null;
      }
    | { status: "error"; message: string };
  const [state, setState] = useState<State>({ status: "loading" });
  const [testing, setTesting] = useState(false);

  // Public base URL for URL-mode label QR payloads (Codex P2 on
  // PR #487). Loaded on mount, persisted on blur with main-process
  // validation. Empty string in the input means "not configured".
  const [publicUrlDraft, setPublicUrlDraft] = useState<string>("");
  const [publicUrlSavedAs, setPublicUrlSavedAs] = useState<string | null>(null);

  // Memoised loader so the Refresh button can reuse it without
  // duplicating the IPC dance.
  const loadDevices = useCallback(async () => {
    if (!window.electronAPI?.labelPrinterListDevices) {
      setState({
        status: "error",
        message: "electronAPI.labelPrinterListDevices unavailable",
      });
      return;
    }
    setState({ status: "loading" });
    try {
      const [devices, selectedPath] = await Promise.all([
        window.electronAPI.labelPrinterListDevices(),
        window.electronAPI.labelPrinterGetDevicePath?.() ?? Promise.resolve(null),
      ]);
      setState({ status: "ready", devices, selectedPath });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    // Data-fetching effect, same pattern as the project's other
    // settings-loaders (src/app/nozzles/page.tsx etc.); the rule fires
    // on the indirect setState inside loadDevices.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDevices();
    // Public URL: load once alongside device list. Stored alongside
    // because both surface in the same Settings panel.
    if (window.electronAPI?.labelPrinterGetPublicUrl) {
      window.electronAPI
        .labelPrinterGetPublicUrl()
        .then((url) => {
          // setState inside an async then callback isn't flagged by
          // the rule (only sync-in-effect-body is).
          setPublicUrlDraft(url ?? "");
          setPublicUrlSavedAs(url);
        })
        .catch(() => {
          /* silent — stays blank, no harm */
        });
    }
  }, [isElectron, loadDevices]);

  const handleSavePublicUrl = useCallback(async () => {
    if (!window.electronAPI?.labelPrinterSetPublicUrl) return;
    const trimmed = publicUrlDraft.trim();
    try {
      await window.electronAPI.labelPrinterSetPublicUrl(trimmed === "" ? null : trimmed);
      const saved = trimmed === "" ? null : trimmed.replace(/\/+$/, "");
      setPublicUrlSavedAs(saved);
      setPublicUrlDraft(saved ?? "");
      toast(
        trimmed === ""
          ? t("settings.labelPrinter.publicUrl.cleared")
          : t("settings.labelPrinter.publicUrl.saved"),
        "success",
      );
    } catch (err) {
      // Main-process validation surfaces here (bad scheme, loopback
      // host, malformed URL). Show the message inline so the user can
      // fix and retry without losing what they typed.
      toast(
        t("settings.labelPrinter.publicUrl.saveFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        "error",
      );
    }
  }, [publicUrlDraft, t, toast]);

  const handlePick = useCallback(
    async (path: string) => {
      if (!window.electronAPI?.labelPrinterSetDevicePath) return;
      try {
        await window.electronAPI.labelPrinterSetDevicePath(path);
        toast(t("settings.labelPrinter.deviceSaved"), "success");
        setState((s) =>
          s.status === "ready" ? { ...s, selectedPath: path } : s,
        );
      } catch (err) {
        toast(
          t("settings.labelPrinter.deviceSaveFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
          "error",
        );
      }
    },
    [t, toast],
  );

  const handleClear = useCallback(async () => {
    if (!window.electronAPI?.labelPrinterSetDevicePath) return;
    try {
      await window.electronAPI.labelPrinterSetDevicePath(null);
      toast(t("settings.labelPrinter.deviceCleared"), "success");
      setState((s) => (s.status === "ready" ? { ...s, selectedPath: null } : s));
    } catch (err) {
      toast(
        t("settings.labelPrinter.deviceSaveFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        "error",
      );
    }
  }, [t, toast]);

  const handleTestPrint = useCallback(async () => {
    if (!window.electronAPI?.labelPrinterPrint) return;
    setTesting(true);
    try {
      // A canonical label using the SAMPLE filament + the user's saved
      // format, so the test print exercises their actual layout (QR + text +
      // cutter) without wasting much tape.
      const { grayscale, rasterLines } = await renderLabelBitmap({
        filament: SAMPLE_FILAMENT,
        qrPayload: "filament-db-test",
        format,
      });
      const packed = packGrayscaleBitmap(grayscale, rasterLines);
      const bytes = encodeLabel({
        bitmap: packed,
        rasterLines,
        tapeWidthMm: 24,
      });
      await window.electronAPI.labelPrinterPrint(Array.from(bytes));
      toast(t("settings.labelPrinter.testSuccess"), "success");
    } catch (err) {
      toast(
        t("settings.labelPrinter.testFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        "error",
      );
    } finally {
      setTesting(false);
    }
  }, [t, toast, format]);

  if (!isElectron) return null;

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-200 mb-1">
        {t("settings.labelPrinter")}
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
        {t("settings.labelPrinter.desc")}
      </p>

      {state.status === "loading" ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("settings.labelPrinter.scanning")}
        </p>
      ) : state.status === "error" ? (
        <div className="border border-red-300 dark:border-red-700 rounded p-3 bg-red-50 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-300">
            {t("settings.labelPrinter.scanError", { error: state.message })}
          </p>
          <button
            type="button"
            onClick={loadDevices}
            className="mt-2 text-sm text-red-700 dark:text-red-300 underline"
          >
            {t("settings.labelPrinter.retry")}
          </button>
        </div>
      ) : state.devices.length === 0 ? (
        <div className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-gray-50 dark:bg-gray-800">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t("settings.labelPrinter.noDevices")}
          </p>
          <button
            type="button"
            onClick={loadDevices}
            className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            {t("settings.labelPrinter.refresh")}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {state.devices.map((d) => {
            const selected = state.selectedPath === d.path;
            return (
              <label
                key={d.path}
                className={`flex items-start gap-2 p-3 border rounded cursor-pointer ${
                  selected
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                    : "border-gray-200 dark:border-gray-700"
                }`}
              >
                <input
                  type="radio"
                  name="labelPrinterDevice"
                  checked={selected}
                  onChange={() => handlePick(d.path)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {d.friendlyName}
                    {d.looksLikePrinter && (
                      <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded">
                        {t("settings.labelPrinter.looksLikePrinter")}
                      </span>
                    )}
                  </p>
                  <code className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                    {d.path}
                  </code>
                  {d.bidiEnabled && (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      {t("settings.labelPrinter.bidiWarning")}
                    </p>
                  )}
                </div>
              </label>
            );
          })}
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="button"
              onClick={loadDevices}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {t("settings.labelPrinter.refresh")}
            </button>
            <button
              type="button"
              onClick={handleTestPrint}
              disabled={!state.selectedPath || testing}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {testing
                ? t("settings.labelPrinter.testing")
                : t("settings.labelPrinter.testPrint")}
            </button>
            {state.selectedPath && (
              <button
                type="button"
                onClick={handleClear}
                className="px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:underline"
              >
                {t("settings.labelPrinter.clear")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Public base URL for URL-mode QR codes. Without this the
          packaged Electron app would encode http://localhost:<port>
          into the QR — unscannable from any other device. (Codex P2
          on PR #487.) */}
      <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
        <label htmlFor="label-printer-public-url" className="block text-sm font-medium text-gray-900 dark:text-gray-100">
          {t("settings.labelPrinter.publicUrl")}
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-2">
          {t("settings.labelPrinter.publicUrl.desc")}
        </p>
        <div className="flex gap-2">
          <input
            id="label-printer-public-url"
            type="url"
            inputMode="url"
            placeholder="https://filament-db.local"
            value={publicUrlDraft}
            onChange={(e) => setPublicUrlDraft(e.target.value)}
            className="flex-1 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={handleSavePublicUrl}
            disabled={publicUrlDraft.trim() === (publicUrlSavedAs ?? "")}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("settings.labelPrinter.publicUrl.save")}
          </button>
        </div>
        {publicUrlSavedAs && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            {t("settings.labelPrinter.publicUrl.current", { url: publicUrlSavedAs })}
          </p>
        )}
      </div>
    </section>
  );
}

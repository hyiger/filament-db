"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useToast } from "@/components/Toast";
import { useIsElectron } from "@/hooks/useIsElectron";
import type { LabelPrinterDevice } from "@/types/electron";
import { render, DPI_203 } from "@/lib/tsplEncoder";
import PrinterDevicePicker from "@/components/PrinterDevicePicker";

/**
 * Settings panel for the KNAON Y813BT dry-box label printer (TSPL). The
 * sibling of LabelPrinterSettings (Brother) — a SECOND, independent device
 * selection, because the two printers never print the same thing:
 * Brother/24mm tape/spool labels, KNAON/4x6 stock/dry-box labels.
 *
 * Device listing is shared with the Brother picker (labelPrinterListDevices
 * is printer-agnostic); only the persisted selection differs
 * (tsplPrinterGetDevicePath / tsplPrinterSetDevicePath → its own
 * electron-store key and its own managed CUPS queue).
 *
 * GH #771 applies here identically: the mount-time list is passive (lpstat,
 * prompt-free); "Scan for USB printers" runs lpinfo, which on macOS pops the
 * admin-password dialog — so it only happens on an explicit click.
 */

/** Badges KNAON Y813BT devices in the picker. Client-side on purpose: the
 *  transport's PRINTER_PATTERN is Brother-only, because ITS consumer saves
 *  the selection for Brother raster jobs — badging a KNAON there would
 *  invite printing raster bytes at a TSPL printer. */
const TSPL_PRINTER_PATTERN = /knaon|y-?813/i;

export default function TsplPrinterSettings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isElectron = useIsElectron();

  type State =
    | { status: "loading" }
    | { status: "ready"; devices: LabelPrinterDevice[]; selectedPath: string | null }
    | { status: "error"; message: string };
  const [state, setState] = useState<State>({ status: "loading" });
  const [testing, setTesting] = useState(false);

  const loadDevices = useCallback(async (probeUsb = false) => {
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
        window.electronAPI.labelPrinterListDevices(probeUsb),
        window.electronAPI.tsplPrinterGetDevicePath?.() ?? Promise.resolve(null),
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
    // Data-fetching effect — the shared settings-loader pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDevices();
  }, [isElectron, loadDevices]);

  const handlePick = useCallback(
    async (path: string | null) => {
      if (!window.electronAPI?.tsplPrinterSetDevicePath) return;
      try {
        await window.electronAPI.tsplPrinterSetDevicePath(path);
        setState((prev) =>
          prev.status === "ready" ? { ...prev, selectedPath: path } : prev,
        );
      } catch (err) {
        toast(
          t("settings.tsplPrinter.saveFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
          "error",
        );
      }
    },
    [t, toast],
  );

  /**
   * Test print: a minimal known-good TSPL job straight through the real
   * pipeline (render → IPC → OS print system). Feeds one 4x6 label with a
   * heading, so the user verifies device selection + stock feed before the
   * first real dry-box label. ASCII-only content — the Y813BT truncates a
   * TEXT literal at any byte >= 0x80 (hardware-verified), and the emitter
   * would fold anything else anyway.
   */
  const handleTestPrint = useCallback(async () => {
    if (!window.electronAPI?.tsplPrinterPrint) return;
    setTesting(true);
    try {
      const bytes = render({
        spec: {
          widthMm: 100,
          heightMm: 150,
          gapMm: 3,
          gapOffsetMm: 0,
          density: 8,
          speed: 4,
          reference: { x: 0, y: 0 },
          dpi: DPI_203,
        },
        commands: [
          { kind: "box", x0: 16, y0: 16, x1: 780, y1: 180, thickness: 5 },
          { kind: "text", x: 40, y: 50, font: "5", rotation: 0, xScale: 1, yScale: 1, content: "FILAMENT DB" },
          { kind: "text", x: 40, y: 120, font: "3", rotation: 0, xScale: 1, yScale: 1, content: "TSPL test print OK" },
          { kind: "barcode", x: 60, y: 240, symbology: "128", height: 60, humanReadable: 1, rotation: 0, narrow: 2, wide: 2, content: "TSPL-TEST" },
        ],
      });
      await window.electronAPI.tsplPrinterPrint(Array.from(bytes));
      toast(t("settings.tsplPrinter.testSuccess"), "success");
    } catch (err) {
      toast(
        t("settings.tsplPrinter.testFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        "error",
      );
    } finally {
      setTesting(false);
    }
  }, [t, toast]);

  if (!isElectron) return null;

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-200 mb-1">
        {t("settings.tsplPrinter")}
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
        {t("settings.tsplPrinter.desc")}
      </p>

      {state.status === "loading" ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("settings.tsplPrinter.scanning")}
        </p>
      ) : state.status === "error" ? (
        <div className="border border-red-300 dark:border-red-700 rounded p-3 bg-red-50 dark:bg-red-950/40">
          <p className="text-sm text-red-700 dark:text-red-300">
            {t("settings.tsplPrinter.scanError", { error: state.message })}
          </p>
          <button
            type="button"
            onClick={() => loadDevices(false)}
            className="mt-2 text-sm text-red-700 dark:text-red-300 underline"
          >
            {t("settings.tsplPrinter.retry")}
          </button>
        </div>
      ) : (
        <>
          {/* A selection whose device has vanished (unplugged, queue removed)
              would otherwise be invisible AND unclearable — no radio matches
              it, and with no devices left the picker isn't rendered at all.
              Prints would go to the dead target until a device reappears. */}
          {state.selectedPath &&
            !state.devices.some((d) => d.path === state.selectedPath) && (
              <div className="mb-2 border border-amber-300 dark:border-amber-700 rounded p-3 bg-amber-50 dark:bg-amber-950/40">
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  {t("settings.printerPicker.stale")}
                </p>
                <code className="text-xs text-amber-700 dark:text-amber-400 font-mono block mt-0.5">
                  {state.selectedPath}
                </code>
                <button
                  type="button"
                  onClick={() => handlePick(null)}
                  className="mt-1.5 text-sm text-amber-800 dark:text-amber-300 underline"
                >
                  {t("settings.printerPicker.clear")}
                </button>
              </div>
            )}
          {state.devices.length === 0 ? (
        <div className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-gray-50 dark:bg-gray-800">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t("settings.tsplPrinter.noDevices")}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t("settings.tsplPrinter.scanHint")}
          </p>
          <button
            type="button"
            onClick={() => loadDevices(true)}
            className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            {t("settings.tsplPrinter.scanUsb")}
          </button>
        </div>
          ) : (
        <div className="space-y-2">
          <PrinterDevicePicker
            devices={state.devices}
            selectedPath={state.selectedPath}
            radioName="tsplPrinterDevice"
            onPick={handlePick}
            isBadged={(d) => TSPL_PRINTER_PATTERN.test(`${d.friendlyName} ${d.path}`)}
            badgeLabel={t("settings.tsplPrinter.badge")}
          />
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="button"
              onClick={() => loadDevices(false)}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {t("settings.tsplPrinter.refresh")}
            </button>
            <button
              type="button"
              onClick={() => loadDevices(true)}
              title={t("settings.tsplPrinter.scanHint")}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {t("settings.tsplPrinter.scanUsb")}
            </button>
            <button
              type="button"
              onClick={handleTestPrint}
              disabled={testing || !state.selectedPath}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testing
                ? t("settings.tsplPrinter.testing")
                : t("settings.tsplPrinter.testPrint")}
            </button>
          </div>
        </div>
          )}
        </>
      )}
    </section>
  );
}

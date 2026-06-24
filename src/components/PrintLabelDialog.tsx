"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useToast } from "@/components/Toast";
import { useIsElectron } from "@/hooks/useIsElectron";
import {
  renderLabelBitmap,
  renderLabelPreviewDataUrl,
} from "@/lib/labelBitmap";
import { encodeLabel, packGrayscaleBitmap } from "@/lib/labelEncoder";
import { isLoopbackUrl } from "@/lib/loopbackHost";
import { useLabelFormat } from "@/hooks/useLabelFormat";
import { composeLabelLines, type LabelFilament } from "@/lib/labelFormat";
import { buildFilamentDeepLink } from "@/lib/labelDeepLink";

/**
 * Print-label dialog for the filament detail page.
 *
 * Two QR payload modes the user can pick between per print:
 *   - "instanceId" — the 5-byte hex spool / filament identifier.
 *     Tiny payload (≤ 16 chars), produces a compact dense QR.
 *   - "url" — a deep link to the filament's detail page on the user's
 *     own instance. ~55 chars; needs a larger QR.
 *
 * The choice persists in localStorage so the same mode is the default
 * next time the user opens the dialog.
 *
 * Print delivery:
 *   - **Web (no Electron)**: downloads the encoded .bin file. Useful
 *     for "I want to inspect what would be sent" + a forward-compat
 *     escape hatch for non-Electron deployments.
 *   - **Electron**: sends the bytes over IPC to the print transport in the
 *     main process (electron/label-printer.ts), which hands them to the OS
 *     print system over USB (CUPS `lp -o raw` / Windows spooler). (GH #588)
 *
 * The label layout (QR placement, text fields, font, orientation, invert)
 * comes from the global LabelFormat (Settings → Label format); this dialog
 * only chooses the QR *payload* (instanceId vs URL). (GH #592)
 */

const LAST_QR_MODE_KEY = "filamentdb.printLabel.qrMode";

type QrMode = "instanceId" | "url";

export interface PrintLabelDialogProps {
  open: boolean;
  onClose: () => void;
  filament: {
    _id: string;
    name: string;
    instanceId?: string | null;
    // GH #592: fields the configurable label layout can display.
    vendor?: string | null;
    type?: string | null;
    colorName?: string | null;
    // GH #595: the filament's spools, so a multi-spool filament can deep-link
    // the URL-mode QR to a specific spool. #732: `instanceId` lets the
    // instance-ID QR mode encode the SELECTED spool's id (not the filament's).
    spools?: Array<{ _id: string; label?: string | null; instanceId?: string | null; retired?: boolean | null }>;
  };
}

export default function PrintLabelDialog({
  open,
  onClose,
  filament,
}: PrintLabelDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isElectron = useIsElectron();
  const { format } = useLabelFormat();

  // The subset of fields the configurable label layout can render.
  const labelFilament: LabelFilament = useMemo(
    () => ({
      name: filament.name,
      vendor: filament.vendor,
      type: filament.type,
      colorName: filament.colorName,
    }),
    [filament.name, filament.vendor, filament.type, filament.colorName],
  );

  // GH #595: which spool the URL-mode QR deep-links to. `spoolChoice` is the
  // *raw* control state: null = no explicit choice yet (fall back to the first
  // spool), "" = the user explicitly picked "filament only", otherwise a spool
  // id. Deriving the default from the live `spools` (rather than a once-run
  // initializer) keeps the single-spool case linked even when the spool is
  // added after the dialog mounts, and self-heals a stale/removed id — Codex P2.
  const spools = useMemo(() => filament.spools ?? [], [filament.spools]);
  const [spoolChoice, setSpoolChoice] = useState<string | null>(null);
  const effectiveSpoolId = useMemo(() => {
    if (spoolChoice === "") return null; // explicit "filament only"
    if (spoolChoice && spools.some((s) => s._id === spoolChoice)) return spoolChoice;
    // #732: default to the first NON-retired spool, mirroring
    // selectSpoolForWrite so the label QR's no-interaction default targets the
    // SAME spool as the .bin route and the detail-page NFC writers (a filament
    // whose first spool is retired must not default-encode the retired one).
    const def = spools.find((s) => !s.retired) ?? spools[0];
    return def?._id ?? null;
  }, [spoolChoice, spools]);

  // #732: the id the instance-ID QR encodes — the SELECTED spool's instanceId
  // when a spool is chosen, else the filament-level id ("filament only" / a
  // spool-less filament). Mirrors selectSpoolForWrite's intent on the client.
  const effectiveInstanceId = useMemo(() => {
    if (effectiveSpoolId) {
      const s = spools.find((sp) => sp._id === effectiveSpoolId);
      if (s?.instanceId) return s.instanceId;
    }
    return filament.instanceId ?? "";
  }, [effectiveSpoolId, spools, filament.instanceId]);

  const dialogRef = useRef<HTMLDivElement>(null);

  // Whether the user has picked a printer in Settings. Loaded lazily
  // on dialog open so the renderer doesn't poll IPC on every page load.
  // null = "haven't asked yet", string = path, "" = explicitly unset.
  const [configuredDevice, setConfiguredDevice] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!open || !isElectron || !window.electronAPI?.labelPrinterGetDevicePath) return;
    let cancelled = false;
    window.electronAPI
      .labelPrinterGetDevicePath()
      .then((path) => {
        if (!cancelled) setConfiguredDevice(path);
      })
      .catch(() => {
        if (!cancelled) setConfiguredDevice(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isElectron]);

  // Default to the user's last choice; fall back to instanceId mode if
  // the filament has one available, otherwise URL (the QR will always
  // resolve to *something* the user can scan).
  const [qrMode, setQrMode] = useState<QrMode>(() => {
    if (typeof window === "undefined") return "instanceId";
    const stored = localStorage.getItem(LAST_QR_MODE_KEY);
    if (stored === "instanceId" || stored === "url") return stored;
    return filament.instanceId ? "instanceId" : "url";
  });

  // Derive the *effective* mode at render time — if the user picked
  // instanceId but this filament doesn't have one, fall through to URL
  // without a re-render round-trip. (An effect that called setQrMode
  // would trigger react-hooks/set-state-in-effect and cascade.)
  const effectiveQrMode: QrMode =
    qrMode === "instanceId" && !effectiveInstanceId ? "url" : qrMode;

  // Persist the mode the user explicitly chose (not the fall-through),
  // so toggling back to a filament that has an instanceId restores
  // their preference.
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(LAST_QR_MODE_KEY, qrMode);
    }
  }, [qrMode]);

  /* --- QR payload derivation --- */
  // The deep link's base URL needs to be REACHABLE by whoever scans
  // the printed label. Two sources, in priority order:
  //
  //   1. Settings → Label Printer → "Public URL" (electron-store key
  //      labelPrinterPublicUrl). User sets this when they expose
  //      Filament DB on the LAN or a public domain. (Codex P2 on
  //      PR #487.)
  //   2. window.location.origin — only useful when it's NOT localhost.
  //      Packaged Electron always serves on localhost so this branch
  //      only helps web users with a real domain.
  //
  // If neither yields a non-localhost URL, the deep-link mode is
  // gated off — the radio renders disabled with a pointer to Settings.
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !isElectron || !window.electronAPI?.labelPrinterGetPublicUrl) return;
    let cancelled = false;
    window.electronAPI
      .labelPrinterGetPublicUrl()
      .then((url) => {
        if (!cancelled) setPublicUrl(url);
      })
      .catch(() => {
        if (!cancelled) setPublicUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isElectron]);

  const { deepLinkUrl, deepLinkAvailable } = useMemo(() => {
    if (typeof window === "undefined") {
      return { deepLinkUrl: "", deepLinkAvailable: false };
    }
    if (publicUrl) {
      return {
        deepLinkUrl: buildFilamentDeepLink(publicUrl, filament._id, effectiveSpoolId),
        deepLinkAvailable: true,
      };
    }
    // Web case: window.location.origin is usually a real URL. Fall
    // back when it's not localhost. We share the same helper the
    // main-process validator uses (src/lib/loopbackHost.ts) so the
    // UX gate and the security boundary can't drift — Codex P2 round
    // 11 caught a previous regex here that missed `localhost.`,
    // `[::]`, IPv4-mapped IPv6, etc. that the main-process check
    // already rejects.
    const origin = window.location.origin;
    if (!isLoopbackUrl(origin)) {
      return {
        deepLinkUrl: buildFilamentDeepLink(origin, filament._id, effectiveSpoolId),
        deepLinkAvailable: true,
      };
    }
    return { deepLinkUrl: "", deepLinkAvailable: false };
  }, [publicUrl, filament._id, effectiveSpoolId]);

  // Effective mode considers BOTH "instanceId exists" and "URL is
  // reachable" — if URL mode is selected but no reachable URL exists,
  // fall through to instanceId (or vice versa). When neither is
  // available, qrPayload is empty and the Print button stays disabled.
  const fallbackQrMode: QrMode =
    effectiveQrMode === "url" && !deepLinkAvailable
      ? effectiveInstanceId
        ? "instanceId"
        : "url" // still URL but payload will be empty → Print disabled
      : effectiveQrMode;

  const qrPayload = fallbackQrMode === "instanceId" ? effectiveInstanceId : deepLinkUrl;

  // GH #592: a label is printable when it has SOMETHING on it — a QR (format
  // enables it AND a payload resolved) or at least one non-empty text line.
  // This both unblocks "QR off" text-only labels (Codex P2) and blocks a
  // blank label when QR is off and every selected field is empty (Codex P3).
  const hasQr = format.qr.enabled && !!qrPayload;
  const hasText = useMemo(
    () => composeLabelLines(labelFilament, format).length > 0,
    [labelFilament, format],
  );
  const canPrint = hasQr || hasText;

  /* --- live preview --- */
  // Combined state for the preview keeps the effect down to a single
  // setState call (per the project's react-hooks/set-state-in-effect
  // rule, see CLAUDE.md). The cancelled flag lets a stale resolve drop
  // its result when the user flips qrMode while a render is in flight.
  type PreviewState =
    | { status: "idle" }
    | { status: "rendering" }
    | { status: "ready"; dataUrl: string }
    | { status: "error"; message: string };
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

  useEffect(() => {
    if (!open || !canPrint) {
      // Intentional synchronous state reset when the dialog closes or
      // the payload becomes empty — the effect is the right driver here
      // because the outputs depend on `open` / `qrPayload`. Matches the
      // project's existing exceptions for data-fetching effects.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreview({ status: "idle" });
      return;
    }
    let cancelled = false;
    setPreview({ status: "rendering" });
    renderLabelPreviewDataUrl({
      filament: labelFilament,
      qrPayload,
      format,
    })
      .then(({ dataUrl }) => {
        if (!cancelled) setPreview({ status: "ready", dataUrl });
      })
      .catch((err) => {
        if (!cancelled) {
          setPreview({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, qrPayload, canPrint, labelFilament, format]);

  /* --- print / download handler ---
   *
   * Electron path: render bitmap → encode → send bytes over IPC to the
   * print transport in the main process, which hands them to the OS print
   * system (CUPS `lp -o raw` / Windows spooler RAW). The renderer never
   * shells out or opens the USB device directly. (GH #588)
   *
   * Web path: render → encode → download .bin file so the simulator
   * script can decode it. Useful for development without a printer and
   * as a forward-compat escape hatch for users who run filament-db
   * web-only and want to inspect the byte stream. */
  const [printing, setPrinting] = useState(false);
  const handlePrint = useCallback(async () => {
    setPrinting(true);
    try {
      const { grayscale, rasterLines } = await renderLabelBitmap({
        filament: labelFilament,
        qrPayload,
        format,
      });
      const packed = packGrayscaleBitmap(grayscale, rasterLines);
      const bytes = encodeLabel({
        bitmap: packed,
        rasterLines,
        tapeWidthMm: 24,
      });

      if (isElectron && window.electronAPI?.labelPrinterPrint) {
        // Uint8Array doesn't structured-clone cleanly across the IPC
        // boundary in all Electron versions; passing as a plain number[]
        // sidesteps any serialization quirks at the cost of a single
        // O(n) marshal (the encoder caps total bytes at ~270 KB so this
        // is cheap in absolute terms).
        try {
          await window.electronAPI.labelPrinterPrint(Array.from(bytes));
          toast(t("printLabel.printedSuccess"), "success");
          onClose();
          return;
        } catch (err) {
          // Surface the failure but stay in the dialog so the user can
          // open Settings and reconfigure the device path without losing
          // their QR-mode selection.
          const msg = err instanceof Error ? err.message : String(err);
          toast(t("printLabel.printFailed", { error: msg }), "error");
          return;
        }
      }

      // Web fallback (or Electron with no electronAPI surface — unlikely
      // but defensive). Downloads the .bin file for offline inspection.
      const filename = `${filament.name.replace(/[^a-z0-9]+/gi, "_")}_label.bin`;
      const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast(t("printLabel.downloadedWeb", { filename }), "success");
      onClose();
    } catch (err) {
      toast(
        t("printLabel.printFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        "error",
      );
    } finally {
      setPrinting(false);
    }
  }, [labelFilament, format, qrPayload, isElectron, toast, t, onClose, filament.name]);

  /* --- escape + Tab focus trap (#820) --- */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      // aria-modal alone doesn't trap Tab — focus escapes to the page behind
      // the overlay. Cycle within the dialog like the other modals. The
      // selector includes <select> for the spool picker (broader than
      // OptResyncDialog/ConfirmDialog, which have no select).
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? focusables.indexOf(active) : -1;
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const next = idx < 0 ? 0 : (idx + dir + focusables.length) % focusables.length;
      focusables[next].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current.focus();
    return () => {
      if (prev && document.contains(prev)) prev.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const instanceIdDisabled = !effectiveInstanceId;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="print-label-dialog-title"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto outline-none"
      >
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2
            id="print-label-dialog-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t("printLabel.title")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t("printLabel.subtitle", { name: filament.name })}
          </p>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* QR payload mode */}
          <fieldset>
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t("printLabel.qrMode")}
            </legend>
            <div className="space-y-2">
              <label
                className={`flex items-start gap-2 p-3 border rounded cursor-pointer ${
                  fallbackQrMode === "instanceId"
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                    : "border-gray-200 dark:border-gray-700"
                } ${instanceIdDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <input
                  type="radio"
                  name="qrMode"
                  value="instanceId"
                  checked={fallbackQrMode === "instanceId"}
                  onChange={() => setQrMode("instanceId")}
                  disabled={instanceIdDisabled}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t("printLabel.qrMode.instanceId")}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {instanceIdDisabled
                      ? t("printLabel.qrMode.instanceId.unavailable")
                      : t("printLabel.qrMode.instanceId.help")}
                  </p>
                  {effectiveInstanceId && (
                    <code className="text-xs text-gray-700 dark:text-gray-300 font-mono mt-1 block break-all">
                      {effectiveInstanceId}
                    </code>
                  )}
                </div>
              </label>
              <label
                className={`flex items-start gap-2 p-3 border rounded cursor-pointer ${
                  fallbackQrMode === "url" && deepLinkAvailable
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                    : "border-gray-200 dark:border-gray-700"
                } ${!deepLinkAvailable ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                <input
                  type="radio"
                  name="qrMode"
                  value="url"
                  checked={fallbackQrMode === "url" && deepLinkAvailable}
                  onChange={() => setQrMode("url")}
                  disabled={!deepLinkAvailable}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t("printLabel.qrMode.url")}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {deepLinkAvailable
                      ? t("printLabel.qrMode.url.help")
                      : t("printLabel.qrMode.url.unavailable")}
                  </p>
                  {deepLinkAvailable && (
                    <code className="text-xs text-gray-700 dark:text-gray-300 font-mono mt-1 block break-all">
                      {deepLinkUrl}
                    </code>
                  )}
                </div>
              </label>
            </div>
          </fieldset>

          {/* GH #595 + #732: spool picker for multi-spool filaments — chooses
              which spool BOTH QR modes target. URL mode deep-links `?spool=`;
              instance-ID mode encodes that spool's instanceId. "Filament only"
              (the empty option) encodes the filament-level id (legacy). */}
          {spools.length > 1 && (
            <div>
              <label
                htmlFor="label-spool"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t("printLabel.spool")}
              </label>
              <select
                id="label-spool"
                value={effectiveSpoolId ?? ""}
                onChange={(e) => setSpoolChoice(e.target.value)}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">{t("printLabel.spool.none")}</option>
                {spools.map((s, i) => (
                  <option key={s._id} value={s._id}>
                    {(s.label && s.label.trim()) || t("printLabel.spool.fallback", { n: i + 1 })}
                    {s.retired ? t("printLabel.spool.retiredSuffix") : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t("printLabel.spool.help")}
              </p>
            </div>
          )}

          {/* Preview */}
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t("printLabel.preview")}
            </p>
            <div className="border border-gray-200 dark:border-gray-700 rounded p-4 bg-gray-50 dark:bg-gray-800 overflow-x-auto">
              {preview.status === "error" ? (
                <p className="text-sm text-red-600 dark:text-red-400">
                  {t("printLabel.preview.error", { error: preview.message })}
                </p>
              ) : preview.status === "ready" ? (
                // next/image is the wrong tool here — the preview is a
                // dynamically-rendered data URL with pixelated rendering
                // (we want to see the actual print dots). The Next image
                // optimiser would smooth them out. Plain <img> is correct;
                // suppress the lint warning rather than work around it.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview.dataUrl}
                  alt={t("printLabel.preview.alt")}
                  className="block"
                  // Render at native dot density so the preview matches
                  // print output 1:1. CSS doubles it for legibility on
                  // hi-DPI screens.
                  style={{
                    height: 128,
                    width: "auto",
                    imageRendering: "pixelated",
                  }}
                />
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("printLabel.preview.rendering")}
                </p>
              )}
            </div>
            {/* Mode-aware notice. Web: tell users they're getting a
                .bin download and how to inspect it. Electron with a
                configured device: explain the IPC path + how to change
                it. Electron without a configured device: tell users
                they need to pair the printer and pick it in Settings. */}
            {!isElectron ? (
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-2">
                {t("printLabel.webOnlyNotice")}
              </p>
            ) : configuredDevice ? (
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
                {t("printLabel.electronNoticeConfigured")}
              </p>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-2">
                {t("printLabel.electronNoticeUnconfigured")}
              </p>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={printing}
            className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={handlePrint}
            disabled={printing || !canPrint || preview.status !== "ready"}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {printing ? t("printLabel.printing") : t("printLabel.print")}
          </button>
        </div>
      </div>
    </div>
  );
}

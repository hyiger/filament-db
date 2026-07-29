"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useToast } from "@/components/Toast";
import { useIsElectron } from "@/hooks/useIsElectron";
import { useDateFormat } from "@/hooks/useDateFormat";
import { isLoopbackUrl } from "@/lib/loopbackHost";
import { buildLocationDeepLink } from "@/lib/labelDeepLink";
import { render, type LabelDocument } from "@/lib/tsplEncoder";
import {
  dryBoxLabel,
  type DryBoxLabelItem,
  type DryBoxLabelStrings,
} from "@/lib/dryBoxLabel";
import TsplLabelPreview from "@/components/TsplLabelPreview";

/**
 * Print dialog for a dry-box (Location) label on the KNAON Y813BT — the
 * TSPL sibling of PrintLabelDialog (Brother, spool labels). Opened from an
 * /inventory location group header.
 *
 * The label document comes from the pure `dryBoxLabel()` template; this
 * dialog only supplies data: the location, its non-retired spools (the
 * manifest), the QR deep link, localized strings, and the user's date
 * format. Preview and print consume the SAME document.
 *
 * Print delivery mirrors PrintLabelDialog:
 *   - **Electron**: bytes over IPC (`tspl-printer-print`) to the OS print
 *     transport — the second, independent device selection.
 *   - **Web**: downloads the .prn (raw TSPL, CRLF-framed) — genuinely
 *     useful, since `lp -o raw -d <queue> file.prn` prints it as-is.
 *
 * QR base URL: Settings → Label printer → Public URL, else a non-loopback
 * window.location.origin. Unlike the Brother dialog there is no alternate
 * payload mode to fall back to, so with only a loopback origin the dialog
 * still prints but shows a warning — the box name + barcode still identify
 * the label, and reprinting after setting a public URL is cheap.
 */

interface PrintDryBoxLabelDialogProps {
  open: boolean;
  onClose: () => void;
  location: {
    _id: string;
    name: string;
    humidity: number | null;
    /** ISO string over the wire; a Date only in server-side tests — the
     *  template accepts both. */
    desiccantChangedAt: string | Date | null;
  };
}

export default function PrintDryBoxLabelDialog({
  open,
  onClose,
  location,
}: PrintDryBoxLabelDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isElectron = useIsElectron();
  const { formatDate } = useDateFormat();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Whether a TSPL printer is selected in Settings. Loaded lazily on open,
  // like the Brother dialog's device check.
  const [configuredDevice, setConfiguredDevice] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!open || !isElectron || !window.electronAPI?.tsplPrinterGetDevicePath) return;
    let cancelled = false;
    window.electronAPI
      .tsplPrinterGetDevicePath()
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

  // The QR base URL — shared with the Brother labels (one public URL per
  // install; see the labelPrinterPublicUrl setting).
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

  const { qrPayload, qrReachable } = useMemo(() => {
    if (typeof window === "undefined") return { qrPayload: "", qrReachable: false };
    if (publicUrl) {
      return { qrPayload: buildLocationDeepLink(publicUrl, location._id), qrReachable: true };
    }
    const origin = window.location.origin;
    return {
      qrPayload: buildLocationDeepLink(origin, location._id),
      qrReachable: !isLoopbackUrl(origin),
    };
  }, [publicUrl, location._id]);

  // The manifest is fetched HERE, unfiltered — never taken from the page's
  // rows. The inventory page passes its type/vendor filters to the API and
  // search-filters client-side, so its group.spools is the VISIBLE subset;
  // printing that under an active filter produces a label asserting a
  // partial list is the box's full contents, dated as if authoritative
  // (PR #1043 P1). The default query excludes retired spools server-side —
  // retired means out of inventory, not "in the box".
  type ManifestState =
    | { status: "loading" }
    | { status: "ready"; items: DryBoxLabelItem[] }
    | { status: "error"; message: string };
  const [manifest, setManifest] = useState<ManifestState>({ status: "loading" });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setManifest({ status: "loading" });
    fetch("/api/spools/by-location")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { groups: Array<{ location: { _id: string } | null; spools: DryBoxLabelItem[] }> }) => {
        if (cancelled) return;
        const group = d.groups.find((g) => g.location?._id === location._id);
        setManifest({ status: "ready", items: group?.spools ?? [] });
      })
      .catch((err) => {
        if (!cancelled) {
          setManifest({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, location._id]);
  const items = manifest.status === "ready" ? manifest.items : null;

  // The template's user-visible strings come from the app locale. The
  // emitter folds them to ASCII on the way out (the Y813BT firmware
  // TRUNCATES a TEXT literal at any byte >= 0x80 — hardware-verified), so
  // German strings print transliterated (ü -> u) rather than clipped.
  const strings: DryBoxLabelStrings = useMemo(
    () => ({
      subtitle: t("dryBoxLabel.label.subtitle"),
      contents: t("dryBoxLabel.label.contents"),
      desiccantChanged: t("dryBoxLabel.label.desiccantChanged"),
      desiccantNever: t("dryBoxLabel.label.desiccantNever"),
      replaceHint: t("dryBoxLabel.label.replaceHint"),
      empty: t("dryBoxLabel.label.empty"),
      more: t("dryBoxLabel.label.more"),
      asOf: t("dryBoxLabel.label.asOf"),
    }),
    [t],
  );

  // "As of" stamp: the moment the dialog opened. Memoised per open so the
  // preview doesn't re-render every second; dryBoxLabel itself stays pure.
  const asOf = useMemo(() => new Date(), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  type DocState =
    | { doc: LabelDocument; error: null }
    | { doc: null; error: string | null }; // error null = still loading
  const docState: DocState = useMemo(() => {
    if (!items) {
      return {
        doc: null,
        error: manifest.status === "error" ? manifest.message : null,
      };
    }
    try {
      return {
        doc: dryBoxLabel(
          {
            location: {
              name: location.name,
              humidity: location.humidity,
              desiccantChangedAt: location.desiccantChangedAt,
            },
            items,
            qrPayload,
            asOf,
            formatDate: (d) => formatDate(d),
          },
          strings,
        ),
        error: null,
      };
    } catch (err) {
      // fitQr throws when the payload cannot print legibly (e.g. an
      // absurdly long public URL) — surface it instead of a broken preview.
      return { doc: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [location, items, manifest, qrPayload, asOf, formatDate, strings]);

  const [printing, setPrinting] = useState(false);
  const handlePrint = useCallback(async () => {
    if (!docState.doc) return;
    setPrinting(true);
    try {
      const bytes = render(docState.doc);

      if (isElectron && window.electronAPI?.tsplPrinterPrint) {
        try {
          // number[] across IPC for the same structured-clone reasons as the
          // Brother path; a dry-box label is ~1 KB so the marshal is free.
          await window.electronAPI.tsplPrinterPrint(Array.from(bytes));
          toast(t("dryBoxLabel.printedSuccess"), "success");
          onClose();
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toast(t("dryBoxLabel.printFailed", { error: msg }), "error");
          return;
        }
      }

      // Web fallback: the raw TSPL job. `lp -o raw -d <queue> <file>` prints
      // it unchanged, so this is a working path, not just an inspection aid.
      const filename = `${location.name.replace(/[^a-z0-9]+/gi, "_")}_drybox.prn`;
      const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast(t("dryBoxLabel.downloadedWeb", { filename }), "success");
      onClose();
    } catch (err) {
      toast(
        t("dryBoxLabel.printFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        "error",
      );
    } finally {
      setPrinting(false);
    }
  }, [docState.doc, isElectron, toast, t, onClose, location.name]);

  /* Escape + Tab focus trap — the shared modal pattern (#820). */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="drybox-label-dialog-title"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto outline-none"
      >
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2
            id="drybox-label-dialog-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t("dryBoxLabel.title")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t("dryBoxLabel.subtitle", {
              name: location.name,
              count: items ? String(items.length) : "…",
            })}
          </p>
        </div>

        <div className="px-6 py-4 space-y-3">
          {!docState.doc ? (
            docState.error === null ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t("dryBoxLabel.loadingManifest")}
              </p>
            ) : (
              <p className="text-sm text-red-600 dark:text-red-400">
                {t("dryBoxLabel.preview.error", { error: docState.error })}
              </p>
            )
          ) : (
            <TsplLabelPreview doc={docState.doc} ariaLabel={t("dryBoxLabel.preview.alt")} />
          )}

          {!qrReachable && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t("dryBoxLabel.urlWarning")}
            </p>
          )}
          {!isElectron ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t("dryBoxLabel.webOnlyNotice")}
            </p>
          ) : configuredDevice ? null : (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t("dryBoxLabel.noPrinterNotice")}
            </p>
          )}
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
            disabled={printing || !docState.doc}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {printing
              ? t("dryBoxLabel.printing")
              : isElectron
                ? t("dryBoxLabel.print")
                : t("dryBoxLabel.download")}
          </button>
        </div>
      </div>
    </div>
  );
}

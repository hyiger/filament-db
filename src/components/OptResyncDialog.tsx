"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

/**
 * GH #607 Phase 1 — "Check for OpenPrintTag updates" dialog.
 *
 * Fetches the field-level diff between this filament and its upstream
 * OpenPrintTag material (`GET …/openprinttag/check`), lets the user pick
 * which changes to adopt, and applies them (`POST …/openprinttag/sync`).
 *
 * `adopt`-classified changes are checked by default (the field was unset
 * or still matched OPT); `conflict`-classified changes are unchecked and
 * flagged, because the user edited that field away from OPT and we don't
 * want a careless "apply all" to silently revert their work.
 */

type ChangeKind = "adopt" | "conflict";
type OptValue = string | number | string[] | null;

interface FieldChange {
  field: string;
  labelKey: string;
  current: OptValue;
  incoming: OptValue;
  kind: ChangeKind;
}

interface CheckResponse {
  linked: boolean;
  found?: boolean;
  slug?: string;
  materialName?: string;
  changes?: FieldChange[];
}

interface Props {
  filamentId: string;
  /** Called after a successful sync so the page can refresh. */
  onApplied: () => void;
  onClose: () => void;
  /** GH #1150: open the link picker in "change" mode (the page owns the
   *  OptLinkDialog state; this dialog closes itself first). */
  onChangeLink: () => void;
}

function formatValue(v: OptValue): string {
  if (v == null) return "—";
  if (Array.isArray(v)) return v.length === 0 ? "—" : v.join(", ");
  return String(v);
}

export default function OptResyncDialog({ filamentId, onApplied, onClose, onChangeLink }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CheckResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  // While the shared ConfirmDialog is up, this dialog's own Escape/Tab
  // handling must stand down — both listen on `document`, and Escape would
  // otherwise dismiss BOTH layers at once.
  const confirmOpenRef = useRef(false);
  const confirm = useConfirm();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/filaments/${filamentId}/openprinttag/check`);
        const body = (await res.json()) as CheckResponse;
        if (cancelled) return;
        if (!res.ok) {
          setError(t("resync.error"));
        } else {
          setData(body);
          // Default-check the safe (adopt) changes only.
          setSelected(
            new Set((body.changes ?? []).filter((c) => c.kind === "adopt").map((c) => c.field)),
          );
        }
      } catch {
        if (!cancelled) setError(t("resync.error"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filamentId, t]);

  // Escape to close + Tab focus trap (mirrors ConfirmDialog's mechanics).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmOpenRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [onClose]);

  const toggle = useCallback((field: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }, []);

  const handleApply = useCallback(async () => {
    const fields = [...selected];
    if (fields.length === 0) {
      toast(t("resync.none"), "error");
      return;
    }
    setApplying(true);
    try {
      const res = await fetch(`/api/filaments/${filamentId}/openprinttag/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) {
        toast(t("resync.applyFailed"), "error");
        return;
      }
      toast(t("resync.applied", { count: fields.length }), "success");
      onApplied();
      onClose();
    } catch {
      toast(t("resync.applyFailed"), "error");
    } finally {
      setApplying(false);
    }
  }, [selected, filamentId, toast, t, onApplied, onClose]);

  const handleRemoveLink = useCallback(async () => {
    confirmOpenRef.current = true;
    const ok = await confirm({
      title: t("resync.removeConfirmTitle"),
      message: t("resync.removeConfirm"),
      confirmLabel: t("resync.removeLink"),
      destructive: true,
    });
    confirmOpenRef.current = false;
    if (!ok) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/filaments/${filamentId}/openprinttag/link`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast(t("resync.removeFailed"), "error");
        return;
      }
      toast(t("resync.removed"), "success");
      onApplied();
      onClose();
    } catch {
      toast(t("resync.removeFailed"), "error");
    } finally {
      setRemoving(false);
    }
  }, [confirm, filamentId, toast, t, onApplied, onClose]);

  const changes = data?.changes ?? [];
  const hasConflicts = changes.some((c) => c.kind === "conflict");
  // GH #1150: the link-management actions show whenever the filament IS
  // linked — including the materialGone dead end (linked, found: false),
  // which is exactly where "remove or re-point the link" is the only remedy.
  // A FAILED check keeps them too (Codex P2): this dialog only opens from
  // the "Check for updates" button, which is gated on _hasOwnOptLink, so the
  // filament is linked by construction — and the DELETE endpoint needs no
  // upstream fetch, so an unreachable OPT database must not re-create the
  // very dead end #1150 is about.
  const showLinkActions = !loading && (error !== null || data?.linked === true);

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("resync.title")}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold">{t("resync.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label={t("common.close")}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          {loading && <p className="text-sm text-gray-500">{t("resync.checking")}</p>}
          {!loading && error && <p className="text-sm text-red-500">{error}</p>}
          {!loading && !error && data && !data.linked && (
            <p className="text-sm text-gray-500">{t("resync.notLinked")}</p>
          )}
          {!loading && !error && data?.linked && data.found === false && (
            <p className="text-sm text-amber-600 dark:text-amber-400">{t("resync.materialGone")}</p>
          )}
          {!loading && !error && data?.found && changes.length === 0 && (
            <p className="text-sm text-green-600 dark:text-green-400">{t("resync.upToDate")}</p>
          )}

          {!loading && !error && changes.length > 0 && (
            <>
              {data?.materialName && (
                <p className="text-xs text-gray-500 mb-3">
                  {t("resync.source", { name: data.materialName })}
                </p>
              )}
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
                    <th className="py-1 pr-2 w-8" />
                    <th className="py-1 pr-2">{t("resync.colField")}</th>
                    <th className="py-1 pr-2">{t("resync.colCurrent")}</th>
                    <th className="py-1 pr-2">{t("resync.colIncoming")}</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.field} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="py-1.5 pr-2 align-top">
                        <input
                          type="checkbox"
                          checked={selected.has(c.field)}
                          onChange={() => toggle(c.field)}
                          aria-label={t(c.labelKey)}
                        />
                      </td>
                      <td className="py-1.5 pr-2 align-top">
                        <span>{t(c.labelKey)}</span>
                        {c.kind === "conflict" && (
                          <span className="ml-1.5 text-[10px] uppercase font-semibold text-amber-600 dark:text-amber-400">
                            {t("resync.conflictBadge")}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 align-top text-gray-500 font-mono text-xs break-all">
                        {formatValue(c.current)}
                      </td>
                      <td className="py-1.5 pr-2 align-top font-mono text-xs break-all">
                        {formatValue(c.incoming)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hasConflicts && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-3">
                  {t("resync.conflictHint")}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-gray-200 dark:border-gray-700">
          {showLinkActions && (
            <div className="flex items-center gap-2 mr-auto">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onChangeLink();
                }}
                className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {t("resync.changeLink")}
              </button>
              <button
                type="button"
                onClick={handleRemoveLink}
                disabled={removing}
                className="px-3 py-1.5 text-sm rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("resync.removeLink")}
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t("resync.cancel")}
          </button>
          {changes.length > 0 && (
            <button
              type="button"
              onClick={handleApply}
              disabled={applying || selected.size === 0}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-700 disabled:cursor-not-allowed"
            >
              {t("resync.apply", { count: selected.size })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

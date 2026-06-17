"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useToast } from "@/components/Toast";

/**
 * Issue #753 (approach C) — "Link to OpenPrintTag" dialog.
 *
 * Lets the user link an EXISTING filament to an OpenPrintTag material so it
 * can use the "Check for updates" re-sync loop. Picks a material from the OPT
 * database (`GET /api/openprinttag`) and POSTs the slug to
 * `POST /api/filaments/{id}/openprinttag/link`, which writes only the linkage
 * + provenance snapshot — no field value is touched, so a variant's inherited
 * values are never clobbered.
 *
 * The OPT database is ~11k materials, so the list only renders once the user
 * types a query (capped at MAX_RESULTS) — no virtualization needed here.
 */

interface OptMaterial {
  slug: string;
  name: string;
  brandName: string;
  type: string;
  completenessTier: "rich" | "partial" | "stub";
}

interface Props {
  filamentId: string;
  /** Called after a successful link so the page can refresh. */
  onLinked: () => void;
  onClose: () => void;
}

const MAX_RESULTS = 50;

export default function OptLinkDialog({ filamentId, onLinked, onClose }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [materials, setMaterials] = useState<OptMaterial[]>([]);
  const [query, setQuery] = useState("");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/openprinttag");
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(t("optLink.loadFailed"));
        } else {
          setMaterials((body.materials ?? []) as OptMaterial[]);
        }
      } catch {
        if (!cancelled) setError(t("optLink.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Escape to close + Tab focus trap (mirrors OptResyncDialog's mechanics).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    return materials
      .filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.brandName.toLowerCase().includes(q) ||
          m.type.toLowerCase().includes(q),
      )
      .slice(0, MAX_RESULTS);
  }, [materials, query]);

  const handleLink = async () => {
    if (!selectedSlug) return;
    setLinking(true);
    try {
      const res = await fetch(`/api/filaments/${filamentId}/openprinttag/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: selectedSlug }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(body?.found === false ? t("optLink.materialGone") : t("optLink.failed"), "error");
        return;
      }
      toast(t("optLink.linked"), "success");
      onLinked();
      onClose();
    } catch {
      toast(t("optLink.failed"), "error");
    } finally {
      setLinking(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("optLink.title")}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold">{t("optLink.title")}</h2>
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
          <p className="text-xs text-gray-500 mb-3">{t("optLink.help")}</p>
          {loading && <p className="text-sm text-gray-500">{t("optLink.loading")}</p>}
          {!loading && error && <p className="text-sm text-red-500">{error}</p>}
          {!loading && !error && (
            <>
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("optLink.searchPlaceholder")}
                aria-label={t("optLink.searchPlaceholder")}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 mb-3"
              />
              {query.trim() === "" ? (
                <p className="text-sm text-gray-400">{t("optLink.typeToSearch")}</p>
              ) : results.length === 0 ? (
                <p className="text-sm text-gray-400">{t("optLink.noResults")}</p>
              ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-700/50">
                  {results.map((m) => (
                    <li key={m.slug}>
                      <label className="flex items-center gap-3 py-2 cursor-pointer">
                        <input
                          type="radio"
                          name="opt-link-material"
                          checked={selectedSlug === m.slug}
                          onChange={() => setSelectedSlug(m.slug)}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm truncate">{m.name}</span>
                          <span className="block text-xs text-gray-500 truncate">
                            {m.brandName} · {m.type}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t("optLink.cancel")}
          </button>
          <button
            type="button"
            onClick={handleLink}
            disabled={linking || !selectedSlug}
            className="px-3 py-1.5 text-sm rounded bg-teal-600 text-white hover:bg-teal-700 disabled:bg-gray-400 dark:disabled:bg-gray-700 disabled:cursor-not-allowed"
          >
            {linking ? t("optLink.linking") : t("optLink.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

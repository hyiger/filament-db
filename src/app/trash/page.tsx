"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTranslation } from "@/i18n/TranslationProvider";
import { formatDate, formatTime } from "@/lib/dateFormat";
import FilamentSwatch from "@/components/FilamentSwatch";
import { deriveArrangement } from "@/lib/filamentColors";

interface TrashedFilament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string | null;
  secondaryColors?: string[];
  optTags?: number[];
  cost: number | null;
  parentId: string | null;
  _deletedAt: string;
}

export default function TrashPage() {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<TrashedFilament[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const fetchTrash = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const res = await fetch("/api/filaments/trash", { signal });
        if (!res.ok) {
          toast(t("trash.loadError"), "error");
          setLoading(false);
          return;
        }
        const data = await res.json();
        setItems(data);
        setLoading(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        toast(t("trash.loadError"), "error");
        setLoading(false);
      }
    },
    [toast, t],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchTrash(ac.signal); // eslint-disable-line react-hooks/set-state-in-effect -- mount fetch
    return () => ac.abort();
  }, [fetchTrash]);

  const markBusy = (id: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleRestore = async (item: TrashedFilament) => {
    markBusy(item._id, true);
    try {
      const res = await fetch(`/api/filaments/${item._id}/restore`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast(body?.error || t("trash.restoreError"), "error");
        return;
      }
      toast(t("trash.restored", { name: item.name }));
      fetchTrash();
    } finally {
      markBusy(item._id, false);
    }
  };

  const handlePermanentDelete = async (item: TrashedFilament) => {
    if (!(await confirm({ message: t("trash.permanentConfirm", { name: item.name }), destructive: true, confirmLabel: t("common.delete") }))) return;
    markBusy(item._id, true);
    try {
      const res = await fetch(`/api/filaments/${item._id}?permanent=true`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast(body?.error || t("trash.permanentError"), "error");
        return;
      }
      toast(t("trash.permanentDeleted", { name: item.name }));
      fetchTrash();
    } finally {
      markBusy(item._id, false);
    }
  };

  const handleEmptyTrash = async () => {
    if (items.length === 0) return;
    if (!(await confirm({ message: t("trash.emptyConfirm", { count: items.length }), destructive: true, confirmLabel: t("common.delete") }))) return;
    let ok = 0;
    const errors: string[] = [];
    // Permanent delete each one sequentially. Variants must be purged before
    // their parents, so do trashed-variants-first.
    const ordered = [...items].sort((a, b) => {
      // items with a parentId go first (variants before parents)
      if (a.parentId && !b.parentId) return -1;
      if (!a.parentId && b.parentId) return 1;
      return 0;
    });
    for (const item of ordered) {
      const res = await fetch(`/api/filaments/${item._id}?permanent=true`, {
        method: "DELETE",
      });
      if (res.ok) {
        ok++;
      } else {
        const body = await res.json().catch(() => null);
        errors.push(body?.error || item.name);
      }
    }
    toast(t("trash.emptyDone", { count: ok }));
    if (errors.length > 0) {
      toast(errors.slice(0, 3).join("; "), "error");
    }
    fetchTrash();
  };

  /**
   * GH #419: Bulk "Restore all" counterpart to "Empty trash". When a
   * user soft-deletes a large set by accident, one-by-one restore is
   * painful. Mirrors the empty-trash flow:
   *   - confirmation modal (non-destructive here, but still gated)
   *   - variants restored BEFORE parents to avoid the name-conflict
   *     409 against an already-restored sibling
   *   - per-item failure is collected, surfaced via toast, and doesn't
   *     halt the loop
   * Wait — actually we want PARENTS first here, opposite of empty-
   * trash: a variant restore requires the parent to be present
   * (active), and the partial-unique-on-non-deleted name index
   * checks against currently-active rows. Restoring a variant whose
   * parent is still trashed would either dangle or 409 against a
   * stale-active sibling on a name collision. Parent-first is safe
   * because variant names are typically distinct from parent names.
   */
  const handleRestoreAll = async () => {
    if (items.length === 0) return;
    if (
      !(await confirm({
        message: t("trash.restoreAllConfirm", { count: items.length }),
        confirmLabel: t("trash.restore"),
      }))
    ) {
      return;
    }
    let ok = 0;
    const errors: string[] = [];
    // Parents-first restore order. Inverse of empty-trash's variants-first
    // ordering, for the reason in the docblock above.
    const ordered = [...items].sort((a, b) => {
      if (!a.parentId && b.parentId) return -1;
      if (a.parentId && !b.parentId) return 1;
      return 0;
    });
    for (const item of ordered) {
      const res = await fetch(`/api/filaments/${item._id}/restore`, {
        method: "POST",
      });
      if (res.ok) {
        ok++;
      } else {
        const body = await res.json().catch(() => null);
        errors.push(body?.error || item.name);
      }
    }
    toast(t("trash.restoreAllDone", { count: ok }));
    if (errors.length > 0) {
      toast(errors.slice(0, 3).join("; "), "error");
    }
    fetchTrash();
  };

  return (
    <main id="main-content" className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; {t("trash.backToFilaments")}
        </Link>
      </div>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">{t("trash.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("trash.subtitle")}</p>
        </div>
        {items.length > 0 && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleRestoreAll}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              {t("trash.restoreAll", { count: items.length })}
            </button>
            <button
              type="button"
              onClick={handleEmptyTrash}
              className="px-3 py-1.5 text-sm bg-red-700 text-white rounded hover:bg-red-600"
            >
              {t("trash.emptyAll", { count: items.length })}
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-gray-500 mb-3">{t("trash.empty")}</p>
          <Link
            href="/"
            className="text-blue-600 hover:underline text-sm"
          >
            {t("trash.backToFilaments")}
          </Link>
        </div>
      ) : (
        <ul className="border border-gray-200 dark:border-gray-700 rounded divide-y divide-gray-100 dark:divide-gray-800">
          {items.map((item) => {
            const isBusy = busy.has(item._id);
            const deleted = new Date(item._deletedAt);
            return (
              <li
                key={item._id}
                className="px-3 py-2 flex items-center gap-3 text-sm"
              >
                <FilamentSwatch
                  color={item.color}
                  secondaryColors={item.secondaryColors}
                  arrangement={deriveArrangement(item.optTags)}
                  size={20}
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{item.name}</p>
                  <p className="text-xs text-gray-500">
                    {item.vendor} · {item.type}
                    {item.parentId && ` · ${t("trash.variantBadge")}`}
                    <span className="ml-2">
                      {t("trash.deletedAt", {
                        date: formatDate(deleted, locale),
                        time: formatTime(deleted, locale),
                      })}
                    </span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRestore(item)}
                  disabled={isBusy}
                  className="px-3 py-1 text-xs rounded border border-blue-500 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50"
                >
                  {t("trash.restore")}
                </button>
                <button
                  type="button"
                  onClick={() => handlePermanentDelete(item)}
                  disabled={isBusy}
                  className="px-3 py-1 text-xs rounded bg-red-700 text-white hover:bg-red-600 disabled:opacity-50"
                >
                  {t("trash.permanentDelete")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

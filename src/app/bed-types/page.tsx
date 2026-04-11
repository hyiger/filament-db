"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";

interface BedType {
  _id: string;
  name: string;
  material: string;
  notes: string;
}

export default function BedTypesPage() {
  const [bedTypes, setBedTypes] = useState<BedType[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const { toast } = useToast();
  const { t } = useTranslation();

  const fetchBedTypes = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch("/api/bed-types", { signal });
      if (!res.ok) {
        toast(t("bedTypes.loadError"), "error");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setBedTypes(data);
      setSelected(new Set());
      setLoading(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast(t("bedTypes.loadError"), "error");
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => {
    const ac = new AbortController();
    fetchBedTypes(ac.signal); // eslint-disable-line react-hooks/set-state-in-effect -- data fetching on mount
    return () => ac.abort();
  }, [fetchBedTypes]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === bedTypes.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(bedTypes.map((b) => b._id)));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(t("bedTypes.deleteConfirm", { name }))) return;
    const res = await fetch(`/api/bed-types/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("bedTypes.deleteError"), "error");
      return;
    }
    toast(t("bedTypes.deleted", { name }));
    fetchBedTypes();
  };

  const handleBulkDelete = async () => {
    const count = selected.size;
    if (!confirm(t("bedTypes.bulkDeleteConfirm", { count }))) return;
    setBulkDeleting(true);
    let deleted = 0;
    const errors: string[] = [];
    for (const id of selected) {
      const res = await fetch(`/api/bed-types/${id}`, { method: "DELETE" });
      if (res.ok) {
        deleted++;
      } else {
        const body = await res.json().catch(() => null);
        const name = bedTypes.find((b) => b._id === id)?.name ?? id;
        errors.push(body?.error || t("bedTypes.deleteErrorNamed", { name }));
      }
    }
    if (deleted > 0) toast(t("bedTypes.bulkDeleted", { count: deleted }));
    if (errors.length > 0) toast(errors.join("; "), "error");
    setBulkDeleting(false);
    fetchBedTypes();
  };

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">{t("bedTypes.title")}</h1>
          <div className="flex gap-3">
            <Link href="/" className="text-blue-600 hover:underline text-sm">
              &larr; {t("bedTypes.backToFilaments")}
            </Link>
            <span className="text-gray-400 dark:text-gray-600">|</span>
            <Link href="/settings" className="text-blue-600 hover:underline text-sm">
              &larr; {t("bedTypes.backToSettings")}
            </Link>
          </div>
        </div>
        <Link
          href="/bed-types/new"
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          {t("bedTypes.addNew")}
        </Link>
      </div>

      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-3 px-3 py-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
          <span className="text-sm text-red-600 dark:text-red-300">{t("bedTypes.selected", { count: selected.size })}</span>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="px-3 py-1 bg-red-700 text-white rounded text-sm hover:bg-red-600 disabled:opacity-50"
          >
            {bulkDeleting ? t("bedTypes.deleting") : t("bedTypes.deleteCount", { count: selected.size })}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {t("bedTypes.clear")}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">{t("bedTypes.loading")}</p>
      ) : bedTypes.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">{t("bedTypes.empty")}</p>
          <Link href="/bed-types/new" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm">
            {t("bedTypes.addFirst")}
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-300">
                <th className="py-3 px-2 w-8">
                  <input
                    type="checkbox"
                    checked={selected.size === bedTypes.length && bedTypes.length > 0}
                    onChange={toggleAll}
                    aria-label={t("filaments.bulk.selectAll") || "Select all"}
                    className="accent-red-600"
                  />
                </th>
                <th className="text-left py-3 px-2">{t("bedTypes.table.name")}</th>
                <th className="text-left py-3 px-2">{t("bedTypes.table.material")}</th>
                <th className="text-left py-3 px-2">{t("bedTypes.table.notes")}</th>
                <th className="text-right py-3 px-2">{t("bedTypes.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {bedTypes.map((b) => (
                <tr
                  key={b._id}
                  className={`border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 ${selected.has(b._id) ? "bg-red-950/20" : ""}`}
                >
                  <td className="py-2 px-2">
                    <input
                      type="checkbox"
                      checked={selected.has(b._id)}
                      onChange={() => toggleSelect(b._id)}
                      aria-label={b.name || "Select"}
                      className="accent-red-600"
                    />
                  </td>
                  <td className="py-2 px-2 font-medium">{b.name}</td>
                  <td className="py-2 px-2">
                    <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-800 rounded text-xs">
                      {b.material}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-gray-500 text-xs">{b.notes || "\u2014"}</td>
                  <td className="py-2 px-2 text-right">
                    <Link
                      href={`/bed-types/${b._id}/edit`}
                      className="text-blue-600 hover:underline mr-3 text-xs"
                    >
                      {t("bedTypes.table.edit")}
                    </Link>
                    <button
                      onClick={() => handleDelete(b._id, b.name)}
                      className="text-red-600 hover:underline text-xs"
                    >
                      {t("bedTypes.table.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

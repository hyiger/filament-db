"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";

interface Location {
  _id: string;
  name: string;
  kind: string;
  humidity: number | null;
  notes: string;
  spoolCount: number;
  totalGrams: number;
}

export default function LocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const { toast } = useToast();
  const { t } = useTranslation();

  const fetchLocations = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const res = await fetch("/api/locations?stats=true", { signal });
        if (!res.ok) {
          toast(t("locations.loadError"), "error");
          setLoading(false);
          return;
        }
        const data = await res.json();
        setLocations(data);
        setSelected(new Set());
        setLoading(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        toast(t("locations.loadError"), "error");
        setLoading(false);
      }
    },
    [toast, t],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchLocations(ac.signal); // eslint-disable-line react-hooks/set-state-in-effect -- data fetching on mount
    return () => ac.abort();
  }, [fetchLocations]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === locations.length) setSelected(new Set());
    else setSelected(new Set(locations.map((l) => l._id)));
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(t("locations.deleteConfirm", { name }))) return;
    const res = await fetch(`/api/locations/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("locations.deleteError"), "error");
      return;
    }
    toast(t("locations.deleted", { name }));
    fetchLocations();
  };

  const handleBulkDelete = async () => {
    const count = selected.size;
    if (!confirm(t("locations.bulkDeleteConfirm", { count }))) return;
    setBulkDeleting(true);
    let deleted = 0;
    const errors: string[] = [];
    for (const id of selected) {
      const res = await fetch(`/api/locations/${id}`, { method: "DELETE" });
      if (res.ok) {
        deleted++;
      } else {
        const body = await res.json().catch(() => null);
        const name = locations.find((l) => l._id === id)?.name ?? id;
        errors.push(body?.error || t("locations.deleteErrorNamed", { name }));
      }
    }
    if (deleted > 0) toast(t("locations.bulkDeleted", { count: deleted }));
    if (errors.length > 0) toast(errors.join("; "), "error");
    setBulkDeleting(false);
    fetchLocations();
  };

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">{t("locations.title")}</h1>
          <div className="flex gap-3">
            <Link
              href="/settings"
              className="text-blue-600 hover:underline text-sm"
            >
              &larr; {t("locations.backToSettings")}
            </Link>
          </div>
        </div>
        <Link
          href="/locations/new"
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          {t("locations.addNew")}
        </Link>
      </div>

      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-3 px-3 py-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
          <span className="text-sm text-red-600 dark:text-red-300">
            {t("locations.selected", { count: selected.size })}
          </span>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="px-3 py-1 bg-red-700 text-white rounded text-sm hover:bg-red-600 disabled:opacity-50"
          >
            {bulkDeleting
              ? t("locations.deleting")
              : t("locations.deleteCount", { count: selected.size })}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {t("locations.clear")}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">{t("locations.loading")}</p>
      ) : locations.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">{t("locations.empty")}</p>
          <Link
            href="/locations/new"
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            {t("locations.addFirst")}
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
                    checked={
                      selected.size === locations.length && locations.length > 0
                    }
                    onChange={toggleAll}
                    aria-label={t("filaments.bulk.selectAll") || "Select all"}
                    className="accent-red-600"
                  />
                </th>
                <th className="text-left py-3 px-2">{t("locations.table.name")}</th>
                <th className="text-left py-3 px-2">{t("locations.table.kind")}</th>
                <th className="text-right py-3 px-2">
                  {t("locations.table.humidity")}
                </th>
                <th className="text-right py-3 px-2">
                  {t("locations.table.spools")}
                </th>
                <th className="text-right py-3 px-2">
                  {t("locations.table.weight")}
                </th>
                <th className="text-left py-3 px-2">{t("locations.table.notes")}</th>
                <th className="text-right py-3 px-2">{t("locations.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr
                  key={l._id}
                  className={`border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 ${
                    selected.has(l._id) ? "bg-red-950/20" : ""
                  }`}
                >
                  <td className="py-2 px-2">
                    <input
                      type="checkbox"
                      checked={selected.has(l._id)}
                      onChange={() => toggleSelect(l._id)}
                      aria-label={l.name || "Select"}
                      className="accent-red-600"
                    />
                  </td>
                  <td className="py-2 px-2 font-medium">{l.name}</td>
                  <td className="py-2 px-2">
                    <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-800 rounded text-xs">
                      {t(`locations.kind.${l.kind}`) || l.kind}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right text-xs">
                    {l.humidity != null ? `${l.humidity}%` : "—"}
                  </td>
                  <td className="py-2 px-2 text-right text-xs">{l.spoolCount}</td>
                  <td className="py-2 px-2 text-right text-xs text-gray-500">
                    {l.totalGrams > 0 ? `${Math.round(l.totalGrams)}g` : "—"}
                  </td>
                  <td className="py-2 px-2 text-gray-500 text-xs">{l.notes || "—"}</td>
                  <td className="py-2 px-2 text-right">
                    <Link
                      href={`/locations/${l._id}/edit`}
                      className="text-blue-600 hover:underline mr-3 text-xs"
                    >
                      {t("locations.table.edit")}
                    </Link>
                    <button
                      onClick={() => handleDelete(l._id, l.name)}
                      className="text-red-600 hover:underline text-xs"
                    >
                      {t("locations.table.delete")}
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

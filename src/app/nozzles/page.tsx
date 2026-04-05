"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";

interface Nozzle {
  _id: string;
  name: string;
  diameter: number;
  type: string;
  highFlow: boolean;
  hardened: boolean;
  notes: string;
}

export default function NozzlesPage() {
  const [nozzles, setNozzles] = useState<Nozzle[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const { toast } = useToast();
  const { t } = useTranslation();

  const fetchNozzles = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch("/api/nozzles", { signal });
      if (!res.ok) {
        toast(t("nozzles.loadError"), "error");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setNozzles(data);
      setSelected(new Set());
      setLoading(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast(t("nozzles.loadError"), "error");
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => {
    const ac = new AbortController();
    fetchNozzles(ac.signal); // eslint-disable-line react-hooks/set-state-in-effect -- data fetching on mount
    return () => ac.abort();
  }, [fetchNozzles]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === nozzles.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(nozzles.map((n) => n._id)));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(t("nozzles.deleteConfirm", { name }))) return;
    const res = await fetch(`/api/nozzles/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("nozzles.deleteError"), "error");
      return;
    }
    toast(t("nozzles.deleted", { name }));
    fetchNozzles();
  };

  const handleBulkDelete = async () => {
    const count = selected.size;
    if (!confirm(t("nozzles.bulkDeleteConfirm", { count }))) return;
    setBulkDeleting(true);
    let deleted = 0;
    const errors: string[] = [];
    for (const id of selected) {
      const res = await fetch(`/api/nozzles/${id}`, { method: "DELETE" });
      if (res.ok) {
        deleted++;
      } else {
        const body = await res.json().catch(() => null);
        const name = nozzles.find((n) => n._id === id)?.name ?? id;
        errors.push(body?.error || t("nozzles.deleteErrorNamed", { name }));
      }
    }
    if (deleted > 0) toast(t("nozzles.bulkDeleted", { count: deleted }));
    if (errors.length > 0) toast(errors.join("; "), "error");
    setBulkDeleting(false);
    fetchNozzles();
  };

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">{t("nozzles.title")}</h1>
          <Link href="/" className="text-blue-600 hover:underline text-sm">
            &larr; {t("nozzles.backToFilaments")}
          </Link>
        </div>
        <Link
          href="/nozzles/new"
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          {t("nozzles.addNew")}
        </Link>
      </div>

      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-3 px-3 py-2 bg-red-950/30 border border-red-800 rounded-lg">
          <span className="text-sm text-red-300">{t("nozzles.selected", { count: selected.size })}</span>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="px-3 py-1 bg-red-700 text-white rounded text-sm hover:bg-red-600 disabled:opacity-50"
          >
            {bulkDeleting ? t("nozzles.deleting") : t("nozzles.deleteCount", { count: selected.size })}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-gray-400 hover:text-gray-200"
          >
            {t("nozzles.clear")}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">{t("nozzles.loading")}</p>
      ) : nozzles.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">{t("nozzles.empty")}</p>
          <Link href="/nozzles/new" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm">
            {t("nozzles.addFirst")}
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
                    checked={selected.size === nozzles.length && nozzles.length > 0}
                    onChange={toggleAll}
                    className="accent-red-600"
                  />
                </th>
                <th className="text-left py-3 px-2">{t("nozzles.table.name")}</th>
                <th className="text-right py-3 px-2">{t("nozzles.table.diameter")}</th>
                <th className="text-left py-3 px-2">{t("nozzles.table.type")}</th>
                <th className="text-center py-3 px-2">{t("nozzles.table.highFlow")}</th>
                <th className="text-center py-3 px-2">{t("nozzles.table.hardened")}</th>
                <th className="text-left py-3 px-2">{t("nozzles.table.notes")}</th>
                <th className="text-right py-3 px-2">{t("nozzles.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {nozzles.map((n) => (
                <tr
                  key={n._id}
                  className={`border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 ${selected.has(n._id) ? "bg-red-950/20" : ""}`}
                >
                  <td className="py-2 px-2">
                    <input
                      type="checkbox"
                      checked={selected.has(n._id)}
                      onChange={() => toggleSelect(n._id)}
                      className="accent-red-600"
                    />
                  </td>
                  <td className="py-2 px-2 font-medium">{n.name}</td>
                  <td className="py-2 px-2 text-right">{n.diameter}mm</td>
                  <td className="py-2 px-2">
                    <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-800 rounded text-xs">
                      {n.type}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-center">
                    {n.highFlow ? (
                      <span className="px-2 py-0.5 bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 rounded text-xs">
                        {t("nozzles.table.hfBadge")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 px-2 text-center">
                    {n.hardened ? (
                      <span className="px-2 py-0.5 bg-blue-200 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded text-xs">
                        {t("nozzles.table.hBadge")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 px-2 text-gray-500 text-xs">{n.notes || "—"}</td>
                  <td className="py-2 px-2 text-right">
                    <Link
                      href={`/nozzles/${n._id}/edit`}
                      className="text-blue-600 hover:underline mr-3 text-xs"
                    >
                      {t("nozzles.table.edit")}
                    </Link>
                    <button
                      onClick={() => handleDelete(n._id, n.name)}
                      className="text-red-600 hover:underline text-xs"
                    >
                      {t("nozzles.table.delete")}
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

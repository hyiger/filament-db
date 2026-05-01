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
}

interface Printer {
  _id: string;
  name: string;
  manufacturer: string;
  printerModel: string;
  installedNozzles: Nozzle[];
  notes: string;
}

export default function PrintersPage() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const { toast } = useToast();
  const { t } = useTranslation();

  const fetchPrinters = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch("/api/printers", { signal });
      if (!res.ok) {
        toast(t("printers.loadError"), "error");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setPrinters(data);
      setSelected(new Set());
      setLoading(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast(t("printers.loadError"), "error");
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => {
    const ac = new AbortController();
    fetchPrinters(ac.signal); // eslint-disable-line react-hooks/set-state-in-effect -- data fetching on mount
    return () => ac.abort();
  }, [fetchPrinters]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === printers.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(printers.map((p) => p._id)));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(t("printers.deleteConfirm", { name }))) return;
    const res = await fetch(`/api/printers/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("printers.deleteError"), "error");
      return;
    }
    toast(t("printers.deleted", { name }));
    fetchPrinters();
  };

  const handleBulkDelete = async () => {
    const count = selected.size;
    if (!confirm(t("printers.bulkDeleteConfirm", { count }))) return;
    setBulkDeleting(true);
    let deleted = 0;
    const errors: string[] = [];
    for (const id of selected) {
      const res = await fetch(`/api/printers/${id}`, { method: "DELETE" });
      if (res.ok) {
        deleted++;
      } else {
        const body = await res.json().catch(() => null);
        const name = printers.find((p) => p._id === id)?.name ?? id;
        errors.push(body?.error || t("printers.deleteErrorNamed", { name }));
      }
    }
    if (deleted > 0) toast(t("printers.bulkDeleted", { count: deleted }));
    if (errors.length > 0) toast(errors.join("; "), "error");
    setBulkDeleting(false);
    fetchPrinters();
  };

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">{t("printers.title")}</h1>
          <div className="flex gap-3">
            <Link href="/settings" className="text-blue-600 hover:underline text-sm">
              &larr; {t("printers.backToSettings")}
            </Link>
          </div>
        </div>
        <Link
          href="/printers/new"
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          {t("printers.addNew")}
        </Link>
      </div>

      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-3 px-3 py-2 bg-red-950/30 border border-red-800 rounded-lg">
          <span className="text-sm text-red-300">{t("printers.selected", { count: selected.size })}</span>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="px-3 py-1 bg-red-700 text-white rounded text-sm hover:bg-red-600 disabled:opacity-50"
          >
            {bulkDeleting ? t("printers.deleting") : t("printers.deleteCount", { count: selected.size })}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-gray-400 hover:text-gray-200"
          >
            {t("printers.clear")}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">{t("printers.loading")}</p>
      ) : printers.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">{t("printers.empty")}</p>
          <Link href="/printers/new" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm">
            {t("printers.addFirst")}
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
                    checked={selected.size === printers.length && printers.length > 0}
                    onChange={toggleAll}
                    aria-label={t("printers.bulk.selectAll") || "Select all"}
                    className="accent-red-600"
                  />
                </th>
                <th className="text-left py-3 px-2">{t("printers.table.name")}</th>
                <th className="text-left py-3 px-2">{t("printers.table.manufacturer")}</th>
                <th className="text-left py-3 px-2">{t("printers.table.model")}</th>
                <th className="text-left py-3 px-2">{t("printers.table.nozzles")}</th>
                <th className="text-left py-3 px-2">{t("printers.table.notes")}</th>
                <th className="text-right py-3 px-2">{t("printers.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {printers.map((p) => (
                <tr
                  key={p._id}
                  className={`border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 ${selected.has(p._id) ? "bg-red-950/20" : ""}`}
                >
                  <td className="py-2 px-2">
                    <input
                      type="checkbox"
                      checked={selected.has(p._id)}
                      onChange={() => toggleSelect(p._id)}
                      aria-label={p.name || "Select"}
                      className="accent-red-600"
                    />
                  </td>
                  <td className="py-2 px-2 font-medium">{p.name}</td>
                  <td className="py-2 px-2">{p.manufacturer}</td>
                  <td className="py-2 px-2">{p.printerModel}</td>
                  <td className="py-2 px-2">
                    {p.installedNozzles.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {p.installedNozzles.map((n) => (
                          <span
                            key={n._id}
                            className="px-2 py-0.5 bg-gray-200 dark:bg-gray-800 rounded text-xs"
                          >
                            {n.diameter}mm {n.type}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-500 text-xs">{t("printers.table.none")}</span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-gray-500 text-xs">{p.notes || "—"}</td>
                  <td className="py-2 px-2 text-right whitespace-nowrap">
                    <Link
                      href={`/printers/${p._id}/edit`}
                      className="text-blue-600 hover:underline mr-3 text-xs"
                    >
                      {t("printers.table.edit")}
                    </Link>
                    <button
                      onClick={() => handleDelete(p._id, p.name)}
                      className="text-red-600 hover:underline text-xs"
                    >
                      {t("printers.table.delete")}
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

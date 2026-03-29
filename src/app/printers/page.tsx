"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";

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
  const { toast } = useToast();

  const fetchPrinters = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/printers");
    if (!res.ok) {
      toast("Failed to load printers", "error");
      setLoading(false);
      return;
    }
    const data = await res.json();
    setPrinters(data);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchPrinters();
  }, [fetchPrinters]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete printer "${name}"?`)) return;
    const res = await fetch(`/api/printers/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast(body?.error || "Failed to delete printer", "error");
      return;
    }
    toast(`Deleted "${name}"`);
    fetchPrinters();
  };

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Printers</h1>
          <Link href="/" className="text-blue-600 hover:underline text-sm">
            &larr; Back to filaments
          </Link>
        </div>
        <Link
          href="/printers/new"
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          + Add Printer
        </Link>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : printers.length === 0 ? (
        <p className="text-gray-500">No printers defined yet. Add a printer to start tracking per-printer calibrations.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-300">
                <th className="text-left py-3 px-2">Name</th>
                <th className="text-left py-3 px-2">Manufacturer</th>
                <th className="text-left py-3 px-2">Model</th>
                <th className="text-left py-3 px-2">Nozzles</th>
                <th className="text-left py-3 px-2">Notes</th>
                <th className="text-right py-3 px-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {printers.map((p) => (
                <tr
                  key={p._id}
                  className="border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
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
                      <span className="text-gray-500 text-xs">None</span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-gray-500 text-xs">{p.notes || "—"}</td>
                  <td className="py-2 px-2 text-right whitespace-nowrap">
                    <Link
                      href={`/printers/${p._id}/edit`}
                      className="text-blue-600 hover:underline mr-3 text-xs"
                    >
                      Edit
                    </Link>
                    <button
                      onClick={() => handleDelete(p._id, p.name)}
                      className="text-red-600 hover:underline text-xs"
                    >
                      Delete
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

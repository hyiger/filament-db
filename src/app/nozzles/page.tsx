"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";

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
  const { toast } = useToast();

  const fetchNozzles = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/nozzles");
    if (!res.ok) {
      toast("Failed to load nozzles", "error");
      setLoading(false);
      return;
    }
    const data = await res.json();
    setNozzles(data);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchNozzles();
  }, [fetchNozzles]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete nozzle "${name}"?`)) return;
    const res = await fetch(`/api/nozzles/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast(body?.error || "Failed to delete nozzle", "error");
      return;
    }
    toast(`Deleted "${name}"`);
    fetchNozzles();
  };

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Nozzles</h1>
          <Link href="/" className="text-blue-600 hover:underline text-sm">
            &larr; Back to filaments
          </Link>
        </div>
        <Link
          href="/nozzles/new"
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          + Add Nozzle
        </Link>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : nozzles.length === 0 ? (
        <p className="text-gray-500">No nozzles defined yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-300">
                <th className="text-left py-3 px-2">Name</th>
                <th className="text-right py-3 px-2">Diameter</th>
                <th className="text-left py-3 px-2">Type</th>
                <th className="text-center py-3 px-2">High Flow</th>
                <th className="text-center py-3 px-2">Hardened</th>
                <th className="text-left py-3 px-2">Notes</th>
                <th className="text-right py-3 px-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {nozzles.map((n) => (
                <tr
                  key={n._id}
                  className="border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
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
                        HF
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 px-2 text-center">
                    {n.hardened ? (
                      <span className="px-2 py-0.5 bg-blue-200 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded text-xs">
                        H
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
                      Edit
                    </Link>
                    <button
                      onClick={() => handleDelete(n._id, n.name)}
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

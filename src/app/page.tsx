"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";

interface Filament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
  cost: number | null;
  density: number | null;
  temperatures: {
    nozzle: number | null;
    bed: number | null;
  };
}

type SortKey = "name" | "vendor" | "type" | "nozzle" | "bed" | "cost";
type SortDir = "asc" | "desc";

function getSortValue(f: Filament, key: SortKey): string | number {
  switch (key) {
    case "name":
      return f.name.toLowerCase();
    case "vendor":
      return f.vendor.toLowerCase();
    case "type":
      return f.type.toLowerCase();
    case "nozzle":
      return f.temperatures.nozzle ?? -1;
    case "bed":
      return f.temperatures.bed ?? -1;
    case "cost":
      return f.cost ?? -1;
  }
}

function SortIcon({ column, sortKey, sortDir }: { column: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  const isActive = column === sortKey;
  return (
    <span className="inline-flex flex-col ml-1 leading-none -mb-0.5">
      <span className={`text-[10px] leading-none ${isActive && sortDir === "asc" ? "text-blue-500" : "text-gray-400"}`}>&#9650;</span>
      <span className={`text-[10px] leading-none ${isActive && sortDir === "desc" ? "text-blue-500" : "text-gray-400"}`}>&#9660;</span>
    </span>
  );
}

export default function Home() {
  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [importing, setImporting] = useState(false);
  const [mounted, setMounted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchFilaments = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (typeFilter) params.set("type", typeFilter);
    if (vendorFilter) params.set("vendor", vendorFilter);

    const res = await fetch(`/api/filaments?${params}`);
    const data = await res.json();
    setFilaments(data);
    setLoading(false);
  }, [search, typeFilter, vendorFilter]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    fetch("/api/filaments")
      .then((r) => r.json())
      .then((data: Filament[]) => {
        const t = [...new Set(data.map((f) => f.type))].sort();
        const v = [...new Set(data.map((f) => f.vendor))].sort();
        setTypes(t);
        setVendors(v);
      });
  }, []);

  useEffect(() => {
    fetchFilaments();
  }, [fetchFilaments]);

  const sortedFilaments = useMemo(() => {
    const sorted = [...filaments].sort((a, b) => {
      const aVal = getSortValue(a, sortKey);
      const bVal = getSortValue(b, sortKey);
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [filaments, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    await fetch(`/api/filaments/${id}`, { method: "DELETE" });
    fetchFilaments();
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/filaments/import", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message);
        fetchFilaments();
        // Re-fetch filter options
        const allRes = await fetch("/api/filaments");
        const allData = await allRes.json();
        setTypes([...new Set(allData.map((f: Filament) => f.type))].sort() as string[]);
        setVendors([...new Set(allData.map((f: Filament) => f.vendor))].sort() as string[]);
      } else {
        alert(`Import failed: ${data.error}`);
      }
    } catch {
      alert("Import failed: network error");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const thClass = "py-3 px-2 cursor-pointer select-none hover:text-blue-500 transition-colors";

  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      {mounted && (
        <input
          ref={fileInputRef}
          type="file"
          accept=".ini"
          onChange={handleImport}
          className="hidden"
        />
      )}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Filament DB</h1>
          <Link href="/nozzles" className="text-blue-600 hover:underline text-sm">
            Manage Nozzles
          </Link>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 text-sm"
          >
            {importing ? "Importing..." : "Import INI"}
          </button>
          <a
            href="/api/filaments/export"
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
          >
            Export INI
          </a>
          <Link
            href="/filaments/new"
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            + Add Filament
          </Link>
        </div>
      </div>

      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Search by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm bg-transparent"
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm bg-transparent"
        >
          <option value="">All Types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={vendorFilter}
          onChange={(e) => setVendorFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm bg-transparent"
        >
          <option value="">All Vendors</option>
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : filaments.length === 0 ? (
        <p className="text-gray-500">No filaments found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-300">
                <th className="text-left py-3 px-2">Color</th>
                <th className={`text-left ${thClass}`} onClick={() => handleSort("name")}>
                  Name <SortIcon column="name" sortKey={sortKey} sortDir={sortDir} />
                </th>
                <th className={`text-left ${thClass}`} onClick={() => handleSort("vendor")}>
                  Vendor <SortIcon column="vendor" sortKey={sortKey} sortDir={sortDir} />
                </th>
                <th className={`text-left ${thClass}`} onClick={() => handleSort("type")}>
                  Type <SortIcon column="type" sortKey={sortKey} sortDir={sortDir} />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("nozzle")}>
                  Nozzle <SortIcon column="nozzle" sortKey={sortKey} sortDir={sortDir} />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("bed")}>
                  Bed <SortIcon column="bed" sortKey={sortKey} sortDir={sortDir} />
                </th>
                <th className={`text-right ${thClass}`} onClick={() => handleSort("cost")}>
                  Cost <SortIcon column="cost" sortKey={sortKey} sortDir={sortDir} />
                </th>
                <th className="text-right py-3 px-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedFilaments.map((f) => (
                <tr
                  key={f._id}
                  className="border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <td className="py-2 px-2">
                    <div
                      className="w-6 h-6 rounded-full border border-gray-300"
                      style={{ backgroundColor: f.color }}
                      title={f.color}
                    />
                  </td>
                  <td className="py-2 px-2">
                    <Link
                      href={`/filaments/${f._id}`}
                      className="text-blue-600 hover:underline"
                    >
                      {f.name}
                    </Link>
                  </td>
                  <td className="py-2 px-2">{f.vendor}</td>
                  <td className="py-2 px-2">
                    <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-800 rounded text-xs">
                      {f.type}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right">
                    {f.temperatures.nozzle ? `${f.temperatures.nozzle}°C` : "—"}
                  </td>
                  <td className="py-2 px-2 text-right">
                    {f.temperatures.bed ? `${f.temperatures.bed}°C` : "—"}
                  </td>
                  <td className="py-2 px-2 text-right">
                    {f.cost != null ? `$${f.cost.toFixed(2)}` : "—"}
                  </td>
                  <td className="py-2 px-2 text-right">
                    <Link
                      href={`/filaments/${f._id}/edit`}
                      className="text-blue-600 hover:underline mr-3 text-xs"
                    >
                      Edit
                    </Link>
                    <button
                      onClick={() => handleDelete(f._id, f.name)}
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

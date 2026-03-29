"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import ImportAtlasDialog from "@/components/ImportAtlasDialog";
import SyncStatusIndicator from "@/components/SyncStatusIndicator";

interface Filament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
  cost: number | null;
  density: number | null;
  parentId: string | null;
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  totalWeight: number | null;
  temperatures: {
    nozzle: number | null;
    bed: number | null;
  };
}

function getRemainingPct(f: Filament): number | null {
  if (f.totalWeight == null || f.spoolWeight == null || f.netFilamentWeight == null || f.netFilamentWeight <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(((f.totalWeight - f.spoolWeight) / f.netFilamentWeight) * 100)));
}

type SortKey = "name" | "vendor" | "type" | "nozzle" | "bed" | "cost" | "remaining";
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
    case "remaining":
      return getRemainingPct(f) ?? -1;
  }
}

function SortIcon({ column, sortKey, sortDir }: { column: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  const isActive = column === sortKey;
  return (
    <span className="inline-flex flex-col ml-1 leading-none -mb-0.5" aria-hidden="true">
      <span className={`text-xs leading-none ${isActive && sortDir === "asc" ? "text-blue-500" : "text-gray-400"}`}>&#9650;</span>
      <span className={`text-xs leading-none ${isActive && sortDir === "desc" ? "text-blue-500" : "text-gray-400"}`}>&#9660;</span>
    </span>
  );
}

interface GroupedFilament {
  parent: Filament;
  variants: Filament[];
}

function FilamentStats({ filaments }: { filaments: Filament[] }) {
  const byType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of filaments) {
      counts.set(f.type, (counts.get(f.type) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [filaments]);

  const byVendor = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of filaments) {
      counts.set(f.vendor, (counts.get(f.vendor) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [filaments]);

  const colorGroups = useMemo(() => {
    const counts = new Map<string, { color: string; count: number }>();
    for (const f of filaments) {
      const hex = (f.color || "#808080").toLowerCase();
      const existing = counts.get(hex);
      if (existing) {
        existing.count++;
      } else {
        counts.set(hex, { color: hex, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [filaments]);

  const maxType = byType.length > 0 ? byType[0][1] : 1;
  const maxVendor = byVendor.length > 0 ? byVendor[0][1] : 1;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-800">
      {/* By Type */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">By Type</h3>
        <div className="space-y-1.5">
          {byType.map(([type, count]) => (
            <div key={type} className="flex items-center gap-2 text-sm">
              <span className="w-16 truncate text-gray-300 font-medium">{type}</span>
              <div className="flex-1 bg-gray-200 dark:bg-gray-800 rounded-full h-3">
                <div
                  className="h-3 rounded-full bg-blue-500"
                  style={{ width: `${(count / maxType) * 100}%` }}
                />
              </div>
              <span className="text-xs text-gray-500 w-6 text-right">{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* By Vendor */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">By Vendor</h3>
        <div className="space-y-1.5">
          {byVendor.map(([vendor, count]) => (
            <div key={vendor} className="flex items-center gap-2 text-sm">
              <span className="w-24 truncate text-gray-300 font-medium">{vendor}</span>
              <div className="flex-1 bg-gray-200 dark:bg-gray-800 rounded-full h-3">
                <div
                  className="h-3 rounded-full bg-amber-500"
                  style={{ width: `${(count / maxVendor) * 100}%` }}
                />
              </div>
              <span className="text-xs text-gray-500 w-6 text-right">{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* By Color */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Colors ({colorGroups.length})
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {colorGroups.map(({ color, count }) => (
            <div
              key={color}
              className="relative group"
              title={`${color} (${count})`}
            >
              <div
                className="w-6 h-6 rounded-full border border-gray-400 dark:border-gray-600"
                style={{ backgroundColor: color }}
              />
              {count > 1 && (
                <span className="absolute -top-1.5 -right-1.5 bg-gray-700 text-white text-[9px] w-3.5 h-3.5 rounded-full flex items-center justify-center leading-none">
                  {count}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
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
  const [showStats, setShowStats] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [importing, setImporting] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [showAtlasImport, setShowAtlasImport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const fetchFilaments = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (typeFilter) params.set("type", typeFilter);
    if (vendorFilter) params.set("vendor", vendorFilter);

    const res = await fetch(`/api/filaments?${params}`);
    if (!res.ok) {
      toast("Failed to load filaments", "error");
      setLoading(false);
      return;
    }
    const data = await res.json();
    setFilaments(data);
    setLoading(false);
  }, [search, typeFilter, vendorFilter]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    fetch("/api/filaments")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to fetch");
        return r.json();
      })
      .then((data: Filament[]) => {
        const t = [...new Set(data.map((f) => f.type))].sort();
        const v = [...new Set(data.map((f) => f.vendor))].sort();
        setTypes(t);
        setVendors(v);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchFilaments();
  }, [fetchFilaments]);

  // Group filaments: parents with their variants, standalone filaments as-is
  const groupedFilaments = useMemo(() => {
    const parentMap = new Map<string, GroupedFilament>();
    const standalone: Filament[] = [];
    const variantsByParent = new Map<string, Filament[]>();

    // First pass: collect variants
    for (const f of filaments) {
      if (f.parentId) {
        const variants = variantsByParent.get(f.parentId) || [];
        variants.push(f);
        variantsByParent.set(f.parentId, variants);
      }
    }

    // Second pass: build groups, resolving inherited fields for variants
    for (const f of filaments) {
      if (f.parentId) continue; // variants are handled by their parent
      const variants = (variantsByParent.get(f._id) || []).map((v) => ({
        ...v,
        temperatures: {
          nozzle: v.temperatures?.nozzle ?? f.temperatures?.nozzle,
          bed: v.temperatures?.bed ?? f.temperatures?.bed,
        },
        cost: v.cost ?? f.cost,
        density: v.density ?? f.density,
        spoolWeight: v.spoolWeight ?? f.spoolWeight,
        netFilamentWeight: v.netFilamentWeight ?? f.netFilamentWeight,
      }));
      if (variants.length > 0) {
        parentMap.set(f._id, { parent: f, variants });
      } else {
        standalone.push(f);
      }
    }

    // Also include orphaned variants (parent not in current filter results)
    for (const [parentId, variants] of variantsByParent) {
      if (!parentMap.has(parentId)) {
        // Parent wasn't in the results — show variants as standalone
        standalone.push(...variants);
      }
    }

    // Combine and sort
    const all: (Filament | GroupedFilament)[] = [
      ...parentMap.values(),
      ...standalone.map((f) => f),
    ];

    all.sort((a, b) => {
      const fa = "parent" in a ? a.parent : a;
      const fb = "parent" in b ? b.parent : b;
      const aVal = getSortValue(fa, sortKey);
      const bVal = getSortValue(fb, sortKey);
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return all;
  }, [filaments, sortKey, sortDir]);

  const toggleExpanded = (parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  };

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
    const res = await fetch(`/api/filaments/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      toast(data?.error || "Delete failed", "error");
      return;
    }
    toast(`Deleted "${name}"`);
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
        toast(data.message);
        fetchFilaments();
        const allRes = await fetch("/api/filaments");
        const allData = await allRes.json();
        setTypes([...new Set(allData.map((f: Filament) => f.type))].sort() as string[]);
        setVendors([...new Set(allData.map((f: Filament) => f.vendor))].sort() as string[]);
      } else {
        toast(`Import failed: ${data.error}`, "error");
      }
    } catch {
      toast("Import failed: network error", "error");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const thClass = "py-3 px-2 cursor-pointer select-none hover:text-blue-500 transition-colors";

  const renderRow = (f: Filament, isVariant = false) => (
    <tr
      key={f._id}
      className={`border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 ${isVariant ? "bg-gray-50/50 dark:bg-gray-950/50" : ""}`}
    >
      <td className="py-2 px-2">
        <div className="flex items-center gap-1">
          {isVariant && <span className="text-gray-400 text-xs ml-2">&#8627;</span>}
          <div
            className={`${isVariant ? "w-5 h-5" : "w-6 h-6"} rounded-full border border-gray-300`}
            style={{ backgroundColor: f.color }}
            title={f.color}
          />
        </div>
      </td>
      <td className="py-2 px-2">
        <Link
          href={`/filaments/${f._id}`}
          className="text-blue-600 hover:underline"
        >
          {f.name}
        </Link>
        {isVariant && (
          <span className="ml-1.5 text-[10px] text-gray-400 bg-gray-200 dark:bg-gray-800 px-1 py-0.5 rounded">
            variant
          </span>
        )}
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
        {(() => {
          const pct = getRemainingPct(f);
          if (pct == null) return <span className="text-gray-400">—</span>;
          const color = pct > 25 ? "bg-green-500" : pct > 10 ? "bg-yellow-500" : "bg-red-500";
          return (
            <div className="flex items-center gap-1.5 justify-end" title={`${pct}% remaining`}>
              <div className="w-12 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
            </div>
          );
        })()}
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
  );

  const renderParentRow = (group: GroupedFilament) => {
    const f = group.parent;
    const isExpanded = expandedParents.has(f._id);
    return (
      <>
        <tr
          key={f._id}
          className="border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900"
        >
          <td className="py-2 px-2">
            <div className="flex items-center gap-1">
              <button
                onClick={() => toggleExpanded(f._id)}
                className="text-gray-400 hover:text-gray-600 text-xs w-4 flex-shrink-0"
                title={isExpanded ? "Collapse variants" : "Expand variants"}
              >
                {isExpanded ? "▾" : "▸"}
              </button>
              <div
                className="w-6 h-6 rounded-full border border-gray-300"
                style={{ backgroundColor: f.color }}
                title={f.color}
              />
            </div>
          </td>
          <td className="py-2 px-2">
            <Link
              href={`/filaments/${f._id}`}
              className="text-blue-600 hover:underline"
            >
              {f.name}
            </Link>
            <span className="ml-1.5 text-[10px] text-gray-500 bg-gray-200 dark:bg-gray-800 px-1 py-0.5 rounded">
              {group.variants.length} color{group.variants.length !== 1 ? "s" : ""}
            </span>
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
            {(() => {
              const pct = getRemainingPct(f);
              if (pct == null) return <span className="text-gray-400">—</span>;
              const color = pct > 25 ? "bg-green-500" : pct > 10 ? "bg-yellow-500" : "bg-red-500";
              return (
                <div className="flex items-center gap-1.5 justify-end" title={`${pct}% remaining`}>
                  <div className="w-12 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-gray-500 w-8 text-right">{pct}%</span>
                </div>
              );
            })()}
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
        {isExpanded && group.variants.map((v) => renderRow(v, true))}
        {!isExpanded && (
          <tr key={`${f._id}-colors`} className="border-b border-gray-200">
            <td colSpan={9} className="py-1 px-2 pl-10">
              <div className="flex items-center gap-1.5">
                {group.variants.map((v) => (
                  <Link
                    key={v._id}
                    href={`/filaments/${v._id}`}
                    title={v.name}
                  >
                    <div
                      className="w-4 h-4 rounded-full border border-gray-400 hover:ring-2 hover:ring-blue-400 transition-all"
                      style={{ backgroundColor: v.color }}
                    />
                  </Link>
                ))}
              </div>
            </td>
          </tr>
        )}
      </>
    );
  };

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
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">Filament DB</h1>
            <SyncStatusIndicator />
          </div>
          <div className="flex gap-3">
            <Link href="/nozzles" className="text-blue-600 hover:underline text-sm">
              Manage Nozzles
            </Link>
            <Link href="/printers" className="text-blue-600 hover:underline text-sm">
              Manage Printers
            </Link>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAtlasImport(true)}
            className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 text-sm"
          >
            Import from Atlas
          </button>
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

      {/* Statistics summary */}
      {filaments.length > 0 && (
        <div className="mb-4">
          <button
            onClick={() => setShowStats((s) => !s)}
            className="text-sm text-gray-500 hover:text-gray-300 flex items-center gap-1 mb-2"
          >
            <span>{showStats ? "▾" : "▸"}</span>
            <span>{filaments.length} filament{filaments.length !== 1 ? "s" : ""}</span>
            <span className="text-gray-600">·</span>
            <span>{types.length} type{types.length !== 1 ? "s" : ""}</span>
            <span className="text-gray-600">·</span>
            <span>{vendors.length} vendor{vendors.length !== 1 ? "s" : ""}</span>
          </button>
          {showStats && <FilamentStats filaments={filaments} />}
        </div>
      )}

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
                {(["name", "vendor", "type", "nozzle", "bed", "cost", "remaining"] as SortKey[]).map((col) => (
                  <th
                    key={col}
                    className={`${["nozzle", "bed", "cost", "remaining"].includes(col) ? "text-right" : "text-left"} ${thClass}`}
                    onClick={() => handleSort(col)}
                    role="columnheader"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSort(col); } }}
                    title={`Sort by ${col === "nozzle" ? "nozzle temp" : col === "bed" ? "bed temp" : col === "remaining" ? "remaining filament" : col}`}
                    aria-sort={sortKey === col ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    {col === "nozzle" ? "Nozzle" : col === "bed" ? "Bed" : col === "remaining" ? "Spool" : col.charAt(0).toUpperCase() + col.slice(1)}{" "}
                    <SortIcon column={col} sortKey={sortKey} sortDir={sortDir} />
                  </th>
                ))}
                <th className="text-right py-3 px-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groupedFilaments.map((item) => {
                if ("parent" in item) {
                  return <React.Fragment key={item.parent._id}>{renderParentRow(item)}</React.Fragment>;
                }
                return renderRow(item);
              })}
            </tbody>
          </table>
        </div>
      )}

      {showAtlasImport && (
        <ImportAtlasDialog
          onClose={() => setShowAtlasImport(false)}
          onImported={(message) => {
            toast(message, "success");
            fetchFilaments();
            setShowAtlasImport(false);
          }}
        />
      )}
    </main>
  );
}

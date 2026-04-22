"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useCurrency } from "@/hooks/useCurrency";

interface FilamentOption {
  _id: string;
  name: string;
  vendor: string;
  color: string;
  type: string;
}

interface CompareFilament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
  colorName: string | null;
  cost: number | null;
  density: number | null;
  diameter: number;
  maxVolumetricSpeed: number | null;
  temperatures: {
    nozzle: number | null;
    nozzleFirstLayer: number | null;
    bed: number | null;
    bedFirstLayer: number | null;
  };
  dryingTemperature: number | null;
  dryingTime: number | null;
  glassTempTransition: number | null;
  heatDeflectionTemp: number | null;
  shoreHardnessA: number | null;
  shoreHardnessD: number | null;
  minPrintSpeed: number | null;
  maxPrintSpeed: number | null;
  spools: { totalWeight: number | null; retired?: boolean }[];
}

export default function ComparePage() {
  return (
    <Suspense fallback={<main className="p-8"><p className="text-gray-500">Loading…</p></main>}>
      <ComparePageInner />
    </Suspense>
  );
}

function ComparePageInner() {
  const { t } = useTranslation();
  const { symbol: currencySymbol } = useCurrency();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialIds = (searchParams.get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const [allFilaments, setAllFilaments] = useState<FilamentOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(initialIds);
  const [comparison, setComparison] = useState<CompareFilament[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/filaments", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setAllFilaments)
      .catch(() => {});
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (selectedIds.length === 0) {
      setComparison([]);
      return;
    }
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch lifecycle state
    setLoading(true);
    fetch(`/api/filaments/compare?ids=${selectedIds.join(",")}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        setComparison(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => ac.abort();
  }, [selectedIds]);

  // Keep the URL in sync so the page is linkable/shareable.
  useEffect(() => {
    const qs = selectedIds.length > 0 ? `?ids=${selectedIds.join(",")}` : "";
    router.replace(`/compare${qs}`, { scroll: false });
  }, [selectedIds, router]);

  const toggleFilament = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 8) return prev; // API limit
      return [...prev, id];
    });
  };

  const totalGrams = useMemo(() => {
    return comparison.map((f) => {
      let grams = 0;
      for (const s of f.spools || []) {
        if (s.retired) continue;
        if (typeof s.totalWeight === "number") grams += s.totalWeight;
      }
      return grams;
    });
  }, [comparison]);

  const rows: { label: string; get: (f: CompareFilament, i: number) => string }[] = [
    { label: t("compare.row.vendor"), get: (f) => f.vendor },
    { label: t("compare.row.type"), get: (f) => f.type },
    {
      label: t("compare.row.color"),
      get: (f) => (f.colorName ? `${f.colorName} (${f.color})` : f.color),
    },
    {
      label: t("compare.row.cost"),
      get: (f) => (f.cost != null ? `${currencySymbol}${f.cost.toFixed(2)}` : "—"),
    },
    { label: t("compare.row.diameter"), get: (f) => `${f.diameter} mm` },
    {
      label: t("compare.row.density"),
      get: (f) => (f.density != null ? `${f.density} g/cm³` : "—"),
    },
    {
      label: t("compare.row.costPerKg"),
      get: (f) => {
        if (f.cost == null || f.density == null) return "—";
        // rough cost/kg assuming 1kg spool
        return `${currencySymbol}${f.cost.toFixed(2)}/kg`;
      },
    },
    {
      label: t("compare.row.nozzleTemp"),
      get: (f) => (f.temperatures.nozzle != null ? `${f.temperatures.nozzle}°C` : "—"),
    },
    {
      label: t("compare.row.bedTemp"),
      get: (f) => (f.temperatures.bed != null ? `${f.temperatures.bed}°C` : "—"),
    },
    {
      label: t("compare.row.maxVolumetricSpeed"),
      get: (f) =>
        f.maxVolumetricSpeed != null ? `${f.maxVolumetricSpeed} mm³/s` : "—",
    },
    {
      label: t("compare.row.dryingTemperature"),
      get: (f) => (f.dryingTemperature != null ? `${f.dryingTemperature}°C` : "—"),
    },
    {
      label: t("compare.row.dryingTime"),
      get: (f) => (f.dryingTime != null ? `${f.dryingTime} h` : "—"),
    },
    {
      label: t("compare.row.glassTemp"),
      get: (f) =>
        f.glassTempTransition != null ? `${f.glassTempTransition}°C` : "—",
    },
    {
      label: t("compare.row.hdt"),
      get: (f) => (f.heatDeflectionTemp != null ? `${f.heatDeflectionTemp}°C` : "—"),
    },
    {
      label: t("compare.row.shore"),
      get: (f) => {
        const parts: string[] = [];
        if (f.shoreHardnessA != null) parts.push(`A${f.shoreHardnessA}`);
        if (f.shoreHardnessD != null) parts.push(`D${f.shoreHardnessD}`);
        return parts.length > 0 ? parts.join(" / ") : "—";
      },
    },
    {
      label: t("compare.row.printSpeed"),
      get: (f) => {
        if (f.minPrintSpeed != null && f.maxPrintSpeed != null)
          return `${f.minPrintSpeed}–${f.maxPrintSpeed} mm/s`;
        if (f.maxPrintSpeed != null) return `≤ ${f.maxPrintSpeed} mm/s`;
        if (f.minPrintSpeed != null) return `≥ ${f.minPrintSpeed} mm/s`;
        return "—";
      },
    },
    {
      label: t("compare.row.onHand"),
      get: (_f, i) => (totalGrams[i] > 0 ? `${Math.round(totalGrams[i])} g` : "—"),
    },
  ];

  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; {t("compare.backToFilaments")}
        </Link>
      </div>
      <h1 className="text-3xl font-bold mb-2">{t("compare.title")}</h1>
      <p className="text-sm text-gray-500 mb-6">{t("compare.subtitle")}</p>

      {/* Selector */}
      <section className="mb-8">
        <h2 className="text-sm font-medium mb-2">
          {t("compare.selectPrompt", { count: selectedIds.length, max: 8 })}
        </h2>
        <div className="max-h-60 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded">
          {allFilaments.map((f) => (
            <label
              key={f._id}
              className="flex items-center gap-3 px-3 py-2 border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer text-sm"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(f._id)}
                onChange={() => toggleFilament(f._id)}
                className="w-4 h-4"
                disabled={!selectedIds.includes(f._id) && selectedIds.length >= 8}
              />
              <span
                className="inline-block w-4 h-4 rounded-full border border-gray-300"
                style={{ backgroundColor: f.color }}
                aria-hidden="true"
              />
              <span className="flex-1 min-w-0 truncate">{f.name}</span>
              <span className="text-xs text-gray-500">
                {f.vendor} · {f.type}
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* Comparison grid */}
      {loading && selectedIds.length > 0 && (
        <p className="text-sm text-gray-500">{t("common.loading")}</p>
      )}
      {!loading && comparison.length === 0 && selectedIds.length === 0 && (
        <p className="text-sm text-gray-500">{t("compare.emptyState")}</p>
      )}

      {comparison.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-300 dark:border-gray-700">
                <th className="text-left py-2 px-2 font-medium text-gray-500 sticky left-0 bg-white dark:bg-gray-950 z-10">
                  {t("compare.col.property")}
                </th>
                {comparison.map((f) => (
                  <th
                    key={f._id}
                    className="text-left py-2 px-3 font-medium min-w-[160px]"
                  >
                    <Link
                      href={`/filaments/${f._id}`}
                      className="text-blue-600 hover:underline flex items-center gap-2"
                    >
                      <span
                        className="inline-block w-4 h-4 rounded-full border border-gray-300 flex-shrink-0"
                        style={{ backgroundColor: f.color }}
                        aria-hidden="true"
                      />
                      <span className="truncate">{f.name}</span>
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.label}
                  className="border-b border-gray-100 dark:border-gray-800"
                >
                  <td className="py-2 px-2 text-gray-500 sticky left-0 bg-white dark:bg-gray-950 z-10">
                    {row.label}
                  </td>
                  {comparison.map((f, i) => (
                    <td key={f._id} className="py-2 px-3 text-gray-900 dark:text-gray-100">
                      {row.get(f, i)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

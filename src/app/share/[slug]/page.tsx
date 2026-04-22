"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";

interface SharedFilament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
  cost?: number | null;
  density?: number | null;
  temperatures?: { nozzle?: number | null; bed?: number | null };
  compatibleNozzles?: string[];
  calibrations?: {
    nozzle?: string | null;
    printer?: string | null;
    bedType?: string | null;
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
}

interface SharedRef {
  _id: string;
  name: string;
  [k: string]: unknown;
}

interface SharedPayload {
  slug: string;
  title: string;
  description: string;
  createdAt: string;
  viewCount: number;
  payload: {
    version: number;
    createdAt: string;
    filaments: SharedFilament[];
    nozzles?: SharedRef[];
    printers?: SharedRef[];
    bedTypes?: SharedRef[];
  };
}

export default function SharedCatalogPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const params = useParams();
  const slug = params.slug as string;

  const [data, setData] = useState<SharedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/share/${slug}`, { signal: ac.signal })
      .then((r) => {
        if (r.status === 404) return Promise.reject("not-found");
        if (r.status === 410) return Promise.reject("expired");
        if (!r.ok) return Promise.reject("error");
        return r.json();
      })
      .then((d: SharedPayload) => {
        setData(d);
        // Select all by default
        setSelectedIds(new Set(d.payload.filaments.map((f) => f._id)));
      })
      .catch((kind) => {
        if (kind === "not-found") setError(t("share.public.notFound"));
        else if (kind === "expired") setError(t("share.public.expired"));
        else setError(t("share.public.loadError"));
      });
    return () => ac.abort();
  }, [slug, t]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleImport = async () => {
    if (!data) return;
    if (selectedIds.size === 0) return;
    setImporting(true);
    try {
      const filtered = data.payload.filaments.filter((f) => selectedIds.has(f._id));

      // Figure out which nozzle / printer / bedType references are actually
      // used by the filaments the user chose. We don't rehydrate unused
      // records — that would pollute the destination database with clutter
      // the importer didn't opt into.
      const neededNozzleIds = new Set<string>();
      const neededPrinterIds = new Set<string>();
      const neededBedTypeIds = new Set<string>();
      for (const f of filtered) {
        for (const nid of f.compatibleNozzles || []) {
          if (nid) neededNozzleIds.add(String(nid));
        }
        for (const cal of f.calibrations || []) {
          if (cal.nozzle) neededNozzleIds.add(String(cal.nozzle));
          if (cal.printer) neededPrinterIds.add(String(cal.printer));
          if (cal.bedType) neededBedTypeIds.add(String(cal.bedType));
        }
      }

      // Helper: POST one reference record; if it 409s (existing record
      // with the same unique key), GET the destination's matching record
      // by name and use that _id instead. Falls back to the source _id
      // only if both the POST and the duplicate-resolution lookup fail
      // — in which case the resulting filament calibration ref will still
      // dangle, but that's no worse than before this fix.
      async function rehydrate(
        endpoint: string,
        records: SharedRef[],
        idSet: Set<string>,
      ): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        for (const r of records) {
          if (!idSet.has(String(r._id))) continue;
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...r, _id: undefined }),
          });
          if (res.ok) {
            const created = await res.json();
            map.set(String(r._id), String(created._id));
            continue;
          }
          if (res.status === 409) {
            // Same-named record already exists on the destination. Look it
            // up so we can reuse its _id rather than leaving a dangling ref.
            const listRes = await fetch(endpoint);
            if (listRes.ok) {
              const list: SharedRef[] = await listRes.json();
              const match = list.find((x) => x.name === r.name);
              if (match) {
                map.set(String(r._id), String(match._id));
                continue;
              }
            }
          }
          // Last-resort: keep the source _id. Mapping below will drop any
          // still-unresolved references rather than write an invalid
          // ObjectId into the filament.
        }
        return map;
      }

      const [nozzleMap, printerMap, bedTypeMap] = await Promise.all([
        rehydrate("/api/nozzles", data.payload.nozzles ?? [], neededNozzleIds),
        rehydrate("/api/printers", data.payload.printers ?? [], neededPrinterIds),
        rehydrate("/api/bed-types", data.payload.bedTypes ?? [], neededBedTypeIds),
      ]);

      // Remap every id reference on each filament so the destination
      // calibrations/compatibleNozzles point at real local records.
      // Unresolved ids are dropped — better a missing reference than a
      // pointer to a random document on the destination.
      const remapped = filtered.map((f) => {
        const compatibleNozzles = (f.compatibleNozzles || [])
          .map((nid) => nozzleMap.get(String(nid)))
          .filter((x): x is string => Boolean(x));
        const calibrations = (f.calibrations || [])
          .map((cal) => ({
            ...cal,
            nozzle: cal.nozzle ? nozzleMap.get(String(cal.nozzle)) ?? null : null,
            printer: cal.printer ? printerMap.get(String(cal.printer)) ?? null : null,
            bedType: cal.bedType ? bedTypeMap.get(String(cal.bedType)) ?? null : null,
          }))
          // Calibrations require a nozzle; drop any that we couldn't map.
          .filter((cal) => cal.nozzle);
        return {
          ...f,
          _id: undefined,
          compatibleNozzles,
          calibrations,
        };
      });

      let created = 0;
      const conflicts: string[] = [];
      for (const f of remapped) {
        const res = await fetch("/api/filaments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(f),
        });
        if (res.ok) {
          created++;
        } else {
          const body = await res.json().catch(() => null);
          conflicts.push(body?.error || f.name);
        }
      }
      toast(t("share.public.imported", { count: created }));
      if (conflicts.length > 0) {
        toast(
          t("share.public.conflicts", { count: conflicts.length }) +
            " " +
            conflicts.slice(0, 3).join("; "),
          "error",
        );
      }
    } finally {
      setImporting(false);
    }
  };

  const publishedDate = useMemo(() => {
    if (!data) return "";
    return new Date(data.createdAt).toLocaleDateString();
  }, [data]);

  if (error) {
    return (
      <main className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-red-600 dark:text-red-400">{error}</p>
        <Link href="/" className="text-blue-600 hover:underline text-sm mt-3 inline-block">
          &larr; {t("share.backToFilaments")}
        </Link>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-sm text-gray-500">{t("common.loading")}</p>
      </main>
    );
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; {t("share.backToFilaments")}
        </Link>
      </div>
      <header className="mb-6 pb-6 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-3xl font-bold">{data.title}</h1>
        {data.description && (
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">{data.description}</p>
        )}
        <p className="text-xs text-gray-500 mt-2">
          {t("share.public.meta", {
            filaments: data.payload.filaments.length,
            date: publishedDate,
            views: data.viewCount,
          })}
        </p>
      </header>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          {t("share.public.pickFilaments", { selected: selectedIds.size, total: data.payload.filaments.length })}
        </h2>
        <button
          type="button"
          onClick={handleImport}
          disabled={importing || selectedIds.size === 0}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
        >
          {importing ? t("share.public.importing") : t("share.public.importSelected")}
        </button>
      </div>

      <ul className="border border-gray-200 dark:border-gray-700 rounded divide-y divide-gray-100 dark:divide-gray-800">
        {data.payload.filaments.map((f) => (
          <li key={f._id} className="px-3 py-2 flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={selectedIds.has(f._id)}
              onChange={() => toggleSelect(f._id)}
              className="w-4 h-4"
            />
            <span
              className="inline-block w-5 h-5 rounded-full border border-gray-300 flex-shrink-0"
              style={{ backgroundColor: f.color }}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{f.name}</p>
              <p className="text-xs text-gray-500">
                {f.vendor} · {f.type}
                {f.temperatures?.nozzle ? ` · ${f.temperatures.nozzle}°C nozzle` : ""}
                {f.temperatures?.bed ? ` · ${f.temperatures.bed}°C bed` : ""}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

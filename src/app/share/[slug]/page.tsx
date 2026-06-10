"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";
import { formatDate } from "@/lib/dateFormat";

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
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const params = useParams();
  const slug = params.slug as string;

  const [data, setData] = useState<SharedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  // GH #290: the import is a long serial chain of POSTs. Track the
  // mounted state + an AbortController so a thrown network error doesn't
  // become an unhandled rejection and setState can't fire after unmount.
  const mountedRef = useRef(true);
  const importAcRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      importAcRef.current?.abort();
    };
  }, []);

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
    if (importing) return;
    setImporting(true);
    importAcRef.current?.abort();
    const ac = new AbortController();
    importAcRef.current = ac;
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
            signal: ac.signal,
          });
          if (res.ok) {
            const created = await res.json();
            map.set(String(r._id), String(created._id));
            continue;
          }
          if (res.status === 409) {
            // Same-named record already exists on the destination. Look it
            // up so we can reuse its _id rather than leaving a dangling ref.
            const listRes = await fetch(endpoint, { signal: ac.signal });
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
          signal: ac.signal,
        });
        if (res.ok) {
          created++;
        } else {
          const body = await res.json().catch(() => null);
          conflicts.push(body?.error || f.name);
        }
      }
      if (ac.signal.aborted) return;
      toast(t("share.public.imported", { count: created }));
      if (conflicts.length > 0) {
        toast(
          t("share.public.conflicts", { count: conflicts.length }) +
            " " +
            conflicts.slice(0, 3).join("; "),
          "error",
        );
      }
    } catch (err) {
      // GH #290: a thrown network error used to escape the try/finally
      // as an unhandled rejection with no user feedback. Swallow the
      // unmount-abort case; toast everything else.
      if (
        ac.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      console.error("Shared-catalog import failed:", err);
      if (mountedRef.current) toast(t("share.public.importError"), "error");
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  };

  const publishedDate = useMemo(() => {
    if (!data) return "";
    return formatDate(data.createdAt, locale);
  }, [data, locale]);

  if (error) {
    return (
      <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-red-600 dark:text-red-400">{error}</p>
        <Link href="/" className="text-blue-600 hover:underline text-sm mt-3 inline-block">
          &larr; {t("share.backToFilaments")}
        </Link>
      </main>
    );
  }

  if (!data) {
    return (
      <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-sm text-gray-500">{t("common.loading")}</p>
      </main>
    );
  }

  return (
    <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
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
              id={`share-import-${f._id}`}
              type="checkbox"
              checked={selectedIds.has(f._id)}
              onChange={() => toggleSelect(f._id)}
              aria-label={t("share.public.selectFilamentForImport", {
                name: f.name,
                vendor: f.vendor,
                type: f.type,
              })}
              className="w-4 h-4"
            />
            <span
              className="inline-block w-5 h-5 rounded-full border border-gray-300 flex-shrink-0"
              style={{ backgroundColor: f.color }}
              aria-hidden="true"
            />
            {/* Codex P3 on PR #480: <label> only allows phrasing
                content; wrapping <p> tags is invalid HTML. Use a
                span-based layout with block utility classes so the
                checkbox association stays intact and validators stop
                flagging this surface. */}
            <label
              htmlFor={`share-import-${f._id}`}
              className="flex-1 min-w-0 cursor-pointer"
            >
              <span className="block font-medium truncate">{f.name}</span>
              <span className="block text-xs text-gray-500">
                {f.vendor} · {f.type}
                {f.temperatures?.nozzle ? ` · ${t("share.nozzleSuffix", { temp: f.temperatures.nozzle })}` : ""}
                {f.temperatures?.bed ? ` · ${t("share.bedSuffix", { temp: f.temperatures.bed })}` : ""}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </main>
  );
}

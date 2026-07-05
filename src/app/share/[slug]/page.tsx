"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import FilamentPicker from "@/components/FilamentPicker";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useDateFormat } from "@/hooks/useDateFormat";
import {
  partitionByParent,
  buildFilamentImportBody,
  buildPrinterImportBody,
  type ShareImportPrinter,
} from "@/lib/shareImport";

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
  const { formatDate } = useDateFormat();
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
        // GH #956: printers carry source-DB installedNozzles/installedBedTypes/
        // amsSlots refs that must be remapped/stripped before POST (they'd 400
        // otherwise). An optional per-endpoint transform builds the POST body;
        // the default just strips the source `_id`.
        transform?: (r: SharedRef) => Record<string, unknown>,
      ): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        for (const r of records) {
          if (!idSet.has(String(r._id))) continue;
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(transform ? transform(r) : { ...r, _id: undefined }),
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

      // GH #956: import nozzles + bed types FIRST, then printers — a printer's
      // installedNozzles/installedBedTypes must be remapped through those maps,
      // and `buildPrinterImportBody` also strips amsSlots (source spool ids are
      // meaningless on the destination). Without this the printer POST 400s, the
      // printerMap stays empty, and every printer-scoped calibration silently
      // degrades to `printer: null`.
      const [nozzleMap, bedTypeMap] = await Promise.all([
        rehydrate("/api/nozzles", data.payload.nozzles ?? [], neededNozzleIds),
        rehydrate("/api/bed-types", data.payload.bedTypes ?? [], neededBedTypeIds),
      ]);
      const printerMap = await rehydrate(
        "/api/printers",
        data.payload.printers ?? [],
        neededPrinterIds,
        (p) => buildPrinterImportBody(p as ShareImportPrinter, nozzleMap, bedTypeMap),
      );

      // GH #956: two-phase filament import. ROOTS first (to build the
      // source→local id map), then VARIANTS with `parentId` remapped through
      // it. `buildFilamentImportBody` also remaps compatibleNozzles +
      // calibration refs (dropping unresolved) so the destination points at
      // real local records. A variant whose parent wasn't imported (not
      // selected, or its create failed and it doesn't exist locally) is SKIPPED
      // and surfaced — importing it standalone would drop every inherited value.
      const { roots, variants } = partitionByParent(filtered);
      const filamentIdMap = new Map<string, string>();
      let created = 0;
      const conflicts: string[] = [];

      // POST one filament; on success record source→local id so variants can
      // resolve their parent. On a 409 (name already exists on the destination)
      // resolve the existing local filament by name into the map, so a variant
      // still attaches to a parent the recipient already owns — mirrors the
      // reference rehydrate's 409-reuse path.
      const postFilament = async (
        sourceId: string,
        body: Record<string, unknown>,
      ): Promise<boolean> => {
        const res = await fetch("/api/filaments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (res.ok) {
          const c = await res.json();
          filamentIdMap.set(sourceId, String(c._id));
          return true;
        }
        if (res.status === 409) {
          const listRes = await fetch("/api/filaments", { signal: ac.signal });
          if (listRes.ok) {
            const list = await listRes.json();
            const match = Array.isArray(list)
              ? list.find((x: { name?: string }) => x.name === body.name)
              : null;
            if (match?._id) filamentIdMap.set(sourceId, String(match._id));
          }
        }
        const errBody = await res.json().catch(() => null);
        conflicts.push(errBody?.error || String(body.name));
        return false;
      };

      for (const f of roots) {
        if (ac.signal.aborted) return;
        const body = buildFilamentImportBody(f, nozzleMap, printerMap, bedTypeMap, undefined);
        if (await postFilament(String(f._id), body)) created++;
      }
      for (const v of variants) {
        if (ac.signal.aborted) return;
        const localParent = filamentIdMap.get(String(v.parentId));
        if (!localParent) {
          conflicts.push(t("share.public.orphanVariant", { name: v.name }));
          continue;
        }
        const body = buildFilamentImportBody(v, nozzleMap, printerMap, bedTypeMap, localParent);
        if (await postFilament(String(v._id), body)) created++;
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
    return formatDate(data.createdAt);
  }, [data, formatDate]);

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

      {/* #827: reuse the search/type-filter picker the authoring /share and
          /compare pages use, so a recipient importing from a large catalog
          isn't stuck unchecking dozens of rows one-by-one. */}
      <FilamentPicker
        filaments={data.payload.filaments}
        selectedIds={selectedIds}
        onToggle={toggleSelect}
        ariaLabel={t("share.public.pickerAriaLabel")}
      />
    </main>
  );
}

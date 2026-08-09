"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { isKnownLocationKind } from "@/lib/locationKind";
import dynamic from "next/dynamic";

// Loaded on demand — the dialog pulls in the TSPL emitter + qrcode preview,
// which the locations list doesn't need until a print is requested.
const PrintDryBoxLabelDialog = dynamic(
  () => import("@/components/PrintDryBoxLabelDialog"),
  { ssr: false },
);

interface Location {
  _id: string;
  name: string;
  kind: string;
  humidity: number | null;
  /** ISO string over the wire; drives the label's DESICCANT CHANGED line. */
  desiccantChangedAt: string | null;
  notes: string;
  spoolCount: number;
  /** GH #1106: retired spools still HOLD the location (they block delete), but
   *  `spoolCount` excludes them — so a location with only retired spools read
   *  "Spools 0" and then refused to delete. */
  retiredSpoolCount: number;
  totalGrams: number;
}

/** Structured body of the 400 the DELETE route returns while a location is
 *  still in use (GH #1106) — lets the page explain WHICH spools are holding
 *  it rather than repeating an unactionable sentence. */
interface LocationInUse {
  locationId: string;
  activeSpools: number;
  retiredSpools: number;
  trashedSpools: number;
  activeFilaments: number;
  trashedFilaments: number;
  filamentNames: string[];
  trashedFilamentNames: string[];
  moreFilaments: number;
}

export default function LocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  /** The last "location is still in use" refusal, rendered as a persistent
   *  panel rather than a toast (GH #1106). */
  const [inUse, setInUse] = useState<LocationInUse | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const { formatGrams } = useNumberFormat();

  // Dry-box label printing. This page lists EVERY location — including
  // empty and freshly created dryboxes, which /inventory cannot show (its
  // groups are built from spools), so this is the entry point that makes a
  // box printable at exactly the moment you most want to label it: before
  // it has contents (PR #1043 round 4). The dialog fetches its own
  // manifest; an empty box prints "(empty)".
  const [printLocation, setPrintLocation] = useState<Location | null>(null);

  const fetchLocations = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const res = await fetch("/api/locations?stats=true", { signal });
        if (!res.ok) {
          toast(t("locations.loadError"), "error");
          setLoading(false);
          return;
        }
        const data = await res.json();
        setLocations(data);
        setSelected(new Set());
        setLoading(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        toast(t("locations.loadError"), "error");
        setLoading(false);
      }
    },
    [toast, t],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchLocations(ac.signal); // eslint-disable-line react-hooks/set-state-in-effect -- data fetching on mount
    return () => ac.abort();
  }, [fetchLocations]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === locations.length) setSelected(new Set());
    else setSelected(new Set(locations.map((l) => l._id)));
  };

  const handleDelete = async (id: string, name: string) => {
    if (!(await confirm({ message: t("locations.deleteConfirm", { name }), destructive: true, confirmLabel: t("common.delete") }))) return;
    // GH #1080: a network-level fetch rejection used to escape the handler
    // with no toast at all — the row just silently stayed.
    try {
      const res = await fetch(`/api/locations/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // GH #1106: an in-use refusal needs to persist and to name names —
        // `toast()` takes a plain string and auto-dismisses, so it can't
        // carry the filament list or a link. Render it in the page instead.
        if (body?.code === "location_in_use") {
          setInUse(body as LocationInUse);
          return;
        }
        toast(body?.error || t("locations.deleteError"), "error");
        return;
      }
      setInUse(null);
      toast(t("locations.deleted", { name }));
      fetchLocations();
    } catch {
      toast(t("locations.deleteError"), "error");
    }
  };

  const handleBulkDelete = async () => {
    const count = selected.size;
    if (!(await confirm({ message: t("locations.bulkDeleteConfirm", { count }), destructive: true, confirmLabel: t("common.delete") }))) return;
    setBulkDeleting(true);
    let deleted = 0;
    const errors: string[] = [];
    try {
      for (const id of selected) {
        // GH #1080: a mid-loop network failure used to throw out of the
        // handler, leaving the delete button disabled forever and skipping
        // the refetch. Record the failure and keep going (GH #640 pattern).
        try {
          const res = await fetch(`/api/locations/${id}`, { method: "DELETE" });
          if (res.ok) {
            deleted++;
          } else {
            const body = await res.json().catch(() => null);
            const name = locations.find((l) => l._id === id)?.name ?? id;
            errors.push(body?.error || t("locations.deleteErrorNamed", { name }));
          }
        } catch {
          const name = locations.find((l) => l._id === id)?.name ?? id;
          errors.push(t("locations.deleteErrorNamed", { name }));
        }
      }
      if (deleted > 0) toast(t("locations.bulkDeleted", { count: deleted }));
      if (errors.length > 0) toast(errors.join("; "), "error");
    } finally {
      setBulkDeleting(false);
      fetchLocations();
    }
  };

  return (
    <main id="main-content" className="w-full px-4 py-8">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">{t("locations.title")}</h1>
          <div className="flex gap-3">
            <Link
              href="/settings"
              className="text-blue-600 hover:underline text-sm"
            >
              &larr; {t("locations.backToSettings")}
            </Link>
          </div>
        </div>
        <Link
          href="/locations/new"
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          {t("locations.addNew")}
        </Link>
      </div>

      {/* GH #1106: a location holding only retired spools, or spools on
          trashed filaments, refused to delete while the row beside the button
          read "Spools 0" — and the toast told the user to reassign spools the
          page insisted didn't exist. Name the filaments, split the counts by
          why they're hidden, and link somewhere that can actually show them. */}
      {inUse && (
        <div
          role="alert"
          className="mb-4 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg text-sm"
        >
          <p className="font-medium text-amber-800 dark:text-amber-200">
            {t("locations.inUse.title")}
          </p>
          <ul className="mt-1 list-disc list-inside text-amber-700 dark:text-amber-300 space-y-0.5">
            {inUse.activeSpools > 0 && (
              <li>{t("locations.inUse.active", { count: inUse.activeSpools })}</li>
            )}
            {inUse.retiredSpools > 0 && (
              <li>{t("locations.inUse.retired", { count: inUse.retiredSpools })}</li>
            )}
            {inUse.trashedSpools > 0 && (
              <li>
                {t("locations.inUse.trashed", {
                  spools: inUse.trashedSpools,
                  filaments: inUse.trashedFilaments,
                })}
              </li>
            )}
          </ul>
          {(inUse.filamentNames.length > 0 || inUse.trashedFilamentNames.length > 0) && (
            <p className="mt-1 text-amber-700 dark:text-amber-300">
              {t("locations.inUse.filaments", {
                names: [...inUse.filamentNames, ...inUse.trashedFilamentNames].join(", "),
              })}
              {inUse.moreFilaments > 0 &&
                ` ${t("locations.inUse.andMore", { count: inUse.moreFilaments })}`}
            </p>
          )}
          <div className="mt-2 flex items-center gap-3">
            {/* Only offer Inventory when it can actually show something. Its
                aggregation matches `_deletedAt: null` unconditionally, so
                `includeRetired=1` still can't surface spools on TRASHED
                filaments — linking there for a trash-only blocker would land
                on an empty group and toast "no active spools", recreating the
                exact contradiction this panel exists to resolve. */}
            {inUse.activeFilaments > 0 && (
              <Link
                href={`/inventory?location=${encodeURIComponent(inUse.locationId)}&includeRetired=1`}
                className="text-blue-600 hover:underline"
              >
                {t("locations.inUse.viewSpools")}
              </Link>
            )}
            {inUse.trashedFilaments > 0 && (
              <Link href="/trash" className="text-blue-600 hover:underline">
                {t("locations.inUse.viewTrash")}
              </Link>
            )}
            <button
              type="button"
              onClick={() => setInUse(null)}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              {t("common.dismiss")}
            </button>
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-3 px-3 py-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
          <span className="text-sm text-red-600 dark:text-red-300">
            {t("locations.selected", { count: selected.size })}
          </span>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="px-3 py-1 bg-red-700 text-white rounded text-sm hover:bg-red-600 disabled:opacity-50"
          >
            {bulkDeleting
              ? t("locations.deleting")
              : t("locations.deleteCount", { count: selected.size })}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {t("locations.clear")}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">{t("locations.loading")}</p>
      ) : locations.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">{t("locations.empty")}</p>
          <Link
            href="/locations/new"
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            {t("locations.addFirst")}
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-300">
                <th scope="col" className="py-3 px-2 w-8">
                  <input
                    type="checkbox"
                    checked={
                      selected.size === locations.length && locations.length > 0
                    }
                    onChange={toggleAll}
                    aria-label={t("locations.bulk.selectAll") || "Select all"}
                    className="accent-red-600"
                  />
                </th>
                <th scope="col" className="text-left py-3 px-2">{t("locations.table.name")}</th>
                <th scope="col" className="text-left py-3 px-2">{t("locations.table.kind")}</th>
                <th scope="col" className="text-right py-3 px-2">
                  {t("locations.table.humidity")}
                </th>
                <th scope="col" className="text-right py-3 px-2">
                  {t("locations.table.spools")}
                </th>
                <th scope="col" className="text-right py-3 px-2">
                  {t("locations.table.weight")}
                </th>
                <th scope="col" className="text-left py-3 px-2">{t("locations.table.notes")}</th>
                <th scope="col" className="text-right py-3 px-2">{t("locations.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr
                  key={l._id}
                  className={`border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 ${
                    selected.has(l._id) ? "bg-red-950/20" : ""
                  }`}
                >
                  <td className="py-2 px-2">
                    <input
                      type="checkbox"
                      checked={selected.has(l._id)}
                      onChange={() => toggleSelect(l._id)}
                      aria-label={l.name || t("common.select")}
                      className="accent-red-600"
                    />
                  </td>
                  <td className="py-2 px-2 font-medium">{l.name}</td>
                  <td className="py-2 px-2">
                    <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-800 rounded text-xs">
                      {isKnownLocationKind(l.kind) ? t(`locations.kind.${l.kind}`) : l.kind}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right text-xs">
                    {l.humidity != null ? `${l.humidity}%` : "—"}
                  </td>
                  <td className="py-2 px-2 text-right text-xs">
                    {l.spoolCount}
                    {/* GH #1106: retired spools are excluded from the count
                        but still block deletion. Surfacing them here is what
                        stops the row contradicting the Delete button. */}
                    {l.retiredSpoolCount > 0 && (
                      <span
                        title={t("locations.table.retiredChipTitle", {
                          count: l.retiredSpoolCount,
                        })}
                        className="ml-1.5 px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-[10px]"
                      >
                        {t("locations.table.retiredChip", { count: l.retiredSpoolCount })}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right text-xs text-gray-500">
                    {l.totalGrams > 0 ? `${formatGrams(l.totalGrams)}g` : "—"}
                  </td>
                  <td className="py-2 px-2 text-gray-500 text-xs">{l.notes || "—"}</td>
                  <td className="py-2 px-2 text-right">
                    {l.kind === "drybox" && (
                      <button
                        onClick={() => setPrintLocation(l)}
                        title={t("inventory.printDryBox")}
                        className="text-blue-600 hover:underline mr-3 text-xs"
                      >
                        {t("locations.table.printLabel")}
                      </button>
                    )}
                    <Link
                      href={`/locations/${l._id}/edit`}
                      className="text-blue-600 hover:underline mr-3 text-xs"
                    >
                      {t("locations.table.edit")}
                    </Link>
                    <button
                      onClick={() => handleDelete(l._id, l.name)}
                      className="text-red-600 hover:underline text-xs"
                    >
                      {t("locations.table.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {printLocation && (
        <PrintDryBoxLabelDialog
          open
          onClose={() => setPrintLocation(null)}
          location={printLocation}
        />
      )}
    </main>
  );
}

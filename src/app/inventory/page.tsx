"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTranslation } from "@/i18n/TranslationProvider";
import { formatDate } from "@/lib/dateFormat";
import { Skeleton, SkeletonRegion } from "@/components/Skeleton";

/**
 * GH #389 — Spool Inventory page.
 *
 * Lists every active spool grouped by storage Location, so you can:
 *   - see at a glance how many spools you have and where they live
 *   - audit a physical location ("are the spools on this shelf the same
 *     ones the app thinks are here?")
 *   - update the most common per-spool things (weight, location, retire)
 *     without first navigating to the parent filament's detail page
 *
 * Counterpart to the filament list (/): same data, different lens.
 * Where the filament list groups spools UNDER their filament, this page
 * groups filaments under their LOCATION.
 *
 * Data comes from `/api/spools/by-location` which does the aggregation
 * server-side (groups by `spools[].locationId`, lookups the Location
 * doc, surfaces parent inheritance hints for the % remaining math).
 * Inline edits hit the existing `PUT /api/filaments/{id}/spools/{spoolId}`
 * endpoint — no new mutation route was needed for v1.
 */

interface SpoolRow {
  _id: string;
  label: string;
  totalWeight: number | null;
  lotNumber: string | null;
  purchaseDate: string | null;
  openedDate: string | null;
  retired: boolean;
  /** GH #429: not in the by-location aggregation payload anymore — the
   * inventory list doesn't render photos and the per-row data URLs
   * could push the response into the megabytes range on large
   * catalogs. Kept optional in the type so a future row-expand can
   * lazy-load it from `/api/filaments/{id}`. */
  photoDataUrl?: string | null;
  dryCycleCount: number;
  lastDryAt: string | null;
  filamentId: string;
  filamentName: string;
  filamentVendor: string;
  filamentType: string;
  filamentColor: string;
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  parentSpoolWeight: number | null;
  parentNetFilamentWeight: number | null;
}

interface Group {
  locationId: string | null;
  location: { _id: string; name: string; kind: string; humidity: number | null; notes: string } | null;
  spools: SpoolRow[];
  count: number;
  totalGrams: number;
}

interface InventoryResponse {
  groups: Group[];
  totalSpools: number;
}

interface LocationOption {
  _id: string;
  name: string;
  kind: string;
}

/** Effective spool/net weights with parent inheritance. */
function effectiveWeights(row: SpoolRow): { tare: number | null; net: number | null } {
  return {
    tare: row.spoolWeight ?? row.parentSpoolWeight ?? null,
    net: row.netFilamentWeight ?? row.parentNetFilamentWeight ?? null,
  };
}

/** Grams of filament remaining on this spool, or null if uncomputable. */
function remainingGrams(row: SpoolRow): number | null {
  const { tare } = effectiveWeights(row);
  if (tare == null || row.totalWeight == null) return null;
  return Math.max(0, row.totalWeight - tare);
}

/** Integer 0–100 percent remaining, or null if uncomputable. */
function remainingPct(row: SpoolRow): number | null {
  const { tare, net } = effectiveWeights(row);
  if (tare == null || net == null || net <= 0 || row.totalWeight == null) return null;
  const grams = Math.max(0, row.totalWeight - tare);
  return Math.min(100, Math.max(0, Math.round((grams / net) * 100)));
}

export default function InventoryPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [data, setData] = useState<InventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState<LocationOption[]>([]);

  // Filters
  const [kind, setKind] = useState("");
  const [type, setType] = useState("");
  const [vendor, setVendor] = useState("");
  const [search, setSearch] = useState("");
  const [includeRetired, setIncludeRetired] = useState(false);

  // GH #444: debounce the search input. The filtered-groups memo
  // walks every group + every spool on each keystroke; on a slow
  // host with 1000+ spools that's a noticeable per-keystroke pause.
  // 200ms feels responsive (well below conscious-lag threshold) and
  // collapses bursts of typing into one recompute. The main filaments
  // list uses 300ms for the same reason; this is on the snappier
  // side because the search runs purely client-side here.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(id);
  }, [search]);

  // Per-group expand/collapse state. Default: every group expanded.
  // The set holds COLLAPSED group keys (locationId or "_none") so a
  // brand-new group from a refresh defaults to expanded without us
  // having to seed it.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const fetchInventory = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        if (kind) qs.set("kind", kind);
        if (type) qs.set("type", type);
        if (vendor) qs.set("vendor", vendor);
        if (includeRetired) qs.set("includeRetired", "1");
        const res = await fetch(`/api/spools/by-location?${qs.toString()}`, { signal });
        if (!res.ok) {
          toast(t("inventory.loadFailed"), "error");
          setLoading(false);
          return;
        }
        setData(await res.json());
        setLoading(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        toast(t("inventory.loadFailed"), "error");
        setLoading(false);
      }
    },
    [kind, type, vendor, includeRetired, t, toast],
  );

  // Load on mount + whenever a filter changes.
  useEffect(() => {
    const ac = new AbortController();
    fetchInventory(ac.signal); // eslint-disable-line react-hooks/set-state-in-effect -- data fetching
    return () => ac.abort();
  }, [fetchInventory]);

  // Locations list (for the "move" dropdown on each row).
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/locations", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: LocationOption[]) => setLocations(list))
      .catch(() => {});
    return () => ac.abort();
  }, []);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Client-side search filter — runs over the already-server-filtered
  // groups so the filament/type/vendor server filters compose with a
  // free-text local match against filament name / spool label / lot.
  //
  // Codex P2 on PR #391 round 2: recompute `count` and `totalGrams`
  // from the FILTERED spools — previously the cloned group kept the
  // server-side counts, so a one-result search on a 20-spool shelf
  // still rendered "20 spools · 18000g" in the header.
  //
  // Codex P2 on PR #400 round 4: when summing the search-filtered
  // total, mirror the server's 0g-tare fallback for legacy spools
  // (totalWeight set, no own/parent spoolWeight). `remainingGrams()`
  // returns null in that shape — correct for the per-row "?" display,
  // but wrong for the group total. Inline the math here so an
  // unsearched group's total and the same group's searched total
  // (matching all rows) agree.
  const filteredGroups = useMemo(() => {
    if (!data) return [];
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return data.groups;
    return data.groups
      .map((g) => {
        const matching = g.spools.filter(
          (s) =>
            s.filamentName.toLowerCase().includes(q) ||
            (s.label || "").toLowerCase().includes(q) ||
            (s.lotNumber || "").toLowerCase().includes(q),
        );
        const totalGrams = matching.reduce((sum, s) => {
          if (s.totalWeight == null) return sum;
          const { tare } = effectiveWeights(s);
          return sum + Math.max(0, s.totalWeight - (tare ?? 0));
        }, 0);
        return {
          ...g,
          spools: matching,
          count: matching.length,
          totalGrams,
        };
      })
      .filter((g) => g.spools.length > 0);
  }, [data, debouncedSearch]);

  // Stats for the header — derived from the SERVER groups so they
  // reflect the active server filters, not the client-side text search
  // (which is a "find within results" rather than a true filter).
  const stats = useMemo(() => {
    if (!data) return { spoolCount: 0, locationCount: 0, totalGrams: 0 };
    return {
      spoolCount: data.totalSpools,
      locationCount: data.groups.filter((g) => g.locationId != null).length,
      totalGrams: data.groups.reduce((s, g) => s + g.totalGrams, 0),
    };
  }, [data]);

  // For the inline edit handlers we use the existing per-spool PUT —
  // the same one the SpoolCard component uses on the filament detail
  // page — so retire / move / weight-update semantics stay identical
  // across both surfaces.
  const updateSpool = useCallback(
    async (row: SpoolRow, patch: Record<string, unknown>): Promise<boolean> => {
      const res = await fetch(`/api/filaments/${row.filamentId}/spools/${row._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast(body?.error || t("inventory.updateFailed"), "error");
        return false;
      }
      return true;
    },
    [t, toast],
  );

  return (
    <main id="main-content" className="w-full max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold">{t("inventory.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("inventory.subtitle")}</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
        <StatCard label={t("inventory.stats.spools")} value={stats.spoolCount.toString()} />
        <StatCard label={t("inventory.stats.locations")} value={stats.locationCount.toString()} />
        <StatCard label={t("inventory.stats.totalWeight")} value={`${(stats.totalGrams / 1000).toFixed(2)} kg`} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-6 p-3 bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-800 rounded-lg">
        <div>
          <label htmlFor="inv-search" className="block text-xs text-gray-500 mb-1">
            {t("inventory.filter.search")}
          </label>
          <input
            id="inv-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("inventory.filter.searchPlaceholder")}
            className="w-56 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
          />
        </div>
        <div>
          <label htmlFor="inv-kind" className="block text-xs text-gray-500 mb-1">
            {t("inventory.filter.kind")}
          </label>
          <select
            id="inv-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
          >
            <option value="">{t("inventory.filter.allKinds")}</option>
            <option value="shelf">{t("locations.kind.shelf")}</option>
            <option value="drybox">{t("locations.kind.drybox")}</option>
            <option value="cabinet">{t("locations.kind.cabinet")}</option>
            <option value="printer">{t("locations.kind.printer")}</option>
            <option value="other">{t("locations.kind.other")}</option>
          </select>
        </div>
        <div>
          <label htmlFor="inv-type" className="block text-xs text-gray-500 mb-1">
            {t("inventory.filter.type")}
          </label>
          <input
            id="inv-type"
            type="text"
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder={t("inventory.filter.typePlaceholder")}
            className="w-32 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
          />
        </div>
        <div>
          <label htmlFor="inv-vendor" className="block text-xs text-gray-500 mb-1">
            {t("inventory.filter.vendor")}
          </label>
          <input
            id="inv-vendor"
            type="text"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder={t("inventory.filter.vendorPlaceholder")}
            className="w-40 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 pb-1">
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(e) => setIncludeRetired(e.target.checked)}
            className="accent-blue-600"
          />
          {t("inventory.filter.includeRetired")}
        </label>
      </div>

      {/* Groups */}
      {loading ? (
        // GH #449: skeleton placeholders instead of a single "Loading…"
        // line. Three card-shaped blocks mirror the group cards that
        // arrive once the fetch completes, so the layout doesn't
        // reflow when content lands.
        <SkeletonRegion label={t("inventory.loading")} className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-3"
            >
              <Skeleton className="h-5 w-48 rounded" />
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-4 w-3/4 rounded" />
            </div>
          ))}
        </SkeletonRegion>
      ) : filteredGroups.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-gray-300 dark:border-gray-700 rounded-lg">
          <p className="text-gray-500 mb-3">{t("inventory.empty")}</p>
          <Link
            href="/locations/new"
            className="text-blue-600 hover:underline text-sm"
          >
            {t("inventory.empty.addLocation")}
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredGroups.map((group) => {
            const key = group.locationId ?? "_none";
            const isCollapsed = collapsed.has(key);
            const name = group.location?.name ?? t("inventory.noLocation");
            const kindLabel = group.location?.kind
              ? t(`locations.kind.${group.location.kind}`)
              : "";
            return (
              <section
                key={key}
                className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => toggleCollapse(key)}
                  aria-expanded={!isCollapsed}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-900/50 hover:bg-gray-100 dark:hover:bg-gray-900 text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-gray-400 text-sm" aria-hidden="true">
                      {isCollapsed ? "▶" : "▼"}
                    </span>
                    <h2 className="font-semibold text-base truncate">
                      {name}
                      {kindLabel && (
                        <span className="ml-2 text-xs text-gray-500 font-normal">
                          {kindLabel}
                        </span>
                      )}
                      {group.location?.humidity != null && (
                        <span className="ml-2 text-xs text-gray-500 font-normal">
                          · {group.location.humidity}% RH
                        </span>
                      )}
                    </h2>
                  </div>
                  <div className="text-sm text-gray-500 whitespace-nowrap">
                    {t("inventory.group.summary", {
                      count: group.count,
                      grams: Math.round(group.totalGrams),
                    })}
                  </div>
                </button>
                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b border-gray-200 dark:border-gray-800 text-xs text-gray-500">
                        <tr>
                          <th scope="col" className="text-left py-2 px-3">{t("inventory.col.filament")}</th>
                          <th scope="col" className="text-left py-2 px-3">{t("inventory.col.spool")}</th>
                          <th scope="col" className="text-right py-2 px-3">{t("inventory.col.weight")}</th>
                          <th scope="col" className="text-right py-2 px-3">{t("inventory.col.remaining")}</th>
                          <th scope="col" className="text-left py-2 px-3">{t("inventory.col.lastDry")}</th>
                          <th scope="col" className="text-right py-2 px-3">{t("inventory.col.actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.spools.map((row) => (
                          <SpoolEditRow
                            key={`${row.filamentId}-${row._id}`}
                            row={row}
                            locations={locations}
                            updateSpool={updateSpool}
                            confirmRetire={confirm}
                            onChanged={() => fetchInventory()}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}

interface RowProps {
  row: SpoolRow;
  locations: LocationOption[];
  updateSpool: (row: SpoolRow, patch: Record<string, unknown>) => Promise<boolean>;
  confirmRetire: ReturnType<typeof useConfirm>;
  onChanged: () => void;
}

function SpoolEditRow({ row, locations, updateSpool, confirmRetire, onChanged }: RowProps) {
  const { t, locale } = useTranslation();
  const grams = remainingGrams(row);
  const pct = remainingPct(row);

  // Inline weight editor — opens on click, saves on Enter / Save button.
  const [editingWeight, setEditingWeight] = useState(false);
  const [weightDraft, setWeightDraft] = useState(row.totalWeight?.toString() ?? "");
  const [saving, setSaving] = useState(false);

  const saveWeight = async () => {
    const n = Number(weightDraft);
    if (!Number.isFinite(n) || n < 0) return;
    setSaving(true);
    const ok = await updateSpool(row, { totalWeight: n });
    setSaving(false);
    if (ok) {
      setEditingWeight(false);
      onChanged();
    }
  };

  // GH #404: the move-to <select> and retire button used to fire
  // PUTs without a busy guard. On a slow LAN (Pi-hosted instance,
  // etc.) a second click would race the first PUT; on retire toggle
  // the response order could end in the wrong state. Per-handler
  // saving flags disable the matching control until the round-trip
  // completes. The weight editor already did this via its own
  // `saving` state.
  const [movePending, setMovePending] = useState(false);
  const [retirePending, setRetirePending] = useState(false);

  const moveTo = async (locId: string) => {
    if (movePending) return;
    setMovePending(true);
    try {
      const ok = await updateSpool(row, { locationId: locId || null });
      if (ok) onChanged();
    } finally {
      setMovePending(false);
    }
  };

  const toggleRetire = async () => {
    if (retirePending) return;
    if (!row.retired) {
      // Retiring removes the spool from inventory totals — confirm
      // because it's the kind of action a click can fire by mistake.
      if (!(await confirmRetire({
        message: t("inventory.confirmRetire", { label: row.label || row.filamentName }),
        confirmLabel: t("inventory.retire"),
      }))) return;
    }
    setRetirePending(true);
    try {
      const ok = await updateSpool(row, { retired: !row.retired });
      if (ok) onChanged();
    } finally {
      setRetirePending(false);
    }
  };

  return (
    <tr
      className={`border-b border-gray-100 dark:border-gray-900 ${
        row.retired ? "opacity-50" : "hover:bg-gray-50 dark:hover:bg-gray-900/40"
      }`}
    >
      <td className="py-2 px-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block w-3.5 h-3.5 rounded-full border border-gray-300 dark:border-gray-700 shrink-0"
            style={{ backgroundColor: row.filamentColor || "#808080" }}
            aria-hidden="true"
          />
          <Link
            href={`/filaments/${row.filamentId}`}
            className="text-blue-600 hover:underline truncate"
          >
            {row.filamentName}
          </Link>
          <span className="text-xs text-gray-500 shrink-0">{row.filamentType}</span>
        </div>
        <div className="text-xs text-gray-500 truncate">
          {row.filamentVendor}
          {row.lotNumber && ` · lot ${row.lotNumber}`}
        </div>
      </td>
      <td className="py-2 px-3">
        <div className="font-medium">{row.label || <span className="text-gray-400 italic">{t("inventory.unnamed")}</span>}</div>
        {row.retired && (
          <span className="inline-block text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
            {t("inventory.retiredBadge")}
          </span>
        )}
      </td>
      <td className="py-2 px-3 text-right">
        {editingWeight ? (
          <span className="inline-flex items-center gap-1">
            <input
              type="number"
              min="0"
              step="1"
              autoFocus
              value={weightDraft}
              onChange={(e) => setWeightDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveWeight();
                if (e.key === "Escape") {
                  setWeightDraft(row.totalWeight?.toString() ?? "");
                  setEditingWeight(false);
                }
              }}
              aria-label={t("inventory.updateWeight")}
              className="w-20 px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
            />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={saveWeight}
              disabled={saving}
              className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "…" : t("common.save")}
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setWeightDraft(row.totalWeight?.toString() ?? "");
                setEditingWeight(false);
              }}
              className="px-2 py-0.5 border border-gray-300 dark:border-gray-700 rounded text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              {t("common.cancel")}
            </button>
          </span>
        ) : (
          // GH #445: visible affordance for the inline weight editor.
          // Pre-fix the trigger rendered in default text color with
          // no underline, no icon, no hover ring — keyboard users
          // tabbed past it without realising it was editable. Adding
          // a pencil indicator + a dotted underline matches the
          // visual idiom for "click to edit" used elsewhere in the
          // app (SpoolCard label edit).
          <button
            type="button"
            onClick={() => setEditingWeight(true)}
            className="inline-flex items-center gap-1 border-b border-dashed border-gray-400 dark:border-gray-600 hover:text-blue-600 hover:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 transition-colors"
            aria-label={t("inventory.updateWeight")}
            title={t("inventory.updateWeight")}
          >
            {row.totalWeight != null ? `${row.totalWeight}g` : <span className="text-gray-400">—</span>}
            <span aria-hidden="true" className="text-xs opacity-50">✎</span>
          </button>
        )}
      </td>
      <td className="py-2 px-3 text-right">
        {pct != null ? (
          <div className="inline-flex items-center gap-2">
            <div className="w-16 bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
              <div
                className={`h-2 rounded-full transition-all ${
                  pct > 25 ? "bg-green-500" : pct > 10 ? "bg-yellow-500" : "bg-red-500"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs text-gray-500 w-12 text-right">
              {grams != null ? `${grams}g` : `${pct}%`}
            </span>
          </div>
        ) : grams != null ? (
          <span className="text-xs">{grams}g</span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="py-2 px-3 text-xs text-gray-500">
        {row.lastDryAt ? (
          <div className="inline-flex items-center gap-1.5">
            <span>{formatDate(row.lastDryAt, locale)}</span>
            {/* GH #443: dry-cycle count was buried inside a title=
                tooltip — touch-only iPad / tablet users never see it.
                Surface as a visible chip next to the date. */}
            {row.dryCycleCount > 0 && (
              <span
                className="inline-block px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-[10px] leading-none"
                aria-label={t("inventory.dryCycleCount", { count: row.dryCycleCount })}
              >
                {t("inventory.dryCycleBadge", { count: row.dryCycleCount })}
              </span>
            )}
          </div>
        ) : (
          <span className="text-gray-400">{t("inventory.neverDried")}</span>
        )}
      </td>
      <td className="py-2 px-3 text-right">
        <div className="inline-flex items-center gap-1">
          <select
            value=""
            disabled={movePending}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__none") moveTo("");
              else if (v) moveTo(v);
              e.target.value = "";
            }}
            aria-label={t("inventory.moveTo")}
            title={t("inventory.moveTo")}
            className="text-xs px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-transparent disabled:opacity-50"
          >
            <option value="">{t("inventory.moveTo")}</option>
            <option value="__none">{t("inventory.noLocation")}</option>
            {locations.map((loc) => (
              <option key={loc._id} value={loc._id}>
                {loc.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={toggleRetire}
            disabled={retirePending}
            className={`text-xs px-2 py-0.5 rounded disabled:opacity-50 ${
              row.retired
                ? "border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
                : "text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950"
            }`}
            title={row.retired ? t("inventory.unretire") : t("inventory.retire")}
          >
            {row.retired ? t("inventory.unretire") : t("inventory.retire")}
          </button>
        </div>
      </td>
    </tr>
  );
}

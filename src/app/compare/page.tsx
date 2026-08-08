"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useCurrency } from "@/hooks/useCurrency";
import FilamentPicker from "@/components/FilamentPicker";
import FilamentSwatch from "@/components/FilamentSwatch";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { MAX_COMPARE_FILAMENTS, parseCompareIds } from "@/lib/compareSelection";
import { getRemainingGrams } from "@/lib/inventoryStats";
import { allColors, deriveArrangement } from "@/lib/filamentColors";
import { deriveFinish } from "@/lib/filamentFinish";

interface FilamentOption {
  _id: string;
  name: string;
  vendor: string;
  // Nullable since GH #477: a coextruded filament carries no primary colour,
  // and since v1.70 a template parent is deliberately colourless.
  color: string | null;
  secondaryColors?: string[];
  optTags?: number[];
  type: string;
}

interface CompareFilament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  // See FilamentOption above — `color` is genuinely nullable in the schema
  // (`src/models/Filament.ts`, OpenPrintTag key 19). Typing it `string` was a
  // lie that produced the literal text "Ruby (null)" in the colour row and a
  // transparent header swatch (GH #1120).
  color: string | null;
  colorName: string | null;
  secondaryColors?: string[];
  optTags?: number[];
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
  spoolWeight: number | null;
  // Legacy single-spool shape: stock tracked on the filament itself, with no
  // spools[] subdocuments. Present in the payload all along; the "On hand" row
  // just never looked at it (GH #1110).
  totalWeight: number | null;
  netFilamentWeight: number | null;
}

export default function ComparePage() {
  // GH #638: the Suspense fallback was hardcoded English. The provider
  // mounts above this component (ClientProviders in the root layout), so
  // t() is available here.
  const { t } = useTranslation();
  return (
    <Suspense fallback={<main id="main-content" className="p-8"><p className="text-gray-500">{t("common.loading")}</p></main>}>
      <ComparePageInner />
    </Suspense>
  );
}

function ComparePageInner() {
  const { t } = useTranslation();
  const { format: formatCurrency } = useCurrency();
  const { formatGrams } = useNumberFormat();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Parsed ONCE, lazily. The URL-sync effect below rewrites `?ids=` to the
  // capped list, so deriving this on every render would immediately reset
  // `dropped` to 0 and the truncation notice would never paint.
  const [initialSelection] = useState(() => parseCompareIds(searchParams.get("ids")));

  const [allFilaments, setAllFilaments] = useState<FilamentOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelection.ids);
  const [droppedFromLink, setDroppedFromLink] = useState(initialSelection.dropped);
  const [comparison, setComparison] = useState<CompareFilament[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing derived state
      setComparison([]);
      // Codex P2 on PR #1013: also clear loading here. When the last selection
      // is removed while a compare fetch is still in flight, the previous
      // effect's cleanup aborts it and the AbortError branch below now
      // (correctly) ignores that rejection — so without this, `loading` would
      // stay true forever: a stuck spinner with no request behind it.
      setLoading(false);
      setError(null);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    fetch(`/api/filaments/compare?ids=${selectedIds.join(",")}`, { signal: ac.signal })
      .then(async (r) => {
        // GH #1109: this used to be `r.ok ? r.json() : []`, so an API error
        // became an empty comparison that no render gate matched — a blank
        // page with no explanation. Surface it instead.
        if (!r.ok) {
          // Deliberately NOT rendering the server's text: a hand-edited id
          // makes the route throw a Mongoose CastError, whose message names
          // the model and the schema path. The user can't act on that, so it
          // goes to the console and they get a sentence they can act on.
          const body = await r.json().catch(() => null);
          if (body?.error) console.warn("compare request failed:", body.error);
          throw new Error(t("compare.error.generic"));
        }
        return r.json();
      })
      .then((data) => {
        setComparison(data);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        // GH #1007 F5: a rapid selection change aborts the in-flight request
        // AFTER the new effect already set loading=true. Without filtering
        // AbortError, that stale rejection flips the "Loading…" cue off
        // mid-fetch and the previous comparison reads as current. Matches
        // every sibling fetch (analytics / inventory / home).
        if ((err as Error)?.name === "AbortError") return;
        setComparison([]);
        setError((err as Error)?.message || t("compare.error.generic"));
        setLoading(false);
      });
    return () => ac.abort();
  }, [selectedIds, t]);

  // Keep the URL in sync so the page is linkable/shareable.
  useEffect(() => {
    const qs = selectedIds.length > 0 ? `?ids=${selectedIds.join(",")}` : "";
    router.replace(`/compare${qs}`, { scroll: false });
  }, [selectedIds, router]);

  const toggleFilament = (id: string) => {
    // The link-truncation notice describes the incoming URL, not the current
    // selection — once the user edits the selection it is stale.
    setDroppedFromLink(0);
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_COMPARE_FILAMENTS) return prev; // API limit
      return [...prev, id];
    });
  };

  // GH #522.3: was previously inlined as
  // `selectedIds={useMemo(() => new Set(selectedIds), [selectedIds])}`
  // inside the FilamentPicker JSX, which calls useMemo lexically inside
  // a JSX prop expression — still legal Hook rules-wise (the call is in
  // the function component body, not a callback), but the React team
  // flags this shape because the dep is read implicitly and refactors
  // tend to break it. Hoisted into a real binding.
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // GH #1110: this was a hand-rolled copy of the spools[] sum that had no
  // legacy fallback, so a roll tracked via the top-level `totalWeight` (no
  // spools[] subdocuments) reported "—" here while /inventory and the detail
  // page both showed its grams. `getRemainingGrams` is the shared helper every
  // other surface uses — it still subtracts the tare (the GH #182 fix this
  // replaces) and still skips retired spools, and it handles the legacy shape.
  // null means "not weight-tracked", which is distinct from a real 0 g.
  const onHandGrams = useMemo(() => comparison.map(getRemainingGrams), [comparison]);

  const rows: { label: string; get: (f: CompareFilament, i: number) => string }[] = [
    { label: t("compare.row.vendor"), get: (f) => f.vendor },
    { label: t("compare.row.type"), get: (f) => f.type },
    {
      label: t("compare.row.color"),
      get: (f) => {
        // GH #1120: interpolating a null `color` printed the literal string
        // "Ruby (null)", and a coextruded filament with no colourName rendered
        // an empty cell. `allColors` returns the primary plus every secondary,
        // so a multi-colour filament lists what it actually is.
        const hexes = allColors(f);
        // No stored colour at all — a v1.70 template is deliberately
        // colourless. Report that as unknown rather than reaching for
        // displayColor's #808080 fallback, which would assert a grey the user
        // never picked as though it were stored data.
        if (hexes.length === 0) return f.colorName || "—";
        const joined = hexes.join(" / ");
        return f.colorName ? `${f.colorName} (${joined})` : joined;
      },
    },
    {
      // `cost` is stored per-kg (the form labels it "Cost ({symbol}/kg)"), so a
      // single per-kg row covers it — the old plain "Cost" row showed the same
      // number without the /kg suffix (#779). No density needed: it's already
      // per-kg, no 1kg-spool conversion.
      label: t("compare.row.costPerKg"),
      get: (f) => (f.cost != null ? `${formatCurrency(f.cost)}/kg` : "—"),
    },
    { label: t("compare.row.diameter"), get: (f) => `${f.diameter} mm` },
    {
      label: t("compare.row.density"),
      get: (f) => (f.density != null ? `${f.density} g/cm³` : "—"),
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
      // dryingTime is stored in MINUTES (see Filament.ts canonical-unit
      // comment). Render as Xh Ym, the same shape NfcReadDialog uses.
      get: (f) => {
        if (f.dryingTime == null) return "—";
        const h = Math.floor(f.dryingTime / 60);
        const m = f.dryingTime % 60;
        if (h === 0) return `${m}m`;
        if (m === 0) return `${h}h`;
        return `${h}h ${m}m`;
      },
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
      get: (_f, i) => {
        const g = onHandGrams[i];
        // Gating on `> 0` (as this did) rendered a genuinely-empty roll as an
        // unknown. Only a null — not weight-tracked — is an em-dash.
        return g == null ? "—" : `${formatGrams(g)} g`;
      },
    },
  ];

  return (
    <main id="main-content" className="w-full px-4 py-8">
      <h1 className="text-3xl font-bold mb-2">{t("compare.title")}</h1>
      <p className="text-sm text-gray-500 mb-6">{t("compare.subtitle")}</p>

      {/* Selector */}
      <section className="mb-8">
        <h2 className="text-sm font-medium mb-2">
          {t("compare.selectPrompt", {
            count: selectedIds.length,
            max: MAX_COMPARE_FILAMENTS,
          })}
        </h2>
        {droppedFromLink > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400 mb-2">
            {t("compare.truncatedLink", {
              max: MAX_COMPARE_FILAMENTS,
              dropped: droppedFromLink,
            })}
          </p>
        )}
        <FilamentPicker
          filaments={allFilaments}
          selectedIds={selectedIdSet}
          onToggle={toggleFilament}
          maxSelections={MAX_COMPARE_FILAMENTS}
          ariaLabel={t("compare.pickerAriaLabel")}
        />
      </section>

      {/* Comparison grid.
          GH #1109: these gates used to be "loading && selected>0" and
          "!loading && empty && selected===0" — leaving the state "filaments
          are selected but none could be loaded" matched by NOTHING, which is
          how a 9-id link produced a silent blank page. The third branch below
          closes that hole for every cause: the over-cap 400, a malformed id,
          and a bookmarked link whose filaments were since trashed (which
          returns 200 with an empty array, so error-handling alone wouldn't
          have covered it). */}
      {loading && selectedIds.length > 0 && (
        <p className="text-sm text-gray-500">{t("common.loading")}</p>
      )}
      {!loading && selectedIds.length === 0 && (
        <p className="text-sm text-gray-500">{t("compare.emptyState")}</p>
      )}
      {!loading && selectedIds.length > 0 && comparison.length === 0 && (
        <div className="rounded border border-gray-200 dark:border-gray-800 p-4">
          <p className="text-sm text-red-600 dark:text-red-400">
            {error || t("compare.error.noneLoaded")}
          </p>
          <button
            type="button"
            onClick={() => {
              setDroppedFromLink(0);
              setSelectedIds([]);
            }}
            className="mt-3 px-3 py-1.5 text-sm rounded bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700"
          >
            {t("compare.clearSelection")}
          </button>
        </div>
      )}

      {comparison.length > 0 && comparison.length < selectedIds.length && (
        <p className="text-sm text-amber-700 dark:text-amber-400 mb-2">
          {t("compare.someUnavailable", {
            shown: comparison.length,
            requested: selectedIds.length,
          })}
        </p>
      )}

      {comparison.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-300 dark:border-gray-700">
                <th scope="col" className="text-left py-2 px-2 font-medium text-gray-500 sticky left-0 bg-white dark:bg-gray-950 z-10">
                  {t("compare.col.property")}
                </th>
                {comparison.map((f) => (
                  <th
                    key={f._id}
                    className="text-left py-2 px-3 font-medium min-w-[160px]"
                  >
                    {/* The swatch sits OUTSIDE the Link on purpose:
                        FilamentSwatch emits role="img" with an aria-label, so
                        nesting it would prepend the colour to the link's
                        accessible name ("#ff0000, Prusament PLA"). */}
                    <span className="flex items-center gap-2">
                      <FilamentSwatch
                        color={f.color}
                        secondaryColors={f.secondaryColors}
                        arrangement={deriveArrangement(f.optTags)}
                        finish={deriveFinish(f.optTags)}
                        size={16}
                        className="flex-shrink-0"
                      />
                      <Link
                        href={`/filaments/${f._id}`}
                        className="text-blue-600 hover:underline truncate"
                      >
                        {f.name}
                      </Link>
                    </span>
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

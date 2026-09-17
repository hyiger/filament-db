"use client";

import type { CSSProperties } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import {
  COLOR_FAMILIES,
  COLOR_SHADES,
  FAMILY_SWATCH_HEX,
  SHADED_FAMILIES,
  parseColorFacet,
  type ColorFacet,
  type ColorFacetInput,
  type ColorFamily,
  type TypeBreakdownEntry,
} from "@/lib/colorFamily";
import type { ColorFacetCount } from "@/lib/homeListVisibility";

type T = (key: string, params?: Record<string, string | number>) => string;

/** Families with no hue of their own: offered only when something is in them
 *  (or they're the active filter), so a library with no clear filament
 *  doesn't carry a permanently-dead chip. */
const CONDITIONAL_FAMILIES: ReadonlySet<ColorFamily> = new Set(["clear", "multi", "unknown"]);

/**
 * Human label for a facet: "Gray", or "Gray · Dark". The shade always follows
 * the family through the `colorFacet.facetLabel` template — never "Dark Gray"
 * word order, which the German adjective inflection ("Dunkelgrau" vs
 * "Dunkles Grau") can't be assembled from.
 */
export function colorFacetLabel(t: T, facet: ColorFacetInput): string {
  const parsed = typeof facet === "string" || facet == null ? parseColorFacet(facet) : facet;
  if (!parsed) return "";
  const family = t(`colorFacet.family.${parsed.family}`);
  return parsed.shade
    ? t("colorFacet.facetLabel", { family, shade: t(`colorFacet.shade.${parsed.shade}`) })
    : family;
}

/** The chip dot. Chromatic families paint their representative hex; the three
 *  non-hue buckets get a pattern (clear = checkerboard, multi = hue wheel,
 *  unknown = dashed empty ring). The ring keeps white/black dots visible on
 *  both themes. */
export function ColorFamilyDot({ family, size = 12 }: { family: ColorFamily; size?: number }) {
  const hex = FAMILY_SWATCH_HEX[family];
  let style: CSSProperties = { width: size, height: size };
  if (hex) {
    style = { ...style, backgroundColor: hex };
  } else if (family === "clear") {
    style = {
      ...style,
      backgroundImage: "repeating-conic-gradient(#d1d5db 0% 25%, #ffffff 0% 50%)",
      backgroundSize: "6px 6px",
    };
  } else if (family === "multi") {
    style = {
      ...style,
      backgroundImage:
        "conic-gradient(#D32F2F, #F57C00, #FBC02D, #43A047, #00A5A8, #1E63D6, #8E44AD, #D32F2F)",
    };
  }
  const ring =
    family === "unknown"
      ? "border border-dashed border-gray-400 dark:border-gray-500"
      : "ring-1 ring-black/10 dark:ring-white/25";
  return <span aria-hidden="true" className={`inline-block rounded-full shrink-0 ${ring}`} style={style} />;
}

interface Props {
  /** The active facet ("" = no color). */
  facet: string;
  onFacetChange: (facet: string) => void;
  counts: Record<ColorFacet, ColorFacetCount>;
  /** Type breakdown of the rows matching `facet` (see `typeBreakdown`). */
  breakdown: TypeBreakdownEntry[];
  /** The active `?type=` filter; when set, the types strip is informational. */
  typeFilter: string;
  onTypeSelect: (type: string) => void;
  /** Matching rows painted with the #808080 default (shown under No color). */
  blankDefaultCount: number;
}

const chipBase = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-colors";

function chipClass(active: boolean, empty: boolean, disabled: boolean): string {
  if (active) return `${chipBase} bg-blue-600 text-white border-blue-600`;
  if (disabled) {
    return `${chipBase} bg-transparent text-gray-400 dark:text-gray-600 border-gray-200 dark:border-gray-800 cursor-not-allowed`;
  }
  if (empty) {
    return `${chipBase} bg-transparent text-gray-400 dark:text-gray-500 border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700`;
  }
  return `${chipBase} bg-transparent text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500`;
}

function CountBadge({ count, active, empty }: { count: number; active: boolean; empty: boolean }) {
  return (
    <span
      className={`text-[10px] px-1 rounded ${
        active ? "bg-white/20" : empty ? "bg-gray-100 dark:bg-gray-900" : "bg-gray-200 dark:bg-gray-700"
      }`}
    >
      {count}
    </span>
  );
}

/**
 * Color facet: "Do I have dark grey filament?" / "What types of orange do I
 * have?" — color FIRST, with the type breakdown as the answer.
 *
 * Chips at `sm` and up (aria-pressed toggle buttons in a labelled group, like
 * FilamentPicker's type chips — NOT `role="tab"`, which this row isn't, see
 * GH #1007), a `<select>` below `sm` where a 16-chip row would eat the screen.
 * With a family active: shade chips (shaded families only, at every width) and
 * the types-in-stock strip. Every number is `colorFacetCounts`' — the same
 * visibility decision the list renders — so a chip never promises rows the
 * list doesn't show.
 */
export default function ColorFacetFilter({
  facet,
  onFacetChange,
  counts,
  breakdown,
  typeFilter,
  onTypeSelect,
  blankDefaultCount,
}: Props) {
  const { t } = useTranslation();
  const parsed = parseColorFacet(facet);
  const activeFamily = parsed?.family ?? null;

  // A chip is greyed when nothing is SHOWN, but stays clickable while the
  // out-of-stock toggle would reveal something — otherwise an all-used-up
  // color is unreachable except by hand-typing the URL.
  const familyEntries = COLOR_FAMILIES.filter((fam) => {
    if (fam === activeFamily) return true;
    if (!CONDITIONAL_FAMILIES.has(fam)) return true;
    return counts[fam].shown + counts[fam].hidden > 0;
  }).map((fam) => ({
    fam,
    count: counts[fam],
    active: fam === activeFamily,
  }));

  const isShaded = activeFamily !== null && (SHADED_FAMILIES as readonly string[]).includes(activeFamily);
  const inStockTypes = breakdown.filter((b) => b.inStock > 0);
  const outOfStockTotal = breakdown.reduce((sum, b) => sum + b.outOfStock, 0);

  return (
    <div className="mb-2 space-y-1.5">
      {/* sm and up: family chips */}
      <div
        className="hidden sm:flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label={t("colorFacet.aria.family")}
      >
        <button
          type="button"
          aria-pressed={facet === ""}
          onClick={() => onFacetChange("")}
          className={chipClass(facet === "", false, false)}
        >
          {t("colorFacet.allColors")}
        </button>
        {familyEntries.map(({ fam, count, active }) => {
          const empty = count.shown === 0;
          const disabled = empty && count.hidden === 0 && !active;
          return (
            <button
              key={fam}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              title={
                disabled
                  ? t("filter.emptyChip")
                  : empty
                    ? t("colorFacet.moreOutOfStock", { count: count.hidden })
                    : undefined
              }
              // Not a toggle: clicking the active family widens to any shade
              // (the family itself); "All colors" is the way out.
              onClick={() => onFacetChange(fam)}
              className={chipClass(active, empty, disabled)}
            >
              <ColorFamilyDot family={fam} />
              {t(`colorFacet.family.${fam}`)}
              <CountBadge count={count.shown} active={active} empty={empty} />
            </button>
          );
        })}
      </div>

      {/* below sm: one select, same options + counts */}
      <label className="flex sm:hidden items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
        <span>{t("colorFacet.label")}</span>
        <select
          value={activeFamily ?? ""}
          onChange={(e) => onFacetChange(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
        >
          <option value="">{t("colorFacet.allColors")}</option>
          {familyEntries.map(({ fam, count, active }) => (
            <option
              key={fam}
              value={fam}
              disabled={!active && count.shown + count.hidden === 0}
            >
              {`${t(`colorFacet.family.${fam}`)} (${count.shown})`}
            </option>
          ))}
        </select>
      </label>

      {parsed && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {isShaded && (
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label={t("colorFacet.aria.shade")}
            >
              <button
                type="button"
                aria-pressed={parsed.shade === null}
                onClick={() => onFacetChange(parsed.family)}
                className={chipClass(parsed.shade === null, false, false)}
              >
                {t("colorFacet.anyShade")}
              </button>
              {COLOR_SHADES.map((shade) => {
                const value = `${parsed.family}-${shade}` as ColorFacet;
                const count = counts[value];
                const active = parsed.shade === shade;
                const empty = count.shown === 0;
                const disabled = empty && count.hidden === 0 && !active;
                return (
                  <button
                    key={shade}
                    type="button"
                    aria-pressed={active}
                    disabled={disabled}
                    title={disabled ? t("filter.emptyChip") : undefined}
                    onClick={() => onFacetChange(value)}
                    className={chipClass(active, empty, disabled)}
                  >
                    {t(`colorFacet.shade.${shade}`)}
                    <CountBadge count={count.shown} active={active} empty={empty} />
                  </button>
                );
              })}
            </div>
          )}

          {(inStockTypes.length > 0 || outOfStockTotal > 0) && (
            <div
              className="flex flex-wrap items-center gap-1.5 text-xs"
              role="group"
              aria-label={t("colorFacet.aria.types")}
            >
              <span className="text-gray-500 dark:text-gray-400">{t("colorFacet.typesInStock")}</span>
              {inStockTypes.map((b) =>
                // With a type already selected the fetched list IS that type,
                // so the strip only confirms it — informational, not a control.
                typeFilter ? (
                  <span
                    key={b.type}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border ${
                      b.type === typeFilter
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
                        : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400"
                    }`}
                  >
                    {b.type}
                    <span className="text-[10px] opacity-75">{b.inStock}</span>
                  </span>
                ) : (
                  <button
                    key={b.type}
                    type="button"
                    onClick={() => onTypeSelect(b.type)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-blue-400 hover:text-blue-600 dark:hover:border-blue-500 dark:hover:text-blue-400"
                  >
                    {b.type}
                    <span className="text-[10px] text-gray-500 dark:text-gray-400">{b.inStock}</span>
                  </button>
                ),
              )}
              {outOfStockTotal > 0 && (
                <span className="text-gray-400 dark:text-gray-500">
                  {t("colorFacet.moreOutOfStock", { count: outOfStockTotal })}
                </span>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => onFacetChange("")}
            aria-label={t("colorFacet.clear")}
            title={t("colorFacet.clear")}
            className="text-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
          >
            ✕
          </button>
        </div>
      )}

      {parsed && (
        <p className="text-[11px] text-gray-400 dark:text-gray-500">
          {t("colorFacet.overlapHint")}
          {parsed.family === "unknown" && blankDefaultCount > 0 && (
            <> {t("colorFacet.sentinelHint", { count: blankDefaultCount })}</>
          )}
        </p>
      )}
    </div>
  );
}

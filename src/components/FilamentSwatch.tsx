"use client";

import type { CSSProperties } from "react";
import type { Finish } from "@/lib/filamentFinish";
import type { ColorArrangement } from "@/lib/filamentColors";
import { allColors, parentSwatchColors } from "@/lib/filamentColors";
import { useTranslation } from "@/i18n/TranslationProvider";

interface FilamentSwatchProps {
  /** Primary hex color string; ignored when `isParent` is true. May be
   *  null per OpenPrintTag spec key 19 (coextruded / rainbow filaments
   *  have no single primary — colors live in `secondaryColors`). */
  color: string | null | undefined;
  /** Additional color hexes mirroring OpenPrintTag spec keys 20–24.
   *  Multi-color treatment renders only when `arrangement` is set and
   *  this array has ≥1 entry; otherwise single-color rendering of the
   *  primary. */
  secondaryColors?: string[];
  /** Derived from `optTags` via `deriveArrangement()`:
   *   - "coextruded": equal-width vertical stripes
   *   - "gradient": linear-gradient left→right
   *   - "solid" (default): primary color only, ignoring `secondaryColors`
   *  Ignored when `isParent` is true. Finish overlays compose on top of
   *  the multi-color base; `transparent`/`translucent` apply to the
   *  primary only (multi-color + translucent isn't a meaningful
   *  real-world combination). */
  arrangement?: ColorArrangement;
  /**
   * True when this filament currently has ≥1 variant pointing at it. A
   * filament is never a parent unless it actually has variants — there is
   * no explicit flag on the schema; callers derive this from `hasVariants`
   * on the API response or from a non-empty `_variants` array on the
   * detail-page response.
   */
  isParent?: boolean;
  /**
   * GH #597: the colors of this parent's variants (the parent's own color
   * rides in via `color`). When `isParent` is true and at least one valid
   * color is known, the swatch renders a composite of the group's colors
   * instead of the neutral cross-hatch. Falls back to the cross-hatch when
   * empty / omitted. Ignored when `isParent` is false.
   */
  variantColors?: ReadonlyArray<string | null | undefined>;
  /**
   * Visual finish derived from the filament's optTags (callers run
   * `deriveFinish()` from `src/lib/filamentFinish.ts`; null = plain
   * solid fill). Ignored when `isParent` is true (parents are
   * finish-agnostic).
   */
  finish?: Finish | null;
  /** Pixel size for both width and height. Defaults to 20px (w-5 h-5). */
  size?: number;
  /** Outer shape. "square" shows noticeably more color area at the same
   *  footprint — the /inventory rows use it. */
  shape?: "circle" | "square";
  /** Optional extra class names (border styling, ring, etc.). */
  className?: string;
  /** Native `title` attribute — appears on hover. */
  title?: string;
  /** Accessibility label; falls back to title or color. */
  ariaLabel?: string;
}

/**
 * Renders a filament color swatch. Centralised so the parent-composite /
 * cross-hatch + finish renders are consistent across the inventory list,
 * detail page, parent picker, and dialogs.
 */
export default function FilamentSwatch({
  color,
  secondaryColors = [],
  arrangement = "solid",
  isParent = false,
  variantColors = [],
  finish = null,
  size = 20,
  shape = "circle",
  className = "",
  title,
  ariaLabel,
}: FilamentSwatchProps) {
  // `rounded-md` (not `-lg`/`-xl`) keeps the square clearly square at the
  // 16–32px sizes callers actually use.
  const roundedClass = shape === "square" ? "rounded-md" : "rounded-full";
  // GH #638: fallback labels go through the shared catalog so SR users
  // hear them localized (the context carries an en-based default, so the
  // component still works outside the provider).
  const { t } = useTranslation();
  const dimensionStyle: CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
  };

  // Parents render a composite of the group's actual colors (GH #597):
  // the parent's own color first, then each variant's. Only when the
  // caller actually supplied the variants' colors — otherwise (e.g. the
  // FilamentForm parent picker, which sets isParent without colors) keep
  // the neutral cross-hatch so the "this is a color group" cue isn't lost.
  if (isParent) {
    // Gate on the variants contributing ≥1 valid color — "group colors
    // known". Without that, the parent's own color alone would render a plain
    // solid swatch indistinguishable from a regular filament.
    const knownVariantColors = parentSwatchColors(variantColors);
    // Parent's own color + its secondaryColors first (covers a coextruded
    // parent whose primary is null), then the variants' colors.
    const groupColors =
      knownVariantColors.length > 0
        ? parentSwatchColors([color, ...secondaryColors, ...knownVariantColors])
        : [];
    if (groupColors.length > 0) {
      const label =
        ariaLabel ??
        t("swatch.colorGroupColors", { colors: groupColors.join(" / ") });
      const groupStyle: CSSProperties =
        groupColors.length === 1
          ? { ...dimensionStyle, backgroundColor: groupColors[0] }
          : {
              ...dimensionStyle,
              // Equal-width segments with hard stops — same construction as
              // the coextruded multi-color swatch below, so a parent group
              // and a coextruded filament read consistently.
              backgroundImage: `linear-gradient(to right, ${groupColors
                .map((c, i) => {
                  const start = ((i / groupColors.length) * 100).toFixed(2);
                  const end = (((i + 1) / groupColors.length) * 100).toFixed(2);
                  return `${c} ${start}%, ${c} ${end}%`;
                })
                .join(", ")})`,
            };
      return (
        <div
          className={`${roundedClass} border border-gray-300 dark:border-gray-600 flex-shrink-0 ${className}`}
          style={groupStyle}
          title={title ?? label}
          aria-label={label}
          role="img"
          data-parent="true"
          {...(groupColors.length > 1 ? { "data-multicolor": "true" } : {})}
        />
      );
    }
    // No colors known — keep the legacy neutral cross-hatch.
    const finalLabel = ariaLabel ?? t("swatch.colorGroup");
    const hatchStyle: CSSProperties = {
      ...dimensionStyle,
      backgroundColor: "#e5e7eb",
      backgroundImage: [
        "repeating-linear-gradient(45deg, rgba(75,85,99,0.55) 0 2px, transparent 2px 6px)",
        "repeating-linear-gradient(-45deg, rgba(75,85,99,0.55) 0 2px, transparent 2px 6px)",
      ].join(", "),
    };
    return (
      <div
        className={`${roundedClass} border border-gray-400 dark:border-gray-500 flex-shrink-0 dark:bg-gray-700 ${className}`}
        style={hatchStyle}
        title={title ?? t("swatch.colorGroup")}
        aria-label={finalLabel}
        role="img"
        data-parent="true"
        data-multicolor="true"
      />
    );
  }

  // Multi-color renders only when there's more than one color to show AND
  // an arrangement is set — single-color filaments and misconfigured
  // "arrangement without secondaries" cases both fall through to the
  // single-color path.
  const colorList = allColors({ color, secondaryColors });
  const isMultiColorMode =
    arrangement !== "solid" && colorList.length >= 2;

  const baseColor = color ?? colorList[0] ?? "#808080";
  const rgb = hexToRgb(baseColor);

  // A multi-color filament's aria-label and tooltip describe the
  // arrangement + every color, not just the (possibly null) primary.
  const multiColorDescription = isMultiColorMode
    ? t(
        arrangement === "coextruded"
          ? "swatch.coextrudedColors"
          : "swatch.gradientColors",
        { colors: colorList.join(" / ") },
      )
    : null;
  const finalLabel =
    ariaLabel ??
    multiColorDescription ??
    (finish
      ? `${title ?? baseColor} (${finish})`
      : title ?? t("swatch.colorSwatch", { color: baseColor }));
  const finalTitle = multiColorDescription
    ? `${multiColorDescription}${finish ? ` · ${finish}` : ""}`
    : finish
      ? `${title ?? baseColor} · ${finish}`
      : title;

  // Transparent / translucent: actual color as the base + a diagonal
  // cross-hatch overlay as the "see-through" cue. Do NOT revert to real
  // alpha over a light-grey checker — that washed dark colors into
  // mid-grey (a translucent smoky-black PVB rendered like the parent
  // "color group" swatch).
  //
  // Hatch line color is picked from the base color's luminance so the
  // pattern reads on both dark and light fills. Translucent uses a
  // denser/heavier hatch than transparent so the two finishes stay
  // visually distinct.
  //
  // Falls back to the checker treatment if we couldn't parse the hex —
  // unreachable in practice (every caller validates) but belt-and-braces.
  if ((finish === "transparent" || finish === "translucent") && rgb) {
    const isDark = relativeLuminance(rgb) < 0.5;
    const hatchOpacity = finish === "translucent" ? 0.55 : 0.3;
    const lineRgba = isDark
      ? `rgba(255, 255, 255, ${hatchOpacity})`
      : `rgba(31, 41, 55, ${hatchOpacity})`;
    const lineWidth = finish === "translucent" ? 2 : 1;
    const gap = finish === "translucent" ? 6 : 7;
    return (
      <div
        className={`${roundedClass} border border-gray-400 dark:border-gray-500 flex-shrink-0 relative overflow-hidden ${className}`}
        style={{ ...dimensionStyle, backgroundColor: baseColor }}
        title={finalTitle}
        aria-label={finalLabel}
        role="img"
        data-finish={finish}
      >
        {/* See-through cue; mirrors the parent "color group" hatch
            geometry so the visual vocabulary is consistent. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: [
              `repeating-linear-gradient(45deg, ${lineRgba} 0 ${lineWidth}px, transparent ${lineWidth}px ${gap}px)`,
              `repeating-linear-gradient(-45deg, ${lineRgba} 0 ${lineWidth}px, transparent ${lineWidth}px ${gap}px)`,
            ].join(", "),
          }}
        />
      </div>
    );
  }

  // Multi-color modes — base layer is stripes or gradient, finish overlay
  // composes on top per usual.
  if (isMultiColorMode) {
    const baseStyle: CSSProperties =
      arrangement === "gradient"
        ? {
            ...dimensionStyle,
            backgroundImage: `linear-gradient(to right, ${colorList.join(", ")})`,
          }
        : {
            ...dimensionStyle,
            // Coextruded: equal-width vertical stripes with hard stops.
            backgroundImage: `linear-gradient(to right, ${colorList
              .map((c, i) => {
                const start = ((i / colorList.length) * 100).toFixed(2);
                const end = (((i + 1) / colorList.length) * 100).toFixed(2);
                return `${c} ${start}%, ${c} ${end}%`;
              })
              .join(", ")})`,
          };
    const overlay = solidFinishOverlay(finish, rgb);
    return (
      <div
        className={`${roundedClass} border border-gray-300 dark:border-gray-600 flex-shrink-0 relative overflow-hidden ${className}`}
        style={baseStyle}
        title={finalTitle}
        aria-label={finalLabel}
        role="img"
        data-arrangement={arrangement}
        {...(finish ? { "data-finish": finish } : {})}
      >
        {overlay && (
          <div
            aria-hidden="true"
            style={{ position: "absolute", inset: 0, ...overlay }}
          />
        )}
      </div>
    );
  }

  // Solid-fill finishes (matte / silk / sparkle / glow) + plain.
  const overlay = solidFinishOverlay(finish, rgb);
  return (
    <div
      className={`${roundedClass} border border-gray-300 dark:border-gray-600 flex-shrink-0 relative overflow-hidden ${className}`}
      style={{ ...dimensionStyle, backgroundColor: baseColor }}
      title={finalTitle}
      aria-label={finalLabel}
      role="img"
      {...(finish ? { "data-finish": finish } : {})}
    >
      {overlay && (
        <div
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, ...overlay }}
        />
      )}
    </div>
  );
}

/**
 * CSS for the decorative overlay on top of the solid color fill. Returns
 * `null` for plain swatches (no overlay needed) and for matte (the
 * absence of a gloss highlight IS the matte treatment — the parent
 * element has no inset shadow either way).
 *
 * `rgb` is the parsed underlying color; we use its luminance to decide
 * sparkle speckle color so sparkles read on both light and dark fills.
 */
function solidFinishOverlay(
  finish: Finish | null,
  rgb: { r: number; g: number; b: number } | null,
): CSSProperties | null {
  if (!finish || finish === "matte") return null;

  if (finish === "silk") {
    // Soft white-to-transparent sheen on the upper-left — reads as a
    // satin highlight without obscuring the underlying color.
    return {
      backgroundImage:
        "radial-gradient(ellipse at 30% 28%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 60%)",
    };
  }

  if (finish === "sparkle") {
    // Speckle color flips on the fill's luminance so the effect reads on
    // light and dark fills alike. mix-blend-mode is intentionally NOT
    // used here — empirically it disappears on near-grey fills.
    const isDark = rgb ? relativeLuminance(rgb) < 0.5 : true;
    const dot = isDark ? "rgba(255,255,255,0.9)" : "rgba(31,41,55,0.55)";
    return {
      backgroundImage: [
        `radial-gradient(circle at 28% 28%, ${dot} 0 1px, transparent 2px)`,
        `radial-gradient(circle at 64% 38%, ${dot} 0 1px, transparent 2px)`,
        `radial-gradient(circle at 76% 70%, ${dot} 0 1px, transparent 2px)`,
        `radial-gradient(circle at 36% 70%, ${dot} 0 1px, transparent 2px)`,
      ].join(", "),
    };
  }

  if (finish === "glow") {
    // Soft phosphorescent inner halo — light-yellow to clear.
    return {
      boxShadow: "inset 0 0 6px 1px rgba(255, 247, 180, 0.85)",
    };
  }

  return null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.trim().replace(/^#/, "");
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b };
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b };
  }
  return null;
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  // Quick perceptual approximation (Rec. 601). Good enough to pick a
  // contrasting speckle color; full sRGB linearisation would be overkill.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * GH #449 — animated skeleton placeholders for data-heavy pages.
 *
 * Used by the inventory / dashboard / analytics pages during their
 * initial fetch so the layout doesn't reflow when content arrives.
 * Single class string (`animate-pulse bg-gray-200 dark:bg-gray-800`)
 * — kept here so a future tweak to the skeleton look only needs one
 * edit.
 */

import { CSSProperties } from "react";

/**
 * A single animated placeholder block. Pass `className` for sizing
 * (`h-4 w-32 rounded`, etc.) and an optional inline `style` for
 * exact-pixel widths the Tailwind scale doesn't cover.
 */
export function Skeleton({
  className = "h-4 w-full rounded",
  style,
  ariaLabel,
}: {
  className?: string;
  style?: CSSProperties;
  /** Provide for the wrapper region; individual blocks usually inherit
   *  the wrapper's `aria-live="polite"` and stay decorative. */
  ariaLabel?: string;
}) {
  return (
    <span
      className={`block animate-pulse bg-gray-200 dark:bg-gray-800 ${className}`}
      style={style}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : "true"}
    />
  );
}

/**
 * A wrapper that announces a loading region to screen readers
 * (`role="status"` + polite) and renders skeleton children visually.
 * Use this around the page's skeleton block so AT users hear "loading"
 * once instead of every individual block claiming to be a separate
 * region.
 */
export function SkeletonRegion({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className={className}
    >
      {children}
      <span className="sr-only">{label}</span>
    </div>
  );
}

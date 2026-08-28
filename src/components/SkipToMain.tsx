"use client";

import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslation } from "@/i18n/TranslationProvider";

/**
 * Skip-to-content link — visually hidden until focused, then a fixed-top
 * banner that jumps to `#main-content` (every page sets that id on its
 * outer <main>).
 *
 * The href is bound to `usePathname()` so the resolved URL the
 * accessibility tree exposes mutates on every client-side route change.
 * A bare `href="#main-content"` works at click time, but some
 * assistive-tech layers cache the resolved URL on first paint, leaving
 * the skip link pointing at the previous page after navigation; changing
 * the attribute value forces the AX cache to refresh.
 *
 * The current query string is included so URL-state pages (e.g.
 * /compare's `?ids=...`) keep their state when the link is activated.
 *
 * The Suspense fallback must NOT be null — `useSearchParams()` makes this
 * subtree client-render up to the boundary, so a null fallback would drop
 * the skip link from the initial HTML for keyboard / AT users with slow
 * JS. The fallback renders the fragment-only version; the inner component
 * upgrades it once searchParams resolve.
 */

/** Shared anchor renderer so the suspense fallback and the live
 *  inner have identical visuals and interaction. */
function SkipAnchor({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[1000] focus:bg-blue-600 focus:text-white focus:px-3 focus:py-2 focus:rounded focus:shadow-lg focus:no-underline"
    >
      {label}
    </a>
  );
}

function SkipToMainInner() {
  const { t } = useTranslation();
  const pathname = usePathname() || "/";
  const searchParams = useSearchParams();
  const qs = searchParams?.toString() ?? "";
  const href = `${pathname}${qs ? `?${qs}` : ""}#main-content`;
  return <SkipAnchor href={href} label={t("a11y.skipToContent")} />;
}

function SkipToMainFallback() {
  const { t } = useTranslation();
  // Bare `#main-content` works at click time (the browser resolves
  // fragments against document.location), so this fallback is a fully
  // functional skip link — just without the AX-cache-busting
  // pathname/query enrichment the inner adds post-hydration.
  return <SkipAnchor href="#main-content" label={t("a11y.skipToContent")} />;
}

export default function SkipToMain() {
  return (
    <Suspense fallback={<SkipToMainFallback />}>
      <SkipToMainInner />
    </Suspense>
  );
}

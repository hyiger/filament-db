"use client";

import { usePathname } from "next/navigation";
import { useTranslation } from "@/i18n/TranslationProvider";

/**
 * GH #413 — Skip-to-content link.
 *
 * The persistent AppHeader has 7+ nav links + status pills that
 * keyboard users would otherwise have to tab through on every page.
 * This component prepends a link that's visually hidden until it
 * receives focus, then surfaces as a fixed-top banner the user can
 * activate with Enter to jump straight to `#main-content`.
 *
 * Every page sets `id="main-content"` on its outer <main> element so
 * the anchor target is consistent.
 *
 * #493: bind the href to `usePathname()` so the resolved URL the
 * accessibility tree exposes mutates on every client-side route
 * change. A bare `href="#main-content"` is semantically correct
 * (browsers resolve fragments against `document.location` at click
 * time, so the link works), but some assistive-tech layers cache
 * the resolved URL on first paint — users on /dashboard saw the
 * skip link still pointing at /settings#main-content after
 * navigation. Including pathname in the rendered href changes the
 * attribute value, which forces the AX cache to refresh.
 */
export default function SkipToMain() {
  const { t } = useTranslation();
  const pathname = usePathname() || "/";
  return (
    <a
      href={`${pathname}#main-content`}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[1000] focus:bg-blue-600 focus:text-white focus:px-3 focus:py-2 focus:rounded focus:shadow-lg focus:no-underline"
    >
      {t("a11y.skipToContent")}
    </a>
  );
}

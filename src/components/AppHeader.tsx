"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

const LINKS: { href: string; labelKey: string; exact?: boolean }[] = [
  { href: "/", labelKey: "common.filaments", exact: true },
  { href: "/dashboard", labelKey: "common.dashboard" },
  { href: "/compare", labelKey: "common.compare" },
  { href: "/analytics", labelKey: "common.analytics" },
  { href: "/share", labelKey: "common.share" },
  { href: "/settings", labelKey: "common.settings" },
];

/**
 * Persistent app shell rendered by the root layout. A slim sticky bar with the
 * brand link on the left, the primary nav inline on ≥sm screens, and a
 * hamburger that opens a drawer below the bar on smaller screens.
 *
 * Replaces the older per-page <AppNav /> + per-page "← Back to filaments"
 * pattern. Sub-pages can now drop their back links — every page has the home
 * brand link in the bar.
 */
export default function AppHeader() {
  const pathname = usePathname();
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Drawer closes on link click (handler below) — no useEffect on pathname,
  // which the React Compiler rule flags as a cascading-render anti-pattern.
  const closeDrawer = () => setMobileOpen(false);

  const isActive = (link: { href: string; exact?: boolean }) => {
    if (link.exact) return pathname === link.href;
    return pathname === link.href || pathname.startsWith(link.href + "/");
  };

  const baseClass =
    "px-2.5 py-1 rounded-md text-sm font-medium transition-colors";
  const inactiveClass =
    "text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800";
  const activeClass =
    "bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200";

  return (
    <header className="sticky top-0 z-40 bg-white/95 dark:bg-gray-950/95 backdrop-blur border-b border-gray-200 dark:border-gray-800">
      <div className="max-w-7xl mx-auto px-4 h-12 flex items-center justify-between gap-3">
        <Link
          href="/"
          className="font-semibold text-base sm:text-lg whitespace-nowrap text-gray-900 dark:text-gray-100 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
        >
          {t("filaments.title")}
        </Link>
        {/* Desktop nav — hidden on mobile */}
        <nav className="hidden md:flex items-center gap-1" aria-label="Primary">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link) ? "page" : undefined}
              className={`${baseClass} ${isActive(link) ? activeClass : inactiveClass}`}
            >
              {t(link.labelKey)}
            </Link>
          ))}
        </nav>
        {/* Mobile hamburger — hidden on ≥md */}
        <button
          type="button"
          className="md:hidden p-1.5 -mr-1.5 rounded-md text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? t("nav.closeMenu") : t("nav.openMenu")}
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            {mobileOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>
      {/* Mobile drawer — only renders when open */}
      {mobileOpen && (
        <nav
          id="mobile-nav"
          className="md:hidden border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950"
          aria-label="Primary mobile"
        >
          <div className="max-w-7xl mx-auto px-4 py-2 flex flex-col gap-1">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={closeDrawer}
                aria-current={isActive(link) ? "page" : undefined}
                className={`${baseClass} ${isActive(link) ? activeClass : inactiveClass}`}
              >
                {t(link.labelKey)}
              </Link>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}

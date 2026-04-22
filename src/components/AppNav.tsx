"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "@/i18n/TranslationProvider";

interface Props {
  /** Optional prefix element — e.g. a back link or the page title — shown
   *  to the left of the nav links. */
  leading?: React.ReactNode;
}

const LINKS: { href: string; labelKey: string; exact?: boolean }[] = [
  { href: "/", labelKey: "common.filaments", exact: true },
  { href: "/dashboard", labelKey: "common.dashboard" },
  { href: "/compare", labelKey: "common.compare" },
  { href: "/analytics", labelKey: "common.analytics" },
  { href: "/share", labelKey: "common.share" },
];

/**
 * Top-of-page navigation row used on the filament list and anywhere else we
 * want consistent access to the core sections. Renders:
 *   [leading?]   Filaments  Dashboard  Compare  Analytics  Share   ⚙ Settings
 *
 * The active route gets a solid-pill treatment and the inactive ones get a
 * subtle hover background so they read as clickable without competing for
 * attention with the page title.
 */
export default function AppNav({ leading }: Props) {
  const pathname = usePathname();
  const { t } = useTranslation();

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
    <nav className="flex items-center gap-1 flex-wrap" aria-label="Primary">
      {leading}
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
      <Link
        href="/settings"
        aria-current={pathname.startsWith("/settings") ? "page" : undefined}
        className={`${baseClass} ${pathname.startsWith("/settings") ? activeClass : inactiveClass} flex items-center gap-1`}
      >
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
          />
        </svg>
        {t("common.settings")}
      </Link>
    </nav>
  );
}

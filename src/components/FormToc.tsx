"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { expandAndScrollToSection } from "./CollapsibleSection";

export interface TocEntry {
  /** Must match the corresponding `<CollapsibleSection id>`. */
  id: string;
  /** Label shown in the TOC. */
  label: string;
}

interface Props {
  entries: TocEntry[];
  /** When true, FormToc renders nothing (mobile uses a different affordance —
   *  see FormTocMobileButton below). */
  hideOnMobile?: boolean;
}

/**
 * Sticky sidebar table of contents for the FilamentForm. Each entry jumps to
 * the matching CollapsibleSection (uncollapsing it if needed) and the entry
 * for whichever section is currently in view gets highlighted via a small
 * IntersectionObserver-driven scroll-spy.
 *
 * Why a separate component:
 * - Keeps the form file readable — the form doesn't need to know about
 *   IntersectionObserver, scrolling, or persisted UI state.
 * - The same TOC shape can be reused later for other long forms (Printer
 *   profile expansion, the dashboard config screen we keep talking about).
 *
 * Why no react-router/href anchors:
 * - Anchor links would re-scroll on hash change but wouldn't open a
 *   collapsed section. The buttons let us coordinate "open + scroll".
 */
export default function FormToc({ entries, hideOnMobile = true }: Props) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string | null>(entries[0]?.id ?? null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("IntersectionObserver" in window)) return;

    // The observer fires whenever a section header crosses the rootMargin
    // band near the top of the viewport. We pick the most recently
    // intersecting one as "active" — simpler than maintaining a sorted set
    // of candidate ratios across all sections.
    const observer = new IntersectionObserver(
      (records) => {
        // Prefer entries that are intersecting; among those, pick the
        // top-most (smallest boundingClientRect.top). That matches the
        // intuition "the section near the top of my viewport is active".
        const intersecting = records.filter((r) => r.isIntersecting);
        if (intersecting.length === 0) return;
        intersecting.sort(
          (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
        );
        setActiveId(intersecting[0].target.id);
      },
      {
        // Trigger when the section header is within the top quarter of the
        // viewport — feels right for a long form with plenty of content
        // below the title.
        rootMargin: "0px 0px -75% 0px",
        threshold: 0,
      },
    );

    for (const e of entries) {
      const el = document.getElementById(e.id);
      if (el) observer.observe(el);
    }

    observerRef.current = observer;
    return () => observer.disconnect();
  }, [entries]);

  const handleClick = (id: string) => {
    expandAndScrollToSection(id);
    setActiveId(id);
  };

  return (
    <nav
      aria-label={t("form.toc.aria")}
      className={`${hideOnMobile ? "hidden lg:block" : ""} sticky top-4 self-start max-h-[calc(100vh-2rem)] overflow-y-auto pr-2`}
    >
      <ul className="space-y-0.5 text-sm">
        {entries.map((e) => {
          const isActive = activeId === e.id;
          return (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => handleClick(e.id)}
                aria-current={isActive ? "true" : undefined}
                className={`block w-full text-left px-2 py-1 rounded transition-colors ${
                  isActive
                    ? "bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200 font-medium"
                    : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                {e.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Mobile-only floating "jump to section" button + popover. Renders nothing
 * above the `lg` breakpoint (where the desktop sidebar takes over).
 */
export function FormTocMobileButton({ entries }: { entries: TocEntry[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Close the popover whenever the user picks an entry.
  const handleClick = (id: string) => {
    expandAndScrollToSection(id);
    setOpen(false);
  };

  // Click-outside to close.
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={popRef} className="lg:hidden fixed bottom-4 right-4 z-40">
      {open && (
        <div className="mb-2 max-h-[60vh] w-56 overflow-y-auto bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl py-1">
          <ul className="text-sm">
            {entries.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => handleClick(e.id)}
                  className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  {e.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("form.toc.aria.jump")}
        aria-expanded={open}
        className="w-12 h-12 rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 flex items-center justify-center"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
    </div>
  );
}

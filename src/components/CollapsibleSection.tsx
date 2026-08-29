"use client";

import { useEffect, useState, type ReactNode } from "react";

interface Props {
  /** Stable identifier — used as the DOM id for scroll-into-view, the aria
   * relationship between header and panel, and the localStorage key for
   * persisted open/closed state. Use a kebab-case slug. */
  id: string;
  title: string;
  subtitle?: string;
  /** Open state on first mount when no localStorage preference has been
   * written yet. Default false. */
  defaultOpen?: boolean;
  /** Optional badge content rendered after the title — e.g. a red pill when
   * a section contains validation errors. */
  badge?: ReactNode;
  children: ReactNode;
}

function storageKey(id: string): string {
  return `filamentdb-form-section-${id}`;
}

/** SSR-safe (returns the caller's default during server render) and
 * survives a missing/disabled localStorage. */
function readStoredOpen(id: string, defaultOpen: boolean): boolean {
  if (typeof window === "undefined") return defaultOpen;
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // ignore
  }
  return defaultOpen;
}

/**
 * Collapsible section wrapper used to chunk the long Edit Filament form
 * into skimmable groups.
 *
 * - Skips rendering the body when collapsed — avoids expensive sub-trees
 *   (the calibration grid in particular) running on every form re-render.
 *   Re-opening re-mounts the body; that's fine because every input in
 *   FilamentForm reads/writes the parent's `form` state, so there's no
 *   local component state to lose.
 * - Open/closed persists per-section in localStorage.
 * - Imperative open via the exported expandAndScrollToSection helper
 *   ("open the offending section + scroll" on validation error) without
 *   lifting state to the parent.
 *
 * SSR: `defaultOpen` during SSR, post-mount effect re-reads the persisted
 * value; `suppressHydrationWarning` on the wrapping section covers the
 * case where the persisted value differs from the default.
 */
export default function CollapsibleSection({
  id,
  title,
  subtitle,
  defaultOpen = false,
  badge,
  children,
}: Props) {
  const [open, setOpen] = useState<boolean>(defaultOpen);

  // Read the persisted preference on mount. We can't use a lazy initializer
  // for `open` because localStorage is undefined during SSR, and using it
  // would cause a hydration mismatch when the persisted value differs from
  // defaultOpen. We accept one re-render after hydration in exchange.
  useEffect(() => {
    const stored = readStoredOpen(id, defaultOpen);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post-hydration sync from localStorage
    if (stored !== defaultOpen) setOpen(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(id), String(open));
    } catch {
      // ignore
    }
  }, [id, open]);

  // Listen for synthetic storage events fired by expandAndScrollToSection so
  // the form's submit-error handler can pop a collapsed section open from
  // outside the React tree without a parent state lift.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKey(id)) return;
      if (e.newValue === "true") setOpen(true);
      else if (e.newValue === "false") setOpen(false);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [id]);

  const headerId = `${id}-header`;
  const panelId = `${id}-panel`;

  return (
    <section
      id={id}
      suppressHydrationWarning
      className="border border-gray-300 dark:border-gray-700 rounded scroll-mt-20"
    >
      <button
        type="button"
        id={headerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900/50 rounded-t transition-colors"
      >
        <svg
          aria-hidden="true"
          className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 12 12"
          fill="currentColor"
        >
          <path d="M4 2l4 4-4 4z" />
        </svg>
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {title}
        </span>
        {subtitle && (
          <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {subtitle}
          </span>
        )}
        {badge && <span className="ml-auto">{badge}</span>}
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={headerId}
        hidden={!open}
        className="px-4 pb-4 pt-1"
      >
        {/* Body not rendered when collapsed — see the component header. */}
        {open && children}
      </div>
    </section>
  );
}

/**
 * Imperative helper used by the form's submit handler when validation fails
 * inside a collapsed section: it un-collapses the section (writes localStorage
 * + dispatches a storage event so the live React tree picks it up) and
 * scrolls into view. Falls back to a no-op outside the browser.
 */
export function expandAndScrollToSection(id: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storageKey(id), "true");
  } catch {
    // ignore
  }
  // The mounted CollapsibleSection won't pick up a same-tab localStorage
  // write — fire a synthetic storage event so it can react.
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: storageKey(id),
      newValue: "true",
    }),
  );
  // GH #284: the body is conditionally rendered, so on the tick the
  // storage event is dispatched it has not laid out yet — scrolling now
  // would land on the still-collapsed header. A double rAF waits for
  // React to commit the expanded body and the browser to lay it out.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });
}

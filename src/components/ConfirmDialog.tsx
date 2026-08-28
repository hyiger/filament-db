"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

/**
 * In-app confirm replacement for native `window.confirm()` — native
 * confirms don't theme and block CDP/automation (the renderer freezes
 * while open).
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (await confirm({ message: "Delete this filament?" })) { ... }
 *
 * Resolves `true` on confirm, `false` on cancel (including Escape /
 * outside-click). One pending dialog at a time; calling again replaces
 * the first.
 */

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive action. */
  destructive?: boolean;
  /** Hide the cancel button — an acknowledge-only notice. The confirm
   * button (and Esc / outside-click) still resolve, so the promise
   * always settles. */
  hideCancel?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    // Tests / storybook may render components outside the provider.
    // Fall back to native confirm so behaviour stays usable rather than
    // silently no-op.
    return (opts) => {
      const msg = typeof opts === "string" ? opts : opts.message;
      return Promise.resolve(
        typeof window !== "undefined" ? window.confirm(msg) : false,
      );
    };
  }
  return ctx;
}

interface PendingState {
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

export default function ConfirmProvider({ children }: { children: ReactNode }) {
  // Button-label fallbacks come from the shared `common.*` translation
  // keys — callers rarely pass labels, so the fallback is effectively the
  // production label and must follow the active locale.
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingState | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  // Needed for the Tab-key focus trap below.
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback<ConfirmFn>((arg) => {
    const opts: ConfirmOptions =
      typeof arg === "string" ? { message: arg } : arg;
    return new Promise<boolean>((resolve) => {
      // If a previous prompt is still open, resolve it as a cancel so the
      // caller's promise doesn't dangle.
      setPending((prev) => {
        if (prev) prev.resolve(false);
        return { opts, resolve };
      });
    });
  }, []);

  const decide = useCallback((answer: boolean) => {
    setPending((prev) => {
      if (prev) prev.resolve(answer);
      return null;
    });
  }, []);

  // Focus the confirm button when the dialog opens; Esc cancels from
  // anywhere. Enter is deliberately left to the browser — a document-level
  // Enter→decide(true) mapping would confirm the destructive action even
  // when the user tabbed to Cancel; with focus on the confirm button Enter
  // naturally triggers it, and on any other focused button Enter activates
  // THAT button.
  //
  // aria-modal="true" on its own doesn't trap Tab — focus escapes to
  // background page controls while the overlay is up. Cycle Tab/Shift+Tab
  // between the two buttons.
  //
  // GH #1081: capture the invoking element BEFORE focusing the confirm
  // button and restore it on cleanup (like every other modal, GH #320) —
  // otherwise focus drops to <body> on close. The `document.contains`
  // guard covers the confirm path where the triggering control was
  // removed (a deleted row) — restoring focus to a detached node is a
  // silent no-op that still leaves focus on <body>.
  useEffect(() => {
    if (!pending) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    confirmBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        decide(false);
        return;
      }
      if (e.key === "Tab") {
        const focusables = [cancelBtnRef.current, confirmBtnRef.current].filter(
          (el): el is HTMLButtonElement => el != null,
        );
        if (focusables.length === 0) return;
        const active = document.activeElement as HTMLElement | null;
        const idx = active ? focusables.indexOf(active as HTMLButtonElement) : -1;
        // Focus is outside the modal — yank it back to the first focusable.
        if (idx === -1) {
          e.preventDefault();
          focusables[0].focus();
          return;
        }
        const dir = e.shiftKey ? -1 : 1;
        const next = (idx + dir + focusables.length) % focusables.length;
        e.preventDefault();
        focusables[next].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.();
    };
  }, [pending, decide]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50"
          role="dialog"
          aria-modal="true"
          // When the caller doesn't pass a `title`, fall back to a
          // translated `aria-label` so the dialog always has an
          // accessible name; the message text is reachable separately
          // via `aria-describedby`.
          aria-labelledby={pending.opts.title ? "confirm-title" : undefined}
          aria-label={pending.opts.title ? undefined : t("common.confirmDialog")}
          aria-describedby="confirm-message"
          onClick={(e) => {
            // Outside-click = cancel
            if (e.target === e.currentTarget) decide(false);
          }}
        >
          <div className="w-full max-w-md mx-4 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl p-5">
            {pending.opts.title && (
              <h2 id="confirm-title" className="text-base font-semibold mb-2">
                {pending.opts.title}
              </h2>
            )}
            <p id="confirm-message" className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">
              {pending.opts.message}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              {!pending.opts.hideCancel && (
                <button
                  ref={cancelBtnRef}
                  type="button"
                  onClick={() => decide(false)}
                  className="px-4 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  {pending.opts.cancelLabel ?? t("common.cancel")}
                </button>
              )}
              <button
                ref={confirmBtnRef}
                type="button"
                onClick={() => decide(true)}
                className={`px-4 py-1.5 rounded text-white text-sm ${
                  pending.opts.destructive
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-blue-600 hover:bg-blue-700"
                }`}
              >
                {pending.opts.confirmLabel ?? t("common.ok")}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

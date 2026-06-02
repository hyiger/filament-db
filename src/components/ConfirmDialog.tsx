"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

/**
 * GH #343 (#1): in-app confirm replacement for native `window.confirm()`.
 *
 * Why a custom modal:
 *   - Native confirms don't theme (jarring on the dark UI).
 *   - They block CDP/automation (the renderer freezes while open),
 *     which broke the Chrome QA pass and any future Playwright suite.
 *   - "Delete" rows currently use them; mixing styled buttons with an
 *     OS-chrome dialog reads as unfinished.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (await confirm({ message: "Delete this filament?" })) { ... }
 *
 * The returned promise resolves to `true` on confirm, `false` on cancel
 * (including Escape / outside-click).
 *
 * Behaviour parity with `window.confirm`:
 *   - returns a falsy value when the user cancels
 *   - blocks no JavaScript (it's async)
 *   - one pending dialog at a time; calling again replaces the first
 */

export interface ConfirmOptions {
  /** The body text. Required. */
  message: string;
  /** Optional bolded title above the body. */
  title?: string;
  /** Confirm-button label. Defaults to "OK". */
  confirmLabel?: string;
  /** Cancel-button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** When true, the confirm button is styled as a destructive action. */
  destructive?: boolean;
  /** When true, hide the cancel button — turns the dialog into a simple
   * acknowledge-only notice (e.g. an aggregated error report). The
   * confirm button (and Esc / outside-click) still resolve, so the
   * promise always settles. */
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
  // Codex P2 on PR #351: the cancel-button fallback used to be the
  // English literal "Cancel"; callers never pass `cancelLabel`, so the
  // fallback was effectively the production label and shipped in every
  // non-English locale. Pull both fallbacks (cancel + ok) from the
  // shared `common.*` translation keys so they follow the active locale.
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingState | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  // Codex P2 round 2: needed for the Tab-key focus trap below — the
  // confirm-button ref alone wasn't enough to cycle focus between the
  // two buttons.
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
  // anywhere. Codex P1 on PR #351 round 1: the previous document-level
  // handler ALSO mapped Enter→decide(true) unconditionally, so a keyboard
  // user who tabbed to Cancel and hit Enter still confirmed the
  // destructive action (and `preventDefault` suppressed the focused
  // button's normal activation). Enter is now left to the browser —
  // autoFocus on the confirm button means Enter naturally triggers it
  // when nothing else has been focused; on a different focused button
  // (e.g. Cancel), pressing Enter activates THAT button.
  //
  // Codex P2 round 2: aria-modal="true" on its own doesn't trap Tab —
  // after the two buttons, focus escapes to background page controls
  // while the overlay is still up. Cycle Tab/Shift+Tab between the two
  // buttons so focus stays inside the dialog until it's dismissed.
  useEffect(() => {
    if (!pending) return;
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
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, decide]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50"
          role="dialog"
          aria-modal="true"
          // Codex P2 round 2: when the caller doesn't pass a `title`,
          // `aria-labelledby` used to be `undefined` and there was no
          // accessible name at all — screen readers announced an unnamed
          // dialog. Fall back to a translated `aria-label` so the dialog
          // always has a name. The message text is reachable separately
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

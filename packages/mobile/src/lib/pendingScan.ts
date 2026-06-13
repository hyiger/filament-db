import type { DecodedOpenPrintTag } from './types';

/**
 * A one-shot hand-off for the decoded tag between the scan screen and the
 * create-from-tag confirm screen. expo-router params are strings, and the
 * decoded tag is a nested object the create screen must POST back verbatim as
 * `tagData`, so we stash it in a module ref instead of URL-encoding it.
 *
 * `peek` reads WITHOUT clearing so it's safe to call from a `useState` lazy
 * initializer — React StrictMode and the React Compiler (enabled in
 * app.config.ts) may invoke initializers more than once to detect impure
 * renders, and a read-and-clear there would hand `null` to the second
 * invocation. The screen clears explicitly via `clearPendingScan` after a
 * successful create. A stale value can't leak into a later flow: the scan
 * screen always calls `setPendingScan` immediately before navigating here, so
 * the ref is freshly overwritten on every entry.
 */
let pending: DecodedOpenPrintTag | null = null;

export function setPendingScan(tag: DecodedOpenPrintTag): void {
  pending = tag;
}

/** Read the pending scan without consuming it (safe during render). */
export function peekPendingScan(): DecodedOpenPrintTag | null {
  return pending;
}

/** Clear the hand-off — call from an event handler, never during render. */
export function clearPendingScan(): void {
  pending = null;
}

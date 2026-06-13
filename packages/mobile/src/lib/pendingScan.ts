import type { DecodedOpenPrintTag, Filament } from './types';

/**
 * Hand-off from the scan screen to the create-from-tag confirm screen: the
 * decoded tag plus any existing filaments the decode route matched
 * heuristically (a single vendor+type/name match, or several candidates). The
 * confirm screen offers those as "open an existing one" before the create form,
 * so a re-scanned roll isn't steered into a duplicate. expo-router params are
 * strings, so we stash the nested objects in a module ref instead of
 * URL-encoding them.
 *
 * `peek` reads WITHOUT clearing so it's safe in a `useState` lazy initializer —
 * React StrictMode and the React Compiler (enabled in app.config.ts) may invoke
 * initializers more than once to detect impure renders, and a read-and-clear
 * there would hand `null` to the second invocation. The screen clears
 * explicitly via `clearPendingScan` once it navigates away. A stale value can't
 * leak into a later flow: the scan screen always calls `setPendingScan`
 * immediately before navigating here, so the ref is freshly overwritten.
 */
export interface PendingScan {
  decoded: DecodedOpenPrintTag;
  /** Existing filaments the decode route matched (heuristically); may be empty. */
  matches: Filament[];
}

let pending: PendingScan | null = null;

export function setPendingScan(scan: PendingScan): void {
  pending = scan;
}

/** Read the pending scan without consuming it (safe during render). */
export function peekPendingScan(): PendingScan | null {
  return pending;
}

/** Clear the hand-off — call from an event handler, never during render. */
export function clearPendingScan(): void {
  pending = null;
}

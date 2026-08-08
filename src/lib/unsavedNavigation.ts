/**
 * Decision logic for how `useUnsavedChanges` should perform a programmatic
 * departure from a form page (after a save, or after "Discard Changes").
 *
 * Extracted from the hook because the repo's vitest env is `node` with no
 * jsdom harness — the hook itself can't be exercised in a test, but this
 * decision can, and it is the part that was wrong in GH #1100.
 *
 * ## Background
 *
 * `useUnsavedChanges` pushes one synthetic "guard" history entry on mount so
 * it can intercept the browser Back button (the guard shares the form's URL,
 * so popping it is visually invisible). GH #510/#548 established that the
 * guard must be CONSUMED on every programmatic exit, never left buried under
 * the destination, or the stack accumulates a dead entry per form visit.
 *
 * #548 consumed it with `history.back()` and then issued `router.push(dest)`
 * from inside the resulting `popstate` handler. That is the GH #1100 bug: the
 * guard shares the form's URL, so the `back()` lands on the form's own entry
 * and Next's App Router popstate restore re-renders the form — swallowing the
 * `router.push` that ran in the same event. The save succeeded, the toast
 * fired, and the user was left sitting on a fully populated form.
 *
 * The fix is to stop routing the departure through `popstate` at all. When our
 * guard is the live current entry, `router.replace(dest)` overwrites it — the
 * guard is consumed and the resulting stack is *identical* to what
 * `back()` + `push()` was intended to produce ([prev, form, dest]), with no
 * event round-trip to race against. When the guard is not live (already spent
 * by a Back press, or never established), there is nothing to consume and a
 * plain `push` is correct — replacing there would eat a legitimate entry.
 */

/** How a programmatic departure should be performed. */
export type LeaveMode = "replace" | "push";

/**
 * Build the state object for our synthetic guard entry, carrying forward
 * whatever the current entry already holds.
 *
 * This matters because of WHEN the guard is pushed. React flushes passive
 * effects child-first, so on a hard load (direct URL, reload, deep link) this
 * hook's effect runs BEFORE its ancestor AppRouter's — and AppRouter patches
 * `window.history.pushState` inside that same late effect. The guard therefore
 * goes through the UNPATCHED native pushState and lands with only our own key,
 * missing Next's `__NA` marker and its internals tree.
 *
 * Next's own popstate handler treats a state without `__NA` as an entry from
 * the old `pages` router and responds with a full `window.location.reload()`
 * (`next/dist/client/components/app-router.js`). So pressing Back from a
 * hard-loaded form did a hard page reload instead of a client-side restore.
 *
 * Copying the current state and adding our marker keeps `__NA` and the
 * internals tree intact, so Next restores normally. On a client-side
 * navigation the patched pushState would have merged those keys anyway, which
 * is why the bug only ever showed on a hard load.
 */
export function buildGuardState(currentState: unknown): Record<string, unknown> {
  const base =
    typeof currentState === "object" && currentState !== null
      ? { ...(currentState as Record<string, unknown>) }
      : {};
  base.unsavedGuard = true;
  return base;
}

/**
 * True when `state` is the synthetic guard entry this hook pushed.
 *
 * Deliberately tolerant of any shape: `history.state` is `unknown` at runtime
 * (Next.js replaces it with its own internal tree on every navigation, and a
 * hard reload yields `null`), so this must not assume an object.
 */
export function isUnsavedGuardState(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { unsavedGuard?: unknown }).unsavedGuard === true
  );
}

/**
 * Pick the navigation mode for a programmatic departure.
 *
 * `"replace"` only when we still believe our guard is live (`guardActive`) AND
 * the browser agrees it is the current entry (`historyState` carries our
 * marker). Both conditions are required: `guardActive` alone can be stale
 * after a `router.push` buried the guard, and the marker alone could in
 * principle survive on an entry we no longer own.
 */
export function decideLeaveMode(guardActive: boolean, historyState: unknown): LeaveMode {
  return guardActive && isUnsavedGuardState(historyState) ? "replace" : "push";
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buildGuardState, decideLeaveMode, isUnsavedGuardState } from "@/lib/unsavedNavigation";

/**
 * Hook to manage unsaved-changes warnings across form pages. Guards back
 * link clicks (handleBack / guardLink) and the browser back/forward
 * buttons (popstate interception).
 *
 * ## History-stack hygiene (GH #510)
 *
 * To intercept the browser Back button in the App Router we push one
 * synthetic "guard" history entry on mount. EVERY programmatic departure
 * must route through `navigate()` / `confirmNav()`, which consume the
 * guard — a bare `router.push` buries it under the destination and the
 * stack accumulates dead entries across edits.
 *
 * ## How the guard is consumed (GH #1100)
 *
 * Do NOT consume it with `history.back()` + `router.push(dest)` from the
 * resulting `popstate` handler — that races Next's own popstate handling:
 * on a HARD LOAD (direct URL, reload, deep link) React flushes passive
 * effects child-first, so this hook's popstate listener registers BEFORE
 * the ancestor AppRouter's and runs first; our `router.push` becomes
 * `actionQueue.pending`, then Next's handler dispatches `ACTION_RESTORE`
 * for the same event and marks any pending action `discarded` — the push
 * is silently dropped and the form re-renders. (Client-side entry
 * registers AppRouter's listener first, so the failure depends on the
 * entry path.)
 *
 * `leave()` therefore consumes the guard with `router.replace(dest)`,
 * which overwrites the guard entry directly — same resulting stack
 * ([prev, form, dest]) with no `popstate` round-trip to race against.
 * See `src/lib/unsavedNavigation.ts` for the (unit-tested) mode decision.
 */
export function useUnsavedChanges(fallbackUrl: string) {
  const router = useRouter();
  const dirtyRef = useRef(false);
  // True while our synthetic guard entry is live and (as far as we know) the
  // current top of the history stack.
  const guardActiveRef = useRef(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [pendingNav, setPendingNav] = useState<string | null>(null);

  const onDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);

  // Consume our guard entry (when it is still live + current) as part of the
  // navigation, so the guard isn't left buried under the destination. Shared
  // by `navigate()` and the link-click branch of `confirmNav()`.
  const leave = useCallback(
    (url: string) => {
      dirtyRef.current = false;
      if (decideLeaveMode(guardActiveRef.current, window.history.state) === "replace") {
        // Overwrite the guard entry with the destination (see the GH #1100
        // note in the hook docblock).
        guardActiveRef.current = false;
        router.replace(url);
      } else {
        router.push(url);
      }
    },
    [router],
  );

  // Intercept browser back/forward when form is dirty.
  useEffect(() => {
    // Push a duplicate history entry so we can intercept popstate. The state
    // carries forward whatever the current entry holds (see buildGuardState —
    // dropping Next's `__NA` makes its popstate handler hard-reload the page).
    const url = window.location.href;
    window.history.pushState(buildGuardState(window.history.state), "", url);
    guardActiveRef.current = true;

    const handlePopState = () => {
      if (dirtyRef.current) {
        // Re-push to cancel the back press, then show the dialog.
        window.history.pushState(buildGuardState(window.history.state), "", url);
        guardActiveRef.current = true;
        setPendingNav(null); // null = popstate (go back in history)
        setShowUnsavedDialog(true);
      } else {
        // Not dirty: the back press consumed our guard entry. Let the browser
        // proceed normally (the guard shares the form URL, so a subsequent
        // back leaves the form for real). Mark the guard spent so cleanup
        // doesn't try to pop a second time.
        guardActiveRef.current = false;
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      // Pop our guard on unmount ONLY if it is still the live current entry
      // (e.g. strict-mode double-invoke, or an unmount that didn't route
      // through navigate()/confirmNav()). If a router.push already buried
      // it, history.state is no longer ours and we must NOT pop — that
      // goes back one entry too far.
      if (guardActiveRef.current && isUnsavedGuardState(window.history.state)) {
        guardActiveRef.current = false;
        window.history.back();
      }
    };
    // router from next/navigation is a stable reference, so this runs once.
  }, [router]);

  /** Attach to onClick of back/navigation links */
  const handleBack = useCallback(
    (e: React.MouseEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        setPendingNav(fallbackUrl);
        setShowUnsavedDialog(true);
      }
    },
    [fallbackUrl],
  );

  /** Attach to onClick of any arbitrary link that should be guarded */
  const guardLink = useCallback(
    (href: string) => (e: React.MouseEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        setPendingNav(href);
        setShowUnsavedDialog(true);
      }
    },
    [],
  );

  /**
   * Programmatic navigation away from the form — e.g. after a successful save.
   * Use this INSTEAD of calling `router.push` directly so the guard entry is
   * consumed rather than buried (GH #510).
   */
  const navigate = useCallback(
    (url: string) => {
      setShowUnsavedDialog(false);
      setPendingNav(null);
      leave(url);
    },
    [leave],
  );

  /** User chose "Discard Changes" */
  const confirmNav = useCallback(() => {
    setShowUnsavedDialog(false);
    if (pendingNav !== null) {
      // Link-click navigation — consume the guard then go to the chosen URL.
      const dest = pendingNav;
      setPendingNav(null);
      leave(dest);
    } else {
      // popstate navigation — go back for real. GH #285: the popstate handler
      // re-pushed a guard entry to cancel the user's back press, so history is
      // [...prev, formPage, guard] with `guard` current. `go(-1)` only reaches
      // `formPage` (same URL as the guard) and strands the user on the form;
      // `go(-2)` skips past it to the page they were actually trying to return
      // to.
      dirtyRef.current = false;
      guardActiveRef.current = false;
      window.history.go(-2);
    }
  }, [pendingNav, leave]);

  /** User chose "Keep Editing" */
  const cancelNav = useCallback(() => {
    setShowUnsavedDialog(false);
    setPendingNav(null);
  }, []);

  return {
    dirtyRef,
    onDirtyChange,
    showUnsavedDialog,
    setShowUnsavedDialog,
    pendingNav,
    handleBack,
    guardLink,
    navigate,
    confirmNav,
    cancelNav,
  };
}

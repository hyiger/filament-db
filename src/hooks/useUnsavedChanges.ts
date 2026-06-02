"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Hook to manage unsaved-changes warnings across form pages.
 *
 * Returns:
 *  - dirtyRef          – mutable ref tracking dirty state (for synchronous reads)
 *  - onDirtyChange     – stable callback to pass as prop to form components
 *  - showUnsavedDialog – whether the confirmation dialog should be visible
 *  - setShowUnsavedDialog – setter to open/close the dialog
 *  - pendingNav        – the URL the user was trying to navigate to (null if popstate)
 *  - handleBack        – click handler to attach to back links (e.preventDefault + show dialog)
 *  - guardLink         – click handler factory for arbitrary guarded links
 *  - navigate          – programmatic navigation (e.g. after a successful save)
 *                        that consumes the guard entry first (see below)
 *  - confirmNav        – call this when the user clicks "Discard Changes"
 *  - cancelNav         – call this when the user clicks "Keep Editing"
 *
 * Protects against:
 *  - Back link clicks (via handleBack / guardLink)
 *  - Browser back/forward buttons (via popstate interception)
 *
 * ## History-stack hygiene (GH #510)
 *
 * To intercept the browser Back button in the App Router we push one synthetic
 * "guard" history entry on mount. The original implementation never removed
 * that entry on the programmatic exit paths (`router.push` after save /
 * discard), so the guard ended up buried under the destination and a fresh one
 * was pushed on every form visit — the stack accumulated dead entries across
 * edits.
 *
 * The fix routes EVERY programmatic departure through `navigate()` /
 * `confirmNav()`, which consume the guard with `history.back()` BEFORE pushing
 * the destination, so it is never left buried. The unmount cleanup pops the
 * guard too, but ONLY when it is still the live current entry
 * (`history.state.unsavedGuard === true`). That guard-the-pop condition is the
 * crux of the fix: the first attempt popped unconditionally on unmount, which
 * went back one entry too far whenever the destination was already current
 * (the exact reason that attempt was reverted).
 */
export function useUnsavedChanges(fallbackUrl: string) {
  const router = useRouter();
  const dirtyRef = useRef(false);
  // True while our synthetic guard entry is live and (as far as we know) the
  // current top of the history stack.
  const guardActiveRef = useRef(false);
  // When set, the next popstate is our own back() consuming the guard ahead of
  // a programmatic navigation; the handler reads + clears it and pushes.
  const pendingLeaveRef = useRef<string | null>(null);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [pendingNav, setPendingNav] = useState<string | null>(null);

  const onDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);

  // Consume our guard entry (when it is still live + current) and THEN run the
  // navigation, so the guard isn't left buried under the destination. Shared
  // by `navigate()` and the link-click branch of `confirmNav()`.
  const leave = useCallback(
    (url: string) => {
      dirtyRef.current = false;
      if (guardActiveRef.current && window.history.state?.unsavedGuard) {
        guardActiveRef.current = false;
        pendingLeaveRef.current = url;
        // Pops the guard; the popstate handler below sees pendingLeaveRef and
        // completes the navigation once the back() settles.
        window.history.back();
      } else {
        router.push(url);
      }
    },
    [router],
  );

  // Intercept browser back/forward when form is dirty.
  useEffect(() => {
    // Push a duplicate history entry so we can intercept popstate.
    const url = window.location.href;
    window.history.pushState({ unsavedGuard: true }, "", url);
    guardActiveRef.current = true;

    const handlePopState = () => {
      // A programmatic leave we initiated: complete the navigation now that
      // our back() has consumed the guard entry.
      if (pendingLeaveRef.current !== null) {
        const dest = pendingLeaveRef.current;
        pendingLeaveRef.current = null;
        router.push(dest);
        return;
      }
      if (dirtyRef.current) {
        // Re-push to cancel the back press, then show the dialog.
        window.history.pushState({ unsavedGuard: true }, "", url);
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
      // (e.g. React strict-mode double-invoke in dev, or an unexpected unmount
      // that didn't route through navigate()/confirmNav()). If a router.push
      // already buried it, history.state is no longer ours and we must NOT pop
      // — popping there is the original #510 over-pop bug.
      if (guardActiveRef.current && window.history.state?.unsavedGuard) {
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

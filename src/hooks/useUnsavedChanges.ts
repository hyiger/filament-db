"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
 *  - confirmNav        – call this when the user clicks "Discard Changes"
 *  - cancelNav         – call this when the user clicks "Keep Editing"
 *
 * Protects against:
 *  - Back link clicks (via handleBack)
 *  - Browser back/forward buttons (via popstate interception)
 */
export function useUnsavedChanges(fallbackUrl: string) {
  const dirtyRef = useRef(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [pendingNav, setPendingNav] = useState<string | null>(null);

  const onDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);

  // Intercept browser back/forward when form is dirty
  useEffect(() => {
    // Push a duplicate history entry so we can intercept popstate
    const url = window.location.href;
    window.history.pushState({ unsavedGuard: true }, "", url);

    const handlePopState = () => {
      if (dirtyRef.current) {
        // Re-push to prevent navigation, then show dialog
        window.history.pushState({ unsavedGuard: true }, "", url);
        setPendingNav(null); // null = popstate (go back in history)
        setShowUnsavedDialog(true);
      }
      // If not dirty, the browser navigates normally since we consumed
      // our guard entry and the real history entry is next
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

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

  /** User chose "Discard Changes" */
  const confirmNav = useCallback(() => {
    dirtyRef.current = false; // prevent popstate handler from re-triggering
    setShowUnsavedDialog(false);
    if (pendingNav) {
      // Link-click navigation — let the router handle it
      // (caller will do router.push)
    } else {
      // popstate navigation — go back for real
      window.history.go(-1);
    }
  }, [pendingNav]);

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
    confirmNav,
    cancelNav,
  };
}

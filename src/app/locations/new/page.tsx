"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import LocationForm from "@/app/locations/LocationForm";
import { useToast } from "@/components/Toast";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useTranslation } from "@/i18n/TranslationProvider";
import { readReturnPath } from "@/lib/returnTo";

const LOCATIONS_FALLBACK = "/locations";

/** Module-level so the reference is stable across renders. */
const subscribeToNothing = () => () => {};

export default function NewLocation() {
  const { toast } = useToast();
  const { t } = useTranslation();

  // #1117(h): the spool move-to dropdowns send the user here from deep inside
  // a list, so `?from=` carries where to go back to. Read from
  // `window.location` in a lazy initializer rather than `useSearchParams` —
  // that hook demands a Suspense boundary, and this page has no other reason
  // for one (the same pattern the detail page uses for `?spool=`). The value
  // is validated as a same-origin path before anything navigates to it; a
  // missing or hostile one falls back to /locations, the pre-#1117 behaviour.
  // Read through useSyncExternalStore, NOT a lazy `useState` initializer
  // (Codex P2). This component is still server-rendered, and a
  // `typeof window` check inside an initializer produces different first
  // renders on the two sides — the server emits the fallback while the client
  // emits `/inventory`, a hydration mismatch that can leave the Back link
  // pointing at the server's target. `getServerSnapshot` makes the two agree
  // by construction: React renders the fallback through hydration and swaps
  // in the real value straight after, with no mismatch and no setState in an
  // effect (which `react-hooks/set-state-in-effect` forbids here anyway).
  //
  // `subscribe` is a no-op: `?from=` can only change by navigating here
  // again, which remounts the page.
  const returnTo = useSyncExternalStore(
    subscribeToNothing,
    () => readReturnPath(window.location.search, LOCATIONS_FALLBACK),
    () => LOCATIONS_FALLBACK,
  );

  const { onDirtyChange, showUnsavedDialog, handleBack, navigate, confirmNav, cancelNav } =
    useUnsavedChanges(returnTo);

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch("/api/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast(t("locations.created"));
      navigate(returnTo);
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("locations.createError"), "error");
    }
  };

  return (
    <main id="main-content" className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href={returnTo} className="text-blue-600 hover:underline text-sm" onClick={handleBack}>
          {t("locations.backToLocations")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{t("locations.addNewTitle")}</h1>
      <LocationForm onSubmit={handleSubmit} onDirtyChange={onDirtyChange} />

      {showUnsavedDialog && (
        <UnsavedChangesDialog onCancel={cancelNav} onDiscard={confirmNav} />
      )}
    </main>
  );
}

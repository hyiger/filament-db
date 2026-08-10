"use client";

import Link from "next/link";
import { useState } from "react";
import LocationForm from "@/app/locations/LocationForm";
import { useToast } from "@/components/Toast";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useTranslation } from "@/i18n/TranslationProvider";
import { readReturnPath } from "@/lib/returnTo";

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
  const [returnTo] = useState(() =>
    typeof window === "undefined"
      ? "/locations"
      : readReturnPath(window.location.search, "/locations"),
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

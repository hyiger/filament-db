"use client";

import Link from "next/link";
import LocationForm from "@/app/locations/LocationForm";
import { useToast } from "@/components/Toast";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function NewLocation() {
  const { toast } = useToast();
  const { t } = useTranslation();

  const { onDirtyChange, showUnsavedDialog, handleBack, navigate, confirmNav, cancelNav } =
    useUnsavedChanges("/locations");

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch("/api/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast(t("locations.created"));
      navigate("/locations");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("locations.createError"), "error");
    }
  };

  return (
    <main id="main-content" className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/locations" className="text-blue-600 hover:underline text-sm" onClick={handleBack}>
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

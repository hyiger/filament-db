"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import LocationForm from "@/app/locations/LocationForm";
import { useToast } from "@/components/Toast";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function EditLocation() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [location, setLocation] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  const { onDirtyChange, showUnsavedDialog, handleBack, confirmNav, cancelNav, pendingNav } =
    useUnsavedChanges("/locations");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/locations/${params.id}`, { signal: controller.signal })
      .then((r) => {
        if (r.status === 404) {
          setNotFound(true);
          return null;
        }
        if (!r.ok) {
          setFetchError(true);
          return null;
        }
        return r.json();
      })
      .then((data) => {
        if (data) setLocation(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setFetchError(true);
      });
    return () => controller.abort();
  }, [params.id]);

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch(`/api/locations/${params.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast(t("locations.updated"));
      router.push("/locations");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("locations.updateError"), "error");
    }
  };

  const handleDiscard = () => {
    confirmNav();
    router.push(pendingNav ?? "/locations");
  };

  if (notFound)
    return (
      <div className="p-8">
        <p className="text-red-500 mb-4">{t("locations.notFound")}</p>
        <Link href="/locations" className="text-blue-600 hover:underline text-sm">
          &larr; {t("locations.backToLocations")}
        </Link>
      </div>
    );
  if (fetchError)
    return (
      <div className="p-8">
        <p className="text-red-500 mb-4">{t("locations.fetchError")}</p>
        <Link href="/locations" className="text-blue-600 hover:underline text-sm">
          &larr; {t("locations.backToLocations")}
        </Link>
      </div>
    );
  if (!location) return <p className="p-8 text-gray-500">{t("locations.loading")}</p>;

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/locations" className="text-blue-600 hover:underline text-sm" onClick={handleBack}>
          &larr; {t("locations.backToLocations")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{t("locations.editTitle")}</h1>
      <LocationForm initialData={location} onSubmit={handleSubmit} onDirtyChange={onDirtyChange} />

      {showUnsavedDialog && (
        <UnsavedChangesDialog onCancel={cancelNav} onDiscard={handleDiscard} />
      )}
    </main>
  );
}

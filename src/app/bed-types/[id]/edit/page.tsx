"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import BedTypeForm from "@/app/bed-types/BedTypeForm";
import { useToast } from "@/components/Toast";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function EditBedType() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [bedType, setBedType] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  const {
    onDirtyChange, showUnsavedDialog, handleBack,
    confirmNav, cancelNav, pendingNav,
  } = useUnsavedChanges("/bed-types");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/bed-types/${params.id}`, { signal: controller.signal })
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        if (!r.ok) { setFetchError(true); return null; }
        return r.json();
      })
      .then((data) => { if (data) setBedType(data); })
      .catch((err) => { if (err.name !== "AbortError") setFetchError(true); });
    return () => controller.abort();
  }, [params.id]);

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch(`/api/bed-types/${params.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast(t("bedTypes.updated"));
      router.push("/bed-types");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("bedTypes.updateError"), "error");
    }
  };

  const handleDiscard = () => {
    confirmNav();
    router.push(pendingNav ?? "/bed-types");
  };

  if (notFound) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">{t("bedTypes.notFound")}</p>
      <Link href="/bed-types" className="text-blue-600 hover:underline text-sm">&larr; {t("bedTypes.backToBedTypes")}</Link>
    </div>
  );
  if (fetchError) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">{t("bedTypes.fetchError")}</p>
      <Link href="/bed-types" className="text-blue-600 hover:underline text-sm">&larr; {t("bedTypes.backToBedTypes")}</Link>
    </div>
  );
  if (!bedType) return <p className="p-8 text-gray-500">{t("bedTypes.loading")}</p>;

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/bed-types" className="text-blue-600 hover:underline text-sm" onClick={handleBack}>
          &larr; {t("bedTypes.backToBedTypes")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{t("bedTypes.editTitle")}</h1>
      <BedTypeForm initialData={bedType} onSubmit={handleSubmit} onDirtyChange={onDirtyChange} />

      {showUnsavedDialog && (
        <UnsavedChangesDialog onCancel={cancelNav} onDiscard={handleDiscard} />
      )}
    </main>
  );
}

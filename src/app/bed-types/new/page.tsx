"use client";

import Link from "next/link";
import BedTypeForm from "@/app/bed-types/BedTypeForm";
import { useToast } from "@/components/Toast";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function NewBedType() {
  const { toast } = useToast();
  const { t } = useTranslation();

  const {
    onDirtyChange, showUnsavedDialog, handleBack,
    navigate, confirmNav, cancelNav,
  } = useUnsavedChanges("/bed-types");

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch("/api/bed-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast(t("bedTypes.created"));
      navigate("/bed-types");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("bedTypes.createError"), "error");
    }
  };

  return (
    <main id="main-content" className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/bed-types" className="text-blue-600 hover:underline text-sm" onClick={handleBack}>
          {t("bedTypes.backToBedTypes")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{t("bedTypes.addNewTitle")}</h1>
      <BedTypeForm onSubmit={handleSubmit} onDirtyChange={onDirtyChange} />

      {showUnsavedDialog && (
        <UnsavedChangesDialog onCancel={cancelNav} onDiscard={confirmNav} />
      )}
    </main>
  );
}

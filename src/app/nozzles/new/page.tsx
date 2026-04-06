"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import NozzleForm from "@/app/nozzles/NozzleForm";
import { useToast } from "@/components/Toast";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function NewNozzle() {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();

  const {
    onDirtyChange, showUnsavedDialog, handleBack,
    confirmNav, cancelNav, pendingNav,
  } = useUnsavedChanges("/nozzles");

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch("/api/nozzles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast(t("nozzles.created"));
      router.push("/nozzles");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("nozzles.createError"), "error");
    }
  };

  const handleDiscard = () => {
    confirmNav();
    router.push(pendingNav ?? "/nozzles");
  };

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/nozzles" className="text-blue-600 hover:underline text-sm" onClick={handleBack}>
          {t("nozzles.backToNozzles")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{t("nozzles.addNewTitle")}</h1>
      <NozzleForm onSubmit={handleSubmit} onDirtyChange={onDirtyChange} />

      {showUnsavedDialog && (
        <UnsavedChangesDialog onCancel={cancelNav} onDiscard={handleDiscard} />
      )}
    </main>
  );
}

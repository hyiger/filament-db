"use client";

import Link from "next/link";
import PrinterForm from "@/app/printers/PrinterForm";
import { useToast } from "@/components/Toast";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useTranslation } from "@/i18n/TranslationProvider";
import { NozzleConflictError, type NozzleConflict } from "@/lib/nozzleConflicts";

export default function NewPrinter() {
  const { toast } = useToast();
  const { t } = useTranslation();

  const {
    onDirtyChange, showUnsavedDialog, handleBack,
    navigate, confirmNav, cancelNav,
  } = useUnsavedChanges("/printers");

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch("/api/printers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast(t("printers.created"));
      navigate("/printers");
      return;
    }
    // GH #232 — a 409 with `conflicts[]` means one or more of the
    // selected nozzles is already installed in another printer. Throw
    // a typed error so PrinterForm can open the move-or-clone modal
    // instead of just showing a generic toast.
    const body = await res.json().catch(() => null);
    if (res.status === 409 && Array.isArray(body?.conflicts)) {
      throw new NozzleConflictError(body.conflicts as NozzleConflict[]);
    }
    toast(body?.error || t("printers.createError"), "error");
  };

  return (
    <main id="main-content" className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/printers" className="text-blue-600 hover:underline text-sm" onClick={handleBack}>
          {t("printers.backToPrinters")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{t("printers.addNewTitle")}</h1>
      <PrinterForm onSubmit={handleSubmit} onDirtyChange={onDirtyChange} />

      {showUnsavedDialog && (
        <UnsavedChangesDialog onCancel={cancelNav} onDiscard={confirmNav} />
      )}
    </main>
  );
}

"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import PrinterForm from "@/app/printers/PrinterForm";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function NewPrinter() {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch("/api/printers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast(t("printers.created"));
      router.push("/printers");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("printers.createError"), "error");
    }
  };

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/printers" className="text-blue-600 hover:underline text-sm">
          {t("printers.backToPrinters")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{t("printers.addNewTitle")}</h1>
      <PrinterForm onSubmit={handleSubmit} />
    </main>
  );
}

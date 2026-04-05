"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import PrinterForm from "@/app/printers/PrinterForm";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function EditPrinter() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [printer, setPrinter] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/printers/${params.id}`, { signal: controller.signal })
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        if (!r.ok) { setFetchError(true); return null; }
        return r.json();
      })
      .then((data) => { if (data) setPrinter(data); })
      .catch((err) => { if (err.name !== "AbortError") setFetchError(true); });
    return () => controller.abort();
  }, [params.id]);

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch(`/api/printers/${params.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast(t("printers.updated"));
      router.push("/printers");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("printers.updateError"), "error");
    }
  };

  if (notFound) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">{t("printers.notFound")}</p>
      <Link href="/printers" className="text-blue-600 hover:underline text-sm">&larr; {t("printers.backToPrinters")}</Link>
    </div>
  );
  if (fetchError) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">{t("printers.fetchError")}</p>
      <Link href="/printers" className="text-blue-600 hover:underline text-sm">&larr; {t("printers.backToPrinters")}</Link>
    </div>
  );
  if (!printer) return <p className="p-8 text-gray-500">{t("printers.loading")}</p>;

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/printers" className="text-blue-600 hover:underline text-sm">
          &larr; {t("printers.backToPrinters")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{t("printers.editTitle")}</h1>
      <PrinterForm initialData={printer} onSubmit={handleSubmit} />
    </main>
  );
}

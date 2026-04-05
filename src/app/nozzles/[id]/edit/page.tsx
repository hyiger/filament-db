"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import NozzleForm from "@/app/nozzles/NozzleForm";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function EditNozzle() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [nozzle, setNozzle] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/nozzles/${params.id}`, { signal: controller.signal })
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        if (!r.ok) { setFetchError(true); return null; }
        return r.json();
      })
      .then((data) => { if (data) setNozzle(data); })
      .catch((err) => { if (err.name !== "AbortError") setFetchError(true); });
    return () => controller.abort();
  }, [params.id]);

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch(`/api/nozzles/${params.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast(t("nozzles.updated"));
      router.push("/nozzles");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("nozzles.updateError"), "error");
    }
  };

  if (notFound) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">{t("nozzles.notFound")}</p>
      <Link href="/nozzles" className="text-blue-600 hover:underline text-sm">&larr; {t("nozzles.backToNozzles")}</Link>
    </div>
  );
  if (fetchError) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">{t("nozzles.fetchError")}</p>
      <Link href="/nozzles" className="text-blue-600 hover:underline text-sm">&larr; {t("nozzles.backToNozzles")}</Link>
    </div>
  );
  if (!nozzle) return <p className="p-8 text-gray-500">{t("nozzles.loading")}</p>;

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/nozzles" className="text-blue-600 hover:underline text-sm">
          &larr; {t("nozzles.backToNozzles")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{t("nozzles.editTitle")}</h1>
      <NozzleForm initialData={nozzle} onSubmit={handleSubmit} />
    </main>
  );
}

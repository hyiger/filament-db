"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import PrinterForm from "@/app/printers/PrinterForm";
import { useToast } from "@/components/Toast";

export default function EditPrinter() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const [printer, setPrinter] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    fetch(`/api/printers/${params.id}`)
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        if (!r.ok) { setFetchError(true); return null; }
        return r.json();
      })
      .then((data) => { if (data) setPrinter(data); })
      .catch(() => setFetchError(true));
  }, [params.id]);

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch(`/api/printers/${params.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast("Printer updated");
      router.push("/printers");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || "Failed to update printer", "error");
    }
  };

  if (notFound) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">Printer not found. It may have been deleted.</p>
      <Link href="/printers" className="text-blue-600 hover:underline text-sm">&larr; Back to Printers</Link>
    </div>
  );
  if (fetchError) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">Failed to load printer. Please try again.</p>
      <Link href="/printers" className="text-blue-600 hover:underline text-sm">&larr; Back to Printers</Link>
    </div>
  );
  if (!printer) return <p className="p-8 text-gray-500">Loading...</p>;

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/printers" className="text-blue-600 hover:underline text-sm">
          &larr; Back to printers
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">Edit Printer</h1>
      <PrinterForm initialData={printer} onSubmit={handleSubmit} />
    </main>
  );
}

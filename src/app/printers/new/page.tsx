"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import PrinterForm from "@/app/printers/PrinterForm";
import { useToast } from "@/components/Toast";

export default function NewPrinter() {
  const router = useRouter();
  const { toast } = useToast();

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch("/api/printers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      toast("Printer created");
      router.push("/printers");
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || "Failed to create printer", "error");
    }
  };

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/printers" className="text-blue-600 hover:underline text-sm">
          &larr; Back to printers
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">Add New Printer</h1>
      <PrinterForm onSubmit={handleSubmit} />
    </main>
  );
}

"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import NozzleForm from "@/app/nozzles/NozzleForm";

export default function NewNozzle() {
  const router = useRouter();

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch("/api/nozzles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      router.push("/nozzles");
    }
  };

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/nozzles" className="text-blue-600 hover:underline text-sm">
          &larr; Back to nozzles
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">Add New Nozzle</h1>
      <NozzleForm onSubmit={handleSubmit} />
    </main>
  );
}

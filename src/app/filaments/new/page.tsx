"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import FilamentForm from "@/app/filaments/FilamentForm";

export default function NewFilament() {
  const router = useRouter();

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch("/api/filaments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      router.push("/");
    }
  };

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; Back to list
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">Add New Filament</h1>
      <FilamentForm onSubmit={handleSubmit} />
    </main>
  );
}

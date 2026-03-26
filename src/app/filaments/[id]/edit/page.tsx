"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import FilamentForm from "@/app/filaments/FilamentForm";

export default function EditFilament() {
  const params = useParams();
  const router = useRouter();
  const [filament, setFilament] = useState(null);

  useEffect(() => {
    fetch(`/api/filaments/${params.id}`)
      .then((r) => r.json())
      .then(setFilament);
  }, [params.id]);

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch(`/api/filaments/${params.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      router.push(`/filaments/${params.id}`);
    }
  };

  if (!filament) return <p className="p-8 text-gray-500">Loading...</p>;

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href={`/filaments/${params.id}`} className="text-blue-600 hover:underline text-sm">
          &larr; Back to detail
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">Edit Filament</h1>
      <FilamentForm initialData={filament} onSubmit={handleSubmit} />
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import FilamentForm from "@/app/filaments/FilamentForm";

export default function EditFilament() {
  const params = useParams();
  const router = useRouter();
  const [filament, setFilament] = useState(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/filaments/${params.id}`)
      .then((r) => {
        if (!r.ok) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data) => { if (data) setFilament(data); });
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

  if (notFound) return <p className="p-8 text-red-500">Filament not found. It may have been deleted.</p>;
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

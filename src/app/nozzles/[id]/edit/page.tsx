"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import NozzleForm from "@/app/nozzles/NozzleForm";

export default function EditNozzle() {
  const params = useParams();
  const router = useRouter();
  const [nozzle, setNozzle] = useState(null);

  useEffect(() => {
    fetch(`/api/nozzles/${params.id}`)
      .then((r) => r.json())
      .then(setNozzle);
  }, [params.id]);

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch(`/api/nozzles/${params.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      router.push("/nozzles");
    }
  };

  if (!nozzle) return <p className="p-8 text-gray-500">Loading...</p>;

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/nozzles" className="text-blue-600 hover:underline text-sm">
          &larr; Back to nozzles
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">Edit Nozzle</h1>
      <NozzleForm initialData={nozzle} onSubmit={handleSubmit} />
    </main>
  );
}

"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import FilamentForm from "@/app/filaments/FilamentForm";
import { useToast } from "@/components/Toast";

function NewFilamentContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const handleSubmit = async (data: Record<string, unknown>) => {
    const res = await fetch("/api/filaments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      const created = await res.json();
      toast("Filament created");
      router.push(`/filaments/${created._id}`);
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || "Failed to create filament", "error");
    }
  };

  // Build initial data from NFC query params
  let initialData: Record<string, unknown> | undefined;
  if (searchParams.get("from_nfc")) {
    const nozzleMax = searchParams.get("nozzle") ? Number(searchParams.get("nozzle")) : null;
    const nozzleMin = searchParams.get("nozzleMin") ? Number(searchParams.get("nozzleMin")) : null;
    const bedMax = searchParams.get("bed") ? Number(searchParams.get("bed")) : null;
    const bedMin = searchParams.get("bedMin") ? Number(searchParams.get("bedMin")) : null;
    const weight = searchParams.get("weight") ? Number(searchParams.get("weight")) : null;

    initialData = {
      name: searchParams.get("name") || "",
      vendor: searchParams.get("vendor") || "",
      type: searchParams.get("type") || "PLA",
      color: searchParams.get("color") || "#808080",
      density: searchParams.get("density") ? Number(searchParams.get("density")) : null,
      diameter: searchParams.get("diameter") ? Number(searchParams.get("diameter")) : 1.75,
      temperatures: {
        nozzle: nozzleMax,
        nozzleFirstLayer: nozzleMin ?? nozzleMax,
        bed: bedMax,
        bedFirstLayer: bedMin ?? bedMax,
      },
      ...(weight != null ? { netFilamentWeight: weight } : {}),
      settings: {
        ...(searchParams.get("chamber")
          ? { chamber_temperature: searchParams.get("chamber") }
          : {}),
        ...(searchParams.get("country")
          ? { filament_notes: `"Origin: ${searchParams.get("country")}"` }
          : {}),
      },
    };
  }

  // Support creating a variant from a parent via ?parentId=
  const parentId = searchParams.get("parentId");
  const [parentData, setParentData] = useState<Record<string, unknown> | null>(null);
  const [parentLoading, setParentLoading] = useState(!!parentId);

  useEffect(() => {
    if (parentId) {
      setParentLoading(true);
      fetch(`/api/filaments/${parentId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then(setParentData)
        .catch(() => {})
        .finally(() => setParentLoading(false));
    }
  }, [parentId]);

  if (parentId) {
    initialData = {
      ...(initialData || {}),
      parentId,
      vendor: parentData?.vendor || "",
      type: parentData?.type || "",
    };
  }

  const title = searchParams.get("from_nfc")
    ? "New Filament from NFC Tag"
    : parentId
      ? "Add Color Variant"
      : "Add New Filament";

  // Wait for parent data to load before rendering form so initialData is complete
  if (parentId && parentLoading) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-8">
        <div className="mb-4">
          <Link href="/" className="text-blue-600 hover:underline text-sm">
            &larr; Back to list
          </Link>
        </div>
        <h1 className="text-2xl font-bold mb-6">{title}</h1>
        <p className="text-gray-500">Loading parent filament...</p>
      </main>
    );
  }

  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; Back to list
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{title}</h1>
      <FilamentForm initialData={initialData} onSubmit={handleSubmit} />
    </main>
  );
}

export default function NewFilament() {
  return (
    <Suspense fallback={<p className="p-8 text-gray-500">Loading...</p>}>
      <NewFilamentContent />
    </Suspense>
  );
}

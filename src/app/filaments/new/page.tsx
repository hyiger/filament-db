"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import FilamentForm from "@/app/filaments/FilamentForm";
import { useToast } from "@/components/Toast";
import { useNfcContext } from "@/components/NfcProvider";

interface FilamentOption {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
}

function NewFilamentContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { isElectron, status: nfcStatus, tagReadResult, dismissTagRead } = useNfcContext();

  const [initialData, setInitialData] = useState<Record<string, unknown> | undefined>(undefined);
  const [formKey, setFormKey] = useState(0);
  const [title, setTitle] = useState("Add New Filament");

  // INI picker state
  const [iniFilaments, setIniFilaments] = useState<Record<string, unknown>[] | null>(null);
  const iniFileRef = useRef<HTMLInputElement>(null);

  // Clone picker state
  const [cloneSearch, setCloneSearch] = useState("");
  const [cloneOptions, setCloneOptions] = useState<FilamentOption[]>([]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneHighlight, setCloneHighlight] = useState(-1);
  const cloneRef = useRef<HTMLDivElement>(null);

  // Parent loading for ?parentId= query param
  const parentId = searchParams.get("parentId");
  const [parentLoading, setParentLoading] = useState(!!parentId);

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

  // Initialize from NFC query params
  useEffect(() => {
    if (searchParams.get("from_nfc")) {
      const nozzleMax = searchParams.get("nozzle") ? Number(searchParams.get("nozzle")) : null;
      const nozzleMin = searchParams.get("nozzleMin") ? Number(searchParams.get("nozzleMin")) : null;
      const bedMax = searchParams.get("bed") ? Number(searchParams.get("bed")) : null;
      const bedMin = searchParams.get("bedMin") ? Number(searchParams.get("bedMin")) : null;
      const weight = searchParams.get("weight") ? Number(searchParams.get("weight")) : null;

      setInitialData({
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
      });
      setTitle("New Filament from NFC Tag");
      setFormKey((k) => k + 1);
    }
  }, [searchParams]);

  // Initialize from ?parentId= query param
  useEffect(() => {
    if (parentId) {
      setParentLoading(true);
      fetch(`/api/filaments/${parentId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((parent) => {
          if (parent) {
            setInitialData({
              parentId,
              vendor: parent.vendor || "",
              type: parent.type || "",
            });
            setTitle("Add Color Variant");
            setFormKey((k) => k + 1);
          }
        })
        .catch(() => {})
        .finally(() => setParentLoading(false));
    }
  }, [parentId]);

  // Fetch clone options
  useEffect(() => {
    fetch("/api/filaments/parents")
      .then((r) => r.json())
      .then(setCloneOptions)
      .catch(() => {});
  }, []);

  // Close clone dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (cloneRef.current && !cloneRef.current.contains(e.target as Node)) {
        setCloneOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Handle NFC tag read while on this page
  useEffect(() => {
    if (!tagReadResult?.data) return;
    const data = tagReadResult.data;
    setInitialData({
      name: data.materialName || "",
      vendor: data.brandName || "",
      type: data.materialType || "PLA",
      color: data.color || "#808080",
      density: data.density ?? null,
      diameter: data.diameter ?? 1.75,
      temperatures: {
        nozzle: data.nozzleTemp ?? null,
        nozzleFirstLayer: data.nozzleTempMin ?? data.nozzleTemp ?? null,
        bed: data.bedTemp ?? null,
        bedFirstLayer: data.bedTempMin ?? data.bedTemp ?? null,
      },
      ...(data.weightGrams != null ? { netFilamentWeight: data.weightGrams } : {}),
      settings: {
        ...(data.chamberTemp != null ? { chamber_temperature: String(data.chamberTemp) } : {}),
        ...(data.countryOfOrigin ? { filament_notes: `"Origin: ${data.countryOfOrigin}"` } : {}),
      },
    });
    setTitle("New Filament from NFC Tag");
    setFormKey((k) => k + 1);
    dismissTagRead();
    toast("Form populated from NFC tag");
  }, [tagReadResult, dismissTagRead, toast]);

  // Handle INI file selection
  const handleIniFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // reset so same file can be re-selected

    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/filaments/parse-ini", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast(body?.error || "Failed to parse INI file", "error");
      return;
    }
    const { filaments } = await res.json();
    if (filaments.length === 1) {
      // Single profile — populate directly
      applyIniFilament(filaments[0]);
    } else {
      // Multiple profiles — show picker
      setIniFilaments(filaments);
    }
  };

  const applyIniFilament = useCallback((f: Record<string, unknown>) => {
    setInitialData(f);
    setTitle("New Filament from INI");
    setFormKey((k) => k + 1);
    setIniFilaments(null);
    toast("Form populated from INI profile");
  }, [toast]);

  // Handle clone selection
  const handleClone = async (id: string) => {
    setCloneOpen(false);
    setCloneSearch("");
    const res = await fetch(`/api/filaments/${id}`);
    if (!res.ok) {
      toast("Failed to load filament", "error");
      return;
    }
    const filament = await res.json();
    // Strip identity fields — keep everything else as a template
    const { _id, _variants, _inherited, parentId: _pid, createdAt, updatedAt, __v, ...rest } = filament;
    setInitialData({ ...rest, name: `${rest.name} (copy)` });
    setTitle("Clone Filament");
    setFormKey((k) => k + 1);
    toast("Form populated from clone");
  };

  const filteredClones = cloneOptions.filter(
    (f) =>
      !cloneSearch ||
      f.name.toLowerCase().includes(cloneSearch.toLowerCase()) ||
      f.vendor.toLowerCase().includes(cloneSearch.toLowerCase())
  ).slice(0, 20);

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

      {/* Populate-from toolbar */}
      {!parentId && (
        <div className="mb-6 p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-800">
          <div className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wider">Populate from</div>
          <div className="flex flex-wrap gap-2 items-start">
            {/* NFC */}
            {isElectron && (
              <div className="flex items-center gap-1.5">
                <div
                  className={`w-2 h-2 rounded-full ${
                    nfcStatus.tagPresent ? "bg-green-500" : nfcStatus.readerConnected ? "bg-yellow-500" : "bg-gray-500"
                  }`}
                />
                <span className="text-sm text-gray-400">
                  {nfcStatus.tagPresent
                    ? "Tag detected — reading..."
                    : nfcStatus.readerConnected
                      ? "Place NFC tag on reader"
                      : "No NFC reader"}
                </span>
              </div>
            )}

            {/* INI file */}
            <input
              ref={iniFileRef}
              type="file"
              accept=".ini"
              onChange={handleIniFile}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => iniFileRef.current?.click()}
              className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 inline-flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Load from INI
            </button>

            {/* Clone */}
            <div ref={cloneRef} className="relative">
              <button
                type="button"
                onClick={() => setCloneOpen((o) => !o)}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Clone Existing
              </button>
              {cloneOpen && (
                <div className="absolute z-50 mt-1 w-80 bg-gray-800 border border-gray-600 rounded-lg shadow-lg">
                  <input
                    className="w-full px-3 py-2 bg-transparent border-b border-gray-600 text-sm text-gray-100 outline-none placeholder-gray-500"
                    placeholder="Search filaments..."
                    value={cloneSearch}
                    onChange={(e) => { setCloneSearch(e.target.value); setCloneHighlight(-1); }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") { e.preventDefault(); setCloneHighlight((h) => Math.min(h + 1, filteredClones.length - 1)); }
                      else if (e.key === "ArrowUp") { e.preventDefault(); setCloneHighlight((h) => Math.max(h - 1, 0)); }
                      else if (e.key === "Enter" && cloneHighlight >= 0 && filteredClones[cloneHighlight]) {
                        e.preventDefault();
                        handleClone(filteredClones[cloneHighlight]._id);
                      } else if (e.key === "Escape") {
                        setCloneOpen(false);
                      }
                    }}
                    autoFocus
                    role="combobox"
                    aria-expanded={true}
                    aria-controls="clone-listbox"
                    aria-autocomplete="list"
                    aria-activedescendant={cloneHighlight >= 0 ? `clone-opt-${cloneHighlight}` : undefined}
                  />
                  <ul id="clone-listbox" role="listbox" className="max-h-48 overflow-y-auto">
                    {filteredClones.map((f, i) => (
                      <li
                        key={f._id}
                        id={`clone-opt-${i}`}
                        role="option"
                        aria-selected={i === cloneHighlight}
                        className={`px-3 py-2 cursor-pointer text-gray-100 hover:bg-gray-700 flex items-center gap-2 text-sm ${i === cloneHighlight ? "bg-gray-600" : ""}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleClone(f._id);
                        }}
                      >
                        <div
                          className="w-4 h-4 rounded-full border border-gray-500 flex-shrink-0"
                          style={{ backgroundColor: f.color }}
                        />
                        <span className="flex-1 truncate">{f.name}</span>
                        <span className="text-gray-400 text-xs flex-shrink-0">{f.vendor}</span>
                      </li>
                    ))}
                    {filteredClones.length === 0 && (
                      <li className="px-3 py-2 text-gray-500 text-sm">No filaments found</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* INI profile picker modal */}
      {iniFilaments && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setIniFilaments(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Select a filament profile"
              className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl max-w-lg w-full mx-4 p-6 pointer-events-auto max-h-[80vh] flex flex-col"
            >
              <h2 className="text-lg font-bold text-white mb-1">Select a Profile</h2>
              <p className="text-sm text-gray-400 mb-4">{iniFilaments.length} filament profiles found in INI file</p>
              <ul className="overflow-y-auto flex-1 space-y-1">
                {iniFilaments.map((f, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 rounded hover:bg-gray-800 flex items-center gap-2 text-sm"
                      onClick={() => applyIniFilament(f)}
                    >
                      <div
                        className="w-4 h-4 rounded-full border border-gray-500 flex-shrink-0"
                        style={{ backgroundColor: (f.color as string) || "#808080" }}
                      />
                      <span className="text-white flex-1 truncate">{f.name as string}</span>
                      <span className="text-gray-400 text-xs">{f.vendor as string} · {f.type as string}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex justify-end mt-4">
                <button
                  type="button"
                  onClick={() => setIniFilaments(null)}
                  className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <FilamentForm key={formKey} initialData={initialData} onSubmit={handleSubmit} />
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

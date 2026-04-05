"use client";

import { Suspense, useEffect, useRef, useState } from "react";
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

  // Prusament QR state
  const [prusamentInput, setPrusamentInput] = useState("");
  const [prusamentOpen, setPrusamentOpen] = useState(false);
  const [prusamentLoading, setPrusamentLoading] = useState(false);
  const prusamentRef = useRef<HTMLDivElement>(null);

  // TDS import state
  const [tdsOpen, setTdsOpen] = useState(false);
  const [tdsUrl, setTdsUrl] = useState("");
  const [tdsLoading, setTdsLoading] = useState(false);
  const tdsRef = useRef<HTMLDivElement>(null);
  const tdsFileRef = useRef<HTMLInputElement>(null);

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
        ...(searchParams.get("shoreA") ? { shoreHardnessA: Number(searchParams.get("shoreA")) } : {}),
        ...(searchParams.get("shoreD") ? { shoreHardnessD: Number(searchParams.get("shoreD")) } : {}),
        ...(searchParams.get("optTags") ? { optTags: searchParams.get("optTags")!.split(",").map(Number) } : {}),
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

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (cloneRef.current && !cloneRef.current.contains(e.target as Node)) {
        setCloneOpen(false);
      }
      if (prusamentRef.current && !prusamentRef.current.contains(e.target as Node)) {
        setPrusamentOpen(false);
      }
      if (tdsRef.current && !tdsRef.current.contains(e.target as Node)) {
        setTdsOpen(false);
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

  const applyIniFilament = (f: Record<string, unknown>) => {
    setInitialData(f);
    setTitle("New Filament from INI");
    setFormKey((k) => k + 1);
    setIniFilaments(null);
    toast("Form populated from INI profile");
  };

  // Handle Prusament QR lookup
  const handlePrusament = async () => {
    const input = prusamentInput.trim();
    if (!input) return;

    setPrusamentLoading(true);
    try {
      // Extract spoolId from URL or use as-is
      let spoolId = input;
      if (input.includes("spoolId=")) {
        try { spoolId = new URL(input).searchParams.get("spoolId") || input; } catch { /* use as-is */ }
      }

      const res = await fetch(`/api/prusament?spoolId=${encodeURIComponent(spoolId)}`);
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || "Failed to fetch Prusament data", "error");
        return;
      }

      setInitialData({
        name: data.productName || "",
        vendor: "Prusament",
        type: data.material || "PLA",
        color: data.colorHex || "#808080",
        diameter: data.diameter ?? 1.75,
        cost: data.priceUsd ?? null,
        temperatures: {
          nozzle: data.nozzleTempMax ?? null,
          nozzleFirstLayer: data.nozzleTempMin ?? data.nozzleTempMax ?? null,
          bed: data.bedTempMax ?? null,
          bedFirstLayer: data.bedTempMin ?? data.bedTempMax ?? null,
        },
        spoolWeight: data.spoolWeight ?? null,
        netFilamentWeight: data.netWeight ?? null,
        totalWeight: data.totalWeight ?? null,
      });
      setTitle("New Filament from Prusament QR");
      setFormKey((k) => k + 1);
      setPrusamentOpen(false);
      setPrusamentInput("");
      toast("Form populated from Prusament spool data");
    } catch {
      toast("Failed to fetch Prusament data", "error");
    } finally {
      setPrusamentLoading(false);
    }
  };

  // Apply extracted TDS data to the form
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyTdsResult = (result: any, sourceUrl?: string) => {
    const d = result.data;
    setInitialData({
      name: d.name || "",
      vendor: d.vendor || "",
      type: d.type || "PLA",
      density: d.density ?? null,
      diameter: d.diameter ?? 1.75,
      temperatures: {
        nozzle: d.temperatures?.nozzle ?? null,
        nozzleFirstLayer: d.temperatures?.nozzleRangeMin ?? d.temperatures?.nozzle ?? null,
        nozzleRangeMin: d.temperatures?.nozzleRangeMin ?? null,
        nozzleRangeMax: d.temperatures?.nozzleRangeMax ?? null,
        bed: d.temperatures?.bed ?? null,
        bedFirstLayer: d.temperatures?.bedRangeMin ?? d.temperatures?.bed ?? null,
      },
      dryingTemperature: d.dryingTemperature ?? null,
      dryingTime: d.dryingTime ?? null,
      glassTempTransition: d.glassTempTransition ?? null,
      heatDeflectionTemp: d.heatDeflectionTemp ?? null,
      shoreHardnessA: d.shoreHardnessA ?? null,
      shoreHardnessD: d.shoreHardnessD ?? null,
      maxVolumetricSpeed: d.maxVolumetricSpeed ?? null,
      minPrintSpeed: d.minPrintSpeed ?? null,
      maxPrintSpeed: d.maxPrintSpeed ?? null,
      netFilamentWeight: d.netFilamentWeight ?? null,
      spoolWeight: d.spoolWeight ?? null,
      ...(sourceUrl ? { tdsUrl: sourceUrl } : {}),
    });
    setTitle("New Filament from TDS");
    setFormKey((k) => k + 1);
    setTdsOpen(false);
    setTdsUrl("");
    toast(`Extracted ${result.fieldsExtracted} fields from TDS`);
  };

  // Get AI config from Electron store (if available)
  const getAiConfig = async () => {
    const api = window.electronAPI;
    if (api?.getConfig) {
      const cfg = await api.getConfig();
      return {
        apiKey: cfg.aiApiKey || cfg.geminiApiKey || undefined,
        provider: cfg.aiProvider || undefined,
      };
    }
    return { apiKey: undefined, provider: undefined };
  };

  // Handle TDS extraction from URL
  const handleTds = async () => {
    const url = tdsUrl.trim();
    if (!url) return;

    setTdsLoading(true);
    try {
      const { apiKey, provider } = await getAiConfig();

      const res = await fetch("/api/tds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, apiKey, provider }),
      });
      const result = await res.json();

      if (!res.ok) {
        toast(result.error || "Failed to extract TDS data", "error");
        return;
      }

      applyTdsResult(result, url);
    } catch {
      toast("Failed to extract TDS data", "error");
    } finally {
      setTdsLoading(false);
    }
  };

  // Handle TDS extraction from uploaded file
  const handleTdsFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // reset so same file can be re-selected

    setTdsLoading(true);
    try {
      const { apiKey, provider } = await getAiConfig();

      const formData = new FormData();
      formData.append("file", file);
      if (apiKey) formData.append("apiKey", apiKey);
      if (provider) formData.append("provider", provider);

      const res = await fetch("/api/tds", {
        method: "POST",
        body: formData,
      });
      const result = await res.json();

      if (!res.ok) {
        toast(result.error || "Failed to extract TDS data", "error");
        return;
      }

      applyTdsResult(result);
    } catch {
      toast("Failed to extract TDS data", "error");
    } finally {
      setTdsLoading(false);
    }
  };

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

            {/* Prusament QR */}
            <div ref={prusamentRef} className="relative">
              <button
                type="button"
                onClick={() => setPrusamentOpen((o) => !o)}
                className="px-3 py-1.5 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 inline-flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.5 14.625v2.625m3.375-2.625v2.625M16.875 20.25h-3.375v-3.375" />
                </svg>
                Prusament QR
              </button>
              {prusamentOpen && (
                <div className="absolute z-50 mt-1 w-80 bg-gray-800 border border-gray-600 rounded-lg shadow-lg p-3">
                  <label className="text-xs text-gray-400 block mb-1.5">Spool ID or URL from QR code</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={prusamentInput}
                      onChange={(e) => setPrusamentInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handlePrusament(); } }}
                      placeholder="e.g. 4a7b3c... or full URL"
                      className="flex-1 px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-gray-100 outline-none placeholder-gray-500"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={handlePrusament}
                      disabled={prusamentLoading || !prusamentInput.trim()}
                      className="px-3 py-1.5 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
                    >
                      {prusamentLoading ? "..." : "Fetch"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* TDS Import */}
            <div ref={tdsRef} className="relative">
              <button
                type="button"
                onClick={() => setTdsOpen((o) => !o)}
                className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 inline-flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                </svg>
                Import from TDS
              </button>
              {tdsOpen && (
                <div className="absolute z-50 mt-1 w-96 bg-gray-800 border border-gray-600 rounded-lg shadow-lg p-3">
                  <label className="text-xs text-gray-400 block mb-1.5">Technical Data Sheet URL (PDF or web page)</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={tdsUrl}
                      onChange={(e) => setTdsUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleTds(); } }}
                      placeholder="https://example.com/filament-tds.pdf"
                      className="flex-1 px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-gray-100 outline-none placeholder-gray-500"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={handleTds}
                      disabled={tdsLoading || !tdsUrl.trim()}
                      className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50 whitespace-nowrap"
                    >
                      {tdsLoading ? "Extracting..." : "Extract"}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <div className="flex-1 border-t border-gray-700" />
                    <span className="text-xs text-gray-600">or</span>
                    <div className="flex-1 border-t border-gray-700" />
                  </div>
                  <input
                    ref={tdsFileRef}
                    type="file"
                    accept=".pdf,.html,.htm,.txt"
                    onChange={handleTdsFile}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => tdsFileRef.current?.click()}
                    disabled={tdsLoading}
                    className="mt-2 w-full px-3 py-1.5 text-sm bg-gray-700 text-gray-300 rounded hover:bg-gray-600 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                    </svg>
                    {tdsLoading ? "Extracting..." : "Upload local file"}
                  </button>
                  <p className="text-xs text-gray-500 mt-2">
                    Uses AI to extract filament properties.
                    {" "}
                    <Link href="/settings" className="text-blue-400 hover:text-blue-300 underline">
                      Configure API key
                    </Link>
                  </p>
                </div>
              )}
            </div>

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

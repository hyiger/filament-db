"use client";

import { useRouter } from "next/navigation";
import { useNfcContext, type NfcTagReadResult } from "./NfcProvider";

export default function NfcReadDialog() {
  const router = useRouter();
  const { tagReadResult, dismissTagRead } = useNfcContext();

  if (!tagReadResult) return null;

  const { data, error, match, candidates } = tagReadResult;

  const handleGoToFilament = (id: string) => {
    dismissTagRead();
    router.push(`/filaments/${id}`);
  };

  const handleCreateNew = () => {
    if (!data) return;
    const params = new URLSearchParams();
    params.set("from_nfc", "1");
    if (data.materialName) params.set("name", data.materialName);
    if (data.brandName) params.set("vendor", data.brandName);
    if (data.materialType) params.set("type", data.materialType);
    if (data.color) params.set("color", data.color);
    if (data.density != null) params.set("density", String(data.density));
    if (data.diameter != null) params.set("diameter", String(data.diameter));
    if (data.nozzleTemp != null) params.set("nozzle", String(data.nozzleTemp));
    if (data.nozzleTempMin != null) params.set("nozzleMin", String(data.nozzleTempMin));
    if (data.bedTemp != null) params.set("bed", String(data.bedTemp));
    if (data.bedTempMin != null) params.set("bedMin", String(data.bedTempMin));
    if (data.chamberTemp != null) params.set("chamber", String(data.chamberTemp));
    if (data.weightGrams != null) params.set("weight", String(data.weightGrams));
    if (data.countryOfOrigin) params.set("country", data.countryOfOrigin);
    dismissTagRead();
    router.push(`/filaments/new?${params}`);
  };

  const handleCreateAsVariant = (parentId: string) => {
    if (!data) return;
    const params = new URLSearchParams();
    params.set("from_nfc", "1");
    params.set("parentId", parentId);
    if (data.materialName) params.set("name", data.materialName);
    if (data.color) params.set("color", data.color);
    dismissTagRead();
    router.push(`/filaments/new?${params}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl max-w-md w-full mx-4 p-6">
        {/* Error state */}
        {error ? (
          <>
            <h2 className="text-xl font-bold text-white mb-4">NFC Read Error</h2>
            <div className="text-red-400 mb-6">{error}</div>
            <div className="flex justify-end">
              <button
                onClick={dismissTagRead}
                className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
              >
                Dismiss
              </button>
            </div>
          </>
        ) : match ? (
          /* Match found */
          <>
            <div className="flex items-center gap-2 mb-4">
              <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h2 className="text-xl font-bold text-white">Found in Database</h2>
            </div>

            <div className="flex items-center gap-3 bg-gray-800 rounded-lg p-4 mb-4">
              <div
                className="w-10 h-10 rounded-full border border-gray-600 flex-shrink-0"
                style={{ backgroundColor: match.color || "#808080" }}
              />
              <div className="min-w-0">
                <div className="text-white font-semibold truncate">{match.name}</div>
                <div className="text-gray-400 text-sm">
                  {match.vendor} &middot; {match.type}
                </div>
              </div>
            </div>

            {data && <TagDataGrid data={data} />}

            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={dismissTagRead}
                className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
              >
                Dismiss
              </button>
              <button
                onClick={handleCreateNew}
                className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
              >
                Create New
              </button>
              <button
                onClick={() => handleGoToFilament(match._id)}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500"
              >
                View Filament
              </button>
            </div>
          </>
        ) : data ? (
          /* No match — show tag data with create option */
          <>
            <div className="flex items-center gap-2 mb-4">
              <svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
              </svg>
              <h2 className="text-xl font-bold text-white">Unknown Filament</h2>
            </div>

            <div className="flex items-center gap-3 mb-4">
              {data.color && (
                <div
                  className="w-8 h-8 rounded-full border border-gray-600 flex-shrink-0"
                  style={{ backgroundColor: data.color }}
                />
              )}
              <div>
                <div className="text-white font-semibold">
                  {data.materialName || "Unknown"}
                </div>
                <div className="text-gray-400 text-sm">
                  {data.brandName}{data.materialType ? ` · ${data.materialType}` : ""}
                </div>
              </div>
            </div>

            <TagDataGrid data={data} />

            {/* Similar filaments — offer to create as variant */}
            {candidates && candidates.length > 0 && (
              <div className="mt-4">
                <div className="text-xs text-gray-400 mb-2">Similar filaments — add as color variant?</div>
                <div className="space-y-1">
                  {candidates.map((c) => (
                    <div
                      key={c._id}
                      className="flex items-center gap-2 px-3 py-2 bg-gray-800 rounded text-sm"
                    >
                      <div
                        className="w-4 h-4 rounded-full border border-gray-600 flex-shrink-0"
                        style={{ backgroundColor: c.color || "#808080" }}
                      />
                      <span className="text-white truncate flex-1">{c.name}</span>
                      <button
                        onClick={() => handleGoToFilament(c._id)}
                        className="text-blue-400 hover:text-blue-300 text-xs flex-shrink-0"
                      >
                        View
                      </button>
                      <button
                        onClick={() => handleCreateAsVariant(c._id)}
                        className="text-amber-400 hover:text-amber-300 text-xs flex-shrink-0"
                      >
                        + Variant
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={dismissTagRead}
                className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
              >
                Dismiss
              </button>
              <button
                onClick={handleCreateNew}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500"
              >
                Create New Filament
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function TagDataGrid({ data }: { data: NonNullable<NfcTagReadResult["data"]> }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-sm">
      {data.nozzleTemp != null && (
        <Stat label="Nozzle Temp" value={`${data.nozzleTempMin ?? "?"}–${data.nozzleTemp}°C`} />
      )}
      {data.bedTemp != null && (
        <Stat label="Bed Temp" value={`${data.bedTempMin ?? "?"}–${data.bedTemp}°C`} />
      )}
      {data.density != null && (
        <Stat label="Density" value={`${data.density.toFixed(2)} g/cm³`} />
      )}
      {data.diameter != null && (
        <Stat label="Diameter" value={`${data.diameter.toFixed(2)} mm`} />
      )}
      {data.weightGrams != null && (
        <Stat label="Weight" value={`${data.weightGrams}g`} />
      )}
      {data.countryOfOrigin && (
        <Stat label="Origin" value={data.countryOfOrigin} />
      )}
      {data.chamberTemp != null && (
        <Stat label="Chamber Temp" value={`${data.chamberTemp}°C`} />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800 px-3 py-2 rounded">
      <div className="text-gray-400 text-xs">{label}</div>
      <div className="text-white">{value}</div>
    </div>
  );
}

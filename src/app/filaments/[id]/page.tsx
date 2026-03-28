"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import NfcStatus from "@/components/NfcStatus";
import { useNfcContext } from "@/components/NfcProvider";
import { generateOpenPrintTagBinary } from "@/lib/openprinttag";

interface Variant {
  _id: string;
  name: string;
  color: string;
  cost: number | null;
}

interface Filament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
  cost: number | null;
  density: number | null;
  diameter: number;
  temperatures: {
    nozzle: number | null;
    nozzleFirstLayer: number | null;
    bed: number | null;
    bedFirstLayer: number | null;
  };
  maxVolumetricSpeed: number | null;
  compatibleNozzles: {
    _id: string;
    name: string;
    diameter: number;
    type: string;
    highFlow: boolean;
  }[];
  calibrations: {
    nozzle: {
      _id: string;
      name: string;
      highFlow: boolean;
    };
    extrusionMultiplier: number | null;
    maxVolumetricSpeed: number | null;
    pressureAdvance: number | null;
    retractLength: number | null;
    retractSpeed: number | null;
    retractLift: number | null;
  }[];
  tdsUrl: string | null;
  inherits: string | null;
  parentId: string | null;
  settings: Record<string, string | null>;
  _inherited?: string[];
  _variants?: Variant[];
}

export default function FilamentDetail() {
  const params = useParams();
  const [filament, setFilament] = useState<Filament | null>(null);
  const [showAllSettings, setShowAllSettings] = useState(false);
  const [showTdsPreview, setShowTdsPreview] = useState(false);
  const { isElectron, status: nfcStatus, writing: nfcWriting, writeTag } = useNfcContext();
  const [nfcWriteSuccess, setNfcWriteSuccess] = useState<boolean | null>(null);

  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/filaments/${params.id}`)
      .then((r) => {
        if (!r.ok) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data) => { if (data) setFilament(data); });
  }, [params.id]);

  const handleNfcWrite = async () => {
    if (!filament) return;
    setNfcWriteSuccess(null);
    try {
      const payload = generateOpenPrintTagBinary({
        materialName: filament.name,
        brandName: filament.vendor,
        materialType: filament.type,
        color: filament.color,
        density: filament.density,
        diameter: filament.diameter,
        nozzleTemp: filament.temperatures?.nozzle,
        nozzleTempFirstLayer: filament.temperatures?.nozzleFirstLayer,
        bedTemp: filament.temperatures?.bed,
        bedTempFirstLayer: filament.temperatures?.bedFirstLayer,
        chamberTemp: filament.settings?.chamber_temperature
          ? Number(filament.settings.chamber_temperature)
          : null,
      });
      await writeTag(payload);
      setNfcWriteSuccess(true);
      setTimeout(() => setNfcWriteSuccess(null), 3000);
    } catch {
      setNfcWriteSuccess(false);
      setTimeout(() => setNfcWriteSuccess(null), 5000);
    }
  };

  if (notFound) return <p className="p-8 text-red-500">Filament not found. It may have been deleted.</p>;
  if (!filament) return <p className="p-8 text-gray-500">Loading...</p>;

  const inherited = new Set(filament._inherited || []);
  const isVariant = !!filament.parentId;
  const isParent = (filament._variants?.length ?? 0) > 0;

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; Back to list
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div
          className="w-10 h-10 rounded-full border-2 border-gray-300 flex-shrink-0"
          style={{ backgroundColor: filament.color }}
        />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{filament.name}</h1>
          <p className="text-gray-500">
            {filament.vendor} &middot; {filament.type}
            {isVariant && (
              <span className="ml-2 text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
                variant
              </span>
            )}
            {isParent && (
              <span className="ml-2 text-xs bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 rounded">
                {filament._variants!.length} color{filament._variants!.length !== 1 ? "s" : ""}
              </span>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {isElectron && <NfcStatus />}
          {isElectron && nfcStatus.tagPresent && (
            <button
              onClick={handleNfcWrite}
              disabled={nfcWriting}
              className={`px-4 py-2 text-sm text-white rounded inline-flex items-center gap-1.5 ${
                nfcWriteSuccess === true
                  ? "bg-green-600"
                  : nfcWriteSuccess === false
                    ? "bg-red-600"
                    : "bg-purple-600 hover:bg-purple-700"
              } disabled:opacity-50`}
              title="Write OpenPrintTag data to NFC tag"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
              </svg>
              {nfcWriting
                ? "Writing..."
                : nfcWriteSuccess === true
                  ? "Written!"
                  : nfcWriteSuccess === false
                    ? "Write Failed"
                    : "Write NFC"}
            </button>
          )}
          <button
            onClick={() => {
              const a = document.createElement("a");
              a.href = `/api/filaments/${filament._id}/openprinttag`;
              a.download = "";
              a.click();
            }}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm inline-flex items-center gap-1.5"
            title="Download OpenPrintTag NFC binary (.bin)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export OPT
          </button>
          {isParent && (
            <Link
              href={`/filaments/new?parentId=${filament._id}`}
              className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 text-sm inline-flex items-center gap-1.5"
              title="Add a new color variant of this filament"
            >
              + Add Color
            </Link>
          )}
          <Link
            href={`/filaments/${filament._id}/edit`}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            Edit
          </Link>
        </div>
      </div>

      {/* Variant parent link */}
      {isVariant && (
        <div className="mb-4 px-3 py-2 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded text-sm">
          Inherits settings from parent filament.
          {inherited.size > 0 && (
            <span className="text-gray-500 ml-1">
              ({inherited.size} inherited field{inherited.size !== 1 ? "s" : ""})
            </span>
          )}
        </div>
      )}

      {/* Color variants */}
      {isParent && filament._variants && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">Color Variants</h2>
          <div className="flex flex-wrap gap-2">
            {filament._variants.map((v) => (
              <Link
                key={v._id}
                href={`/filaments/${v._id}`}
                className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                <div
                  className="w-5 h-5 rounded-full border border-gray-300"
                  style={{ backgroundColor: v.color }}
                />
                <span className="text-sm">{v.name}</span>
                {v.cost != null && (
                  <span className="text-xs text-gray-500">${v.cost.toFixed(2)}</span>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <InfoCard label="Nozzle Temp" value={filament.temperatures.nozzle ? `${filament.temperatures.nozzle}°C` : "—"} inherited={inherited.has("temperatures.nozzle")} />
        <InfoCard label="Nozzle (1st Layer)" value={filament.temperatures.nozzleFirstLayer ? `${filament.temperatures.nozzleFirstLayer}°C` : "—"} inherited={inherited.has("temperatures.nozzleFirstLayer")} />
        <InfoCard label="Bed Temp" value={filament.temperatures.bed ? `${filament.temperatures.bed}°C` : "—"} inherited={inherited.has("temperatures.bed")} />
        <InfoCard label="Bed (1st Layer)" value={filament.temperatures.bedFirstLayer ? `${filament.temperatures.bedFirstLayer}°C` : "—"} inherited={inherited.has("temperatures.bedFirstLayer")} />
        <InfoCard label="Cost" value={filament.cost != null ? `$${filament.cost.toFixed(2)}/kg` : "—"} inherited={inherited.has("cost")} />
        <InfoCard label="Density" value={filament.density ? `${filament.density} g/cm³` : "—"} inherited={inherited.has("density")} />
        <InfoCard label="Diameter" value={`${filament.diameter} mm`} inherited={inherited.has("diameter")} />
        <InfoCard label="Max Vol. Speed" value={filament.maxVolumetricSpeed ? `${filament.maxVolumetricSpeed} mm³/s` : "—"} inherited={inherited.has("maxVolumetricSpeed")} />
      </div>

      {filament.compatibleNozzles && filament.compatibleNozzles.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">
            {filament.calibrations?.length > 0
              ? "Nozzle Calibrations"
              : "Compatible Nozzles"}
            {inherited.has("compatibleNozzles") && (
              <span className="ml-1 text-xs text-blue-500">(inherited)</span>
            )}
          </h2>
          {filament.calibrations?.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-gray-300">
                    <th className="text-left py-2 px-2">Nozzle</th>
                    <th className="text-right py-2 px-2">EM</th>
                    <th className="text-right py-2 px-2">Max Vol</th>
                    <th className="text-right py-2 px-2">PA</th>
                    <th className="text-right py-2 px-2">Retract</th>
                    <th className="text-right py-2 px-2">Speed</th>
                    <th className="text-right py-2 px-2">Z Lift</th>
                  </tr>
                </thead>
                <tbody>
                  {filament.calibrations.map((cal, i) => (
                    <tr
                      key={i}
                      className="border-b border-gray-200 dark:border-gray-800"
                    >
                      <td className="py-2 px-2">
                        {cal.nozzle?.name || "—"}
                        {cal.nozzle?.highFlow && (
                          <span className="ml-1.5 px-1.5 py-0.5 bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 rounded text-xs">
                            HF
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {cal.extrusionMultiplier ?? "—"}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {cal.maxVolumetricSpeed ? `${cal.maxVolumetricSpeed}` : "—"}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {cal.pressureAdvance ?? "—"}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {cal.retractLength ? `${cal.retractLength}mm` : "—"}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {cal.retractSpeed ? `${cal.retractSpeed}` : "—"}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {cal.retractLift ? `${cal.retractLift}mm` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {filament.compatibleNozzles.map((n) => (
                <span
                  key={n._id}
                  className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm"
                >
                  {n.name}
                  {n.highFlow && (
                    <span className="ml-1.5 px-1.5 py-0.5 bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 rounded text-xs">
                      HF
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {filament.tdsUrl && (
        <div className="mb-6">
          <button
            onClick={() => setShowTdsPreview(!showTdsPreview)}
            className="inline-flex items-center gap-2 text-sm text-blue-600 hover:underline"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {showTdsPreview ? "Hide" : "View"} Technical Data Sheet
          </button>
          <a
            href={filament.tdsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-3 text-xs text-gray-500 hover:underline"
          >
            Open in new tab
          </a>
          {showTdsPreview && (
            <div className="mt-3 border border-gray-300 dark:border-gray-700 rounded overflow-hidden">
              <iframe
                src={filament.tdsUrl}
                className="w-full bg-white"
                style={{ height: "80vh" }}
                title="Technical Data Sheet"
              />
            </div>
          )}
        </div>
      )}

      {filament.inherits && (
        <p className="text-sm text-gray-500 mb-4">
          Inherits from: <span className="font-mono">{filament.inherits}</span>
        </p>
      )}

      <div>
        <button
          onClick={() => setShowAllSettings(!showAllSettings)}
          className="text-sm text-blue-600 hover:underline mb-3"
        >
          {showAllSettings ? "Hide" : "Show"} all PrusaSlicer settings ({Object.keys(filament.settings).length} keys)
        </button>

        {showAllSettings && (
          <div className="bg-gray-50 dark:bg-gray-900 rounded p-4 overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <tbody>
                {Object.entries(filament.settings)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, value]) => (
                    <tr key={key} className="border-b border-gray-200 dark:border-gray-800">
                      <td className="py-1 pr-4 text-gray-500 whitespace-nowrap">{key}</td>
                      <td className="py-1 break-all">{value ?? <span className="text-gray-400">nil</span>}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function InfoCard({ label, value, inherited = false }: { label: string; value: string; inherited?: boolean }) {
  return (
    <div className={`rounded p-3 ${inherited ? "bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800" : "bg-gray-50 dark:bg-gray-900"}`}>
      <p className="text-xs text-gray-500 mb-1">
        {label}
        {inherited && <span className="ml-1 text-blue-500">(inherited)</span>}
      </p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

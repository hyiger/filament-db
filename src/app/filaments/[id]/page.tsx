"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

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
  settings: Record<string, string | null>;
}

export default function FilamentDetail() {
  const params = useParams();
  const [filament, setFilament] = useState<Filament | null>(null);
  const [showAllSettings, setShowAllSettings] = useState(false);
  const [showTdsPreview, setShowTdsPreview] = useState(false);

  useEffect(() => {
    fetch(`/api/filaments/${params.id}`)
      .then((r) => r.json())
      .then(setFilament);
  }, [params.id]);

  if (!filament) return <p className="p-8 text-gray-500">Loading...</p>;

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; Back to list
        </Link>
      </div>

      <div className="flex items-center gap-4 mb-6">
        <div
          className="w-10 h-10 rounded-full border-2 border-gray-300"
          style={{ backgroundColor: filament.color }}
        />
        <div>
          <h1 className="text-2xl font-bold">{filament.name}</h1>
          <p className="text-gray-500">
            {filament.vendor} &middot; {filament.type}
          </p>
        </div>
        <Link
          href={`/filaments/${filament._id}/edit`}
          className="ml-auto px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          Edit
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <InfoCard label="Nozzle Temp" value={filament.temperatures.nozzle ? `${filament.temperatures.nozzle}°C` : "—"} />
        <InfoCard label="Nozzle (1st Layer)" value={filament.temperatures.nozzleFirstLayer ? `${filament.temperatures.nozzleFirstLayer}°C` : "—"} />
        <InfoCard label="Bed Temp" value={filament.temperatures.bed ? `${filament.temperatures.bed}°C` : "—"} />
        <InfoCard label="Bed (1st Layer)" value={filament.temperatures.bedFirstLayer ? `${filament.temperatures.bedFirstLayer}°C` : "—"} />
        <InfoCard label="Cost" value={filament.cost != null ? `$${filament.cost.toFixed(2)}/kg` : "—"} />
        <InfoCard label="Density" value={filament.density ? `${filament.density} g/cm³` : "—"} />
        <InfoCard label="Diameter" value={`${filament.diameter} mm`} />
        <InfoCard label="Max Vol. Speed" value={filament.maxVolumetricSpeed ? `${filament.maxVolumetricSpeed} mm³/s` : "—"} />
      </div>

      {filament.compatibleNozzles && filament.compatibleNozzles.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">
            {filament.calibrations?.length > 0
              ? "Nozzle Calibrations"
              : "Compatible Nozzles"}
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

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-900 rounded p-3">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

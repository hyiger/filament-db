"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import NfcStatus from "@/components/NfcStatus";
import { useNfcContext } from "@/components/NfcProvider";
import { generateOpenPrintTagBinary } from "@/lib/openprinttag";
import { useToast } from "@/components/Toast";
import { useCurrency } from "@/hooks/useCurrency";
import PrusamentImportDialog from "@/components/PrusamentImportDialog";
import type { FilamentDetail } from "@/types/filament";
import { useTranslation } from "@/i18n/TranslationProvider";

type Filament = FilamentDetail;

function computeRemaining(filament: Filament, overrideTotalWeight?: number | null) {
  const { spoolWeight, netFilamentWeight, density, diameter } = filament;
  const totalWeight = overrideTotalWeight !== undefined ? overrideTotalWeight : filament.totalWeight;
  if (totalWeight == null || spoolWeight == null) return null;

  const remainingWeight = Math.max(0, totalWeight - spoolWeight);
  const pct = netFilamentWeight && netFilamentWeight > 0
    ? Math.min(100, Math.round((remainingWeight / netFilamentWeight) * 100))
    : null;

  let lengthMeters: number | null = null;
  if (density && density > 0 && diameter && diameter > 0) {
    // Volume in cm³ = weight(g) / density(g/cm³)
    const volumeCm3 = remainingWeight / density;
    // Cross-section area in cm² = π * (diameter_mm / 20)²
    const radiusCm = diameter / 20;
    const areaCm2 = Math.PI * radiusCm * radiusCm;
    // Length in cm, convert to meters
    lengthMeters = volumeCm3 / areaCm2 / 100;
  }

  return { remainingWeight, pct, lengthMeters };
}

export default function FilamentDetail() {
  const { t } = useTranslation();
  const { symbol: currencySymbol } = useCurrency();
  const params = useParams();
  const [filament, setFilament] = useState<Filament | null>(null);
  const [showAllSettings, setShowAllSettings] = useState(false);
  const [showTdsPreview, setShowTdsPreview] = useState(false);
  const { isElectron, status: nfcStatus, writing: nfcWriting, writeTag } = useNfcContext();
  const [nfcWriteSuccess, setNfcWriteSuccess] = useState<boolean | null>(null);
  const nfcWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();

  const [notFound, setNotFound] = useState(false);

  // Legacy single-spool inline weight update
  const [weightInput, setWeightInput] = useState("");
  const [weightSaving, setWeightSaving] = useState(false);
  const weightRef = useRef<HTMLInputElement>(null);

  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showPrusamentImport, setShowPrusamentImport] = useState(false);

  // Clear NFC write timeout on unmount
  useEffect(() => {
    return () => { if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/filaments/${params.id}`, { signal: controller.signal })
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        if (!r.ok) { setFetchError(t("detail.error.loadFailed")); return null; }
        return r.json();
      })
      .then((data) => { if (data) setFilament(data); })
      .catch((err) => { if (err.name !== "AbortError") setFetchError(t("detail.error.connectionFailed")); });
    return () => controller.abort();
  }, [params.id, t]);

  const handleNfcWrite = async () => {
    if (!filament) return;
    setNfcWriteSuccess(null);
    try {
      // Compute actual remaining weight from the most recent scale reading
      let actualWeightGrams: number | null = null;
      if (filament.totalWeight != null && filament.spoolWeight != null) {
        actualWeightGrams = Math.max(0, filament.totalWeight - filament.spoolWeight);
      }
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
        weightGrams: filament.netFilamentWeight ?? null,
        actualWeightGrams,
        emptySpoolWeight: filament.spoolWeight ?? null,
        spoolUid: filament.instanceId ?? null,
        dryingTemperature: filament.dryingTemperature,
        dryingTime: filament.dryingTime,
        transmissionDistance: filament.transmissionDistance,
        abrasive: filament.settings?.filament_abrasive === "1",
        soluble: filament.settings?.filament_soluble === "1",
        shoreHardnessA: filament.shoreHardnessA,
        shoreHardnessD: filament.shoreHardnessD,
        optTags: filament.optTags,
      });
      // Include a URI record for Prusa app compatibility
      const productUrl = filament.tdsUrl
        || `https://filamentdb.app/filament/${encodeURIComponent(filament.vendor)}/${encodeURIComponent(filament.name)}`;
      await writeTag(payload, productUrl);
      setNfcWriteSuccess(true);
      if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current);
      nfcWriteTimerRef.current = setTimeout(() => setNfcWriteSuccess(null), 3000);
    } catch {
      setNfcWriteSuccess(false);
      if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current);
      nfcWriteTimerRef.current = setTimeout(() => setNfcWriteSuccess(null), 5000);
    }
  };

  const handleNfcWeightUpdate = async (scaleWeight: number) => {
    if (!filament || filament.spoolWeight == null) return;
    const actualRemaining = Math.max(0, scaleWeight - filament.spoolWeight);
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
        weightGrams: filament.netFilamentWeight ?? null,
        actualWeightGrams: actualRemaining,
        emptySpoolWeight: filament.spoolWeight ?? null,
        spoolUid: filament.instanceId ?? null,
        dryingTemperature: filament.dryingTemperature,
        dryingTime: filament.dryingTime,
        transmissionDistance: filament.transmissionDistance,
        abrasive: filament.settings?.filament_abrasive === "1",
        soluble: filament.settings?.filament_soluble === "1",
        shoreHardnessA: filament.shoreHardnessA,
        shoreHardnessD: filament.shoreHardnessD,
        optTags: filament.optTags,
      });
      const productUrl = filament.tdsUrl
        || `https://filamentdb.app/filament/${encodeURIComponent(filament.vendor)}/${encodeURIComponent(filament.name)}`;
      await writeTag(payload, productUrl);
      setNfcWriteSuccess(true);
      toast(t("detail.nfc.updated", { weight: String(Math.round(actualRemaining)) }));
      if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current);
      nfcWriteTimerRef.current = setTimeout(() => setNfcWriteSuccess(null), 3000);
    } catch {
      setNfcWriteSuccess(false);
      toast(t("detail.nfc.writeFailed"), "error");
      if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current);
      nfcWriteTimerRef.current = setTimeout(() => setNfcWriteSuccess(null), 5000);
    }
  };

  const handleWeightUpdate = async () => {
    if (!filament) return;
    const val = parseFloat(weightInput);
    if (isNaN(val) || val < 0) {
      toast(t("detail.weight.invalidInput"), "error");
      return;
    }
    setWeightSaving(true);
    try {
      const res = await fetch(`/api/filaments/${filament._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalWeight: val }),
      });
      if (res.ok) {
        setFilament(prev => prev ? { ...prev, totalWeight: val } : prev);
        toast(t("detail.weight.updated"));
        setWeightInput("");
      } else {
        toast(t("detail.weight.updateFailed"), "error");
      }
    } catch {
      toast(t("detail.weight.updateFailed"), "error");
    } finally {
      setWeightSaving(false);
    }
  };

  const handleAddSpool = async (label = "", totalWeight: number | null = null) => {
    if (!filament) return;
    try {
      const res = await fetch(`/api/filaments/${filament._id}/spools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, totalWeight }),
      });
      if (res.ok) {
        const updated = await res.json();
        setFilament(prev => prev ? { ...prev, spools: updated.spools } : prev);
        toast(t("detail.spool.added"));
      } else {
        toast(t("detail.spool.addFailed"), "error");
      }
    } catch {
      toast(t("detail.spool.addFailed"), "error");
    }
  };

  const handleUpdateSpool = async (spoolId: string, data: { totalWeight?: number; label?: string }) => {
    if (!filament) return;
    try {
      const res = await fetch(`/api/filaments/${filament._id}/spools/${spoolId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const updated = await res.json();
        setFilament(prev => prev ? { ...prev, spools: updated.spools } : prev);
        toast(t("detail.spool.updated"));
      } else {
        toast(t("detail.spool.updateFailed"), "error");
      }
    } catch {
      toast(t("detail.spool.updateFailed"), "error");
    }
  };

  const handleRemoveSpool = async (spoolId: string) => {
    if (!filament) return;
    if (!confirm(t("detail.spool.confirmRemove"))) return;
    try {
      const res = await fetch(`/api/filaments/${filament._id}/spools/${spoolId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const updated = await res.json();
        setFilament(prev => prev ? { ...prev, spools: updated.spools } : prev);
        toast(t("detail.spool.removed"));
        // Re-focus the document body after confirm() dialog steals focus,
        // so subsequent input fields remain clickable/typeable (#97)
        requestAnimationFrame(() => {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        });
      } else {
        toast(t("detail.spool.removeFailed"), "error");
      }
    } catch {
      toast(t("detail.spool.removeFailed"), "error");
    }
  };

  const handleMigrateToSpools = async () => {
    if (!filament || filament.totalWeight == null) return;
    try {
      // Create a spool from the legacy totalWeight
      const addRes = await fetch(`/api/filaments/${filament._id}/spools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "", totalWeight: filament.totalWeight }),
      });
      if (!addRes.ok) { toast(t("detail.spool.migrateFailed"), "error"); return; }
      // Clear the legacy totalWeight
      const clearRes = await fetch(`/api/filaments/${filament._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalWeight: null }),
      });
      if (clearRes.ok) {
        const added = await addRes.json();
        setFilament(prev => prev ? { ...prev, spools: added.spools, totalWeight: null } : prev);
        toast(t("detail.spool.migrated"));
      }
    } catch {
      toast(t("detail.spool.migrateFailed"), "error");
    }
  };

  if (notFound) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">{t("detail.error.notFound")}</p>
      <Link href="/" className="text-blue-600 hover:underline text-sm">&larr; {t("detail.backToFilaments")}</Link>
    </div>
  );
  if (fetchError) return <p className="p-8 text-red-500">{fetchError}</p>;
  if (!filament) return <p className="p-8 text-gray-500">{t("common.loading")}</p>;

  const inherited = new Set(filament._inherited || []);
  const isVariant = !!filament.parentId;
  const isParent = (filament._variants?.length ?? 0) > 0;

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; {t("detail.back")}
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div
          className="w-10 h-10 rounded-full border-2 border-gray-300 flex-shrink-0"
          style={{ backgroundColor: filament.color }}
          aria-label={`Color swatch: ${filament.color}`}
        />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{filament.name}</h1>
          <p className="text-gray-500">
            {filament.vendor} &middot; {filament.type}
            {filament.instanceId && (
              <span className="ml-2 text-xs font-mono text-gray-400">{filament.instanceId}</span>
            )}
            {isVariant && (
              <span className="ml-2 text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
                {t("detail.variant")}
              </span>
            )}
            {isParent && (
              <span className="ml-2 text-xs bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 rounded">
                {t("detail.colorCount", { count: filament._variants!.length })}
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
              title={t("detail.nfc.writeTitle")}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
              </svg>
              {nfcWriting
                ? t("detail.nfc.writing")
                : nfcWriteSuccess === true
                  ? t("detail.nfc.success")
                  : nfcWriteSuccess === false
                    ? t("detail.nfc.failed")
                    : t("detail.nfc.write")}
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
            title={t("detail.exportOpt.title")}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {t("detail.exportOpt")}
          </button>
          {!isVariant && (
            <Link
              href={`/filaments/new?cloneId=${filament._id}`}
              className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 text-sm inline-flex items-center gap-1.5"
              title={t("detail.clone.title")}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {t("detail.clone")}
            </Link>
          )}
          <Link
            href={`/filaments/${filament._id}/edit`}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            {t("detail.edit")}
          </Link>
        </div>
      </div>

      {/* Variant parent link */}
      {isVariant && (
        <div className="mb-4 px-3 py-2 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded text-sm">
          {t("detail.inheritsFromParent")}
          {inherited.size > 0 && (
            <span className="text-gray-500 ml-1">
              ({t("detail.inheritedFieldCount", { count: inherited.size })})
            </span>
          )}
        </div>
      )}

      {/* Color variants */}
      {isParent && filament._variants && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">{t("detail.section.colorVariants")}</h2>
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
                  aria-label={`Color swatch: ${v.color}`}
                />
                <span className="text-sm">{v.name}</span>
                {v.cost != null && (
                  <span className="text-xs text-gray-500">{currencySymbol}{v.cost.toFixed(2)}</span>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <InfoCard label={t("detail.field.nozzleTemp")} value={filament.temperatures.nozzle ? `${filament.temperatures.nozzle}°C` : "—"} inherited={inherited.has("temperatures.nozzle")} />
        <InfoCard label={t("detail.field.nozzleFirstLayer")} value={filament.temperatures.nozzleFirstLayer ? `${filament.temperatures.nozzleFirstLayer}°C` : "—"} inherited={inherited.has("temperatures.nozzleFirstLayer")} />
        <InfoCard label={t("detail.field.bedTemp")} value={filament.temperatures.bed ? `${filament.temperatures.bed}°C` : "—"} inherited={inherited.has("temperatures.bed")} />
        <InfoCard label={t("detail.field.bedFirstLayer")} value={filament.temperatures.bedFirstLayer ? `${filament.temperatures.bedFirstLayer}°C` : "—"} inherited={inherited.has("temperatures.bedFirstLayer")} />
        <InfoCard label={t("detail.field.cost")} value={filament.cost != null ? `${currencySymbol}${filament.cost.toFixed(2)}/kg` : "—"} inherited={inherited.has("cost")} />
        <InfoCard label={t("detail.field.density")} value={filament.density ? `${filament.density.toFixed(2)} g/cm³` : "—"} inherited={inherited.has("density")} />
        <InfoCard label={t("detail.field.diameter")} value={`${filament.diameter.toFixed(2)} mm`} inherited={inherited.has("diameter")} />
        <InfoCard label={t("detail.field.maxVolSpeed")} value={filament.maxVolumetricSpeed ? `${filament.maxVolumetricSpeed} mm³/s` : "—"} inherited={inherited.has("maxVolumetricSpeed")} />
      </div>

      {/* Spool Tracker */}
      {(filament.spools?.length > 0 || filament.spoolWeight != null || filament.totalWeight != null || filament.netFilamentWeight != null) && (() => {
        const hasSpools = filament.spools?.length > 0;
        const legacyRemaining = !hasSpools ? computeRemaining(filament) : null;

        // Aggregate stats across all spools
        let aggregateRemaining = 0;
        let aggregateTotal = 0;
        let validSpoolCount = 0;
        if (hasSpools && filament.spoolWeight != null) {
          for (const spool of filament.spools) {
            if (spool.totalWeight != null) {
              aggregateRemaining += Math.max(0, spool.totalWeight - filament.spoolWeight);
              validSpoolCount++;
            }
          }
          aggregateTotal = (filament.netFilamentWeight ?? 0) * validSpoolCount;
        }
        const aggregatePct = aggregateTotal > 0 ? Math.min(100, Math.round((aggregateRemaining / aggregateTotal) * 100)) : null;

        return (
          <div className="mb-8 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-gray-500">{t("detail.section.spoolTracker")}</h2>
              {hasSpools && (
                <span className="text-xs text-gray-400">
                  {t("detail.spoolCount", { count: filament.spools.length })}
                  {aggregatePct != null && ` · ${Math.round(aggregateRemaining)}g ${t("detail.total")} (${aggregatePct}%)`}
                </span>
              )}
            </div>

            {/* Filament-level info cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              {filament.netFilamentWeight != null && (
                <InfoCard label={t("detail.field.netFilament")} value={`${filament.netFilamentWeight}g`} inherited={inherited.has("netFilamentWeight")} />
              )}
              {filament.spoolWeight != null && (
                <InfoCard label={t("detail.field.spoolWeight")} value={`${filament.spoolWeight}g`} inherited={inherited.has("spoolWeight")} />
              )}
              {/* Legacy single-spool remaining */}
              {!hasSpools && legacyRemaining && (
                <InfoCard label={t("detail.field.remaining")} value={`${Math.round(legacyRemaining.remainingWeight)}g${legacyRemaining.pct != null ? ` (${legacyRemaining.pct}%)` : ""}`} />
              )}
              {!hasSpools && legacyRemaining?.lengthMeters != null && (
                <InfoCard label={t("detail.field.lengthLeft")} value={`${legacyRemaining.lengthMeters.toFixed(1)}m`} />
              )}
            </div>

            {/* Legacy single-spool progress bar & update */}
            {!hasSpools && legacyRemaining?.pct != null && (
              <div className="mb-4">
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
                  <div
                    className={`h-3 rounded-full transition-all ${
                      legacyRemaining.pct > 25 ? "bg-green-500" : legacyRemaining.pct > 10 ? "bg-yellow-500" : "bg-red-500"
                    }`}
                    style={{ width: `${legacyRemaining.pct}%` }}
                  />
                </div>
              </div>
            )}

            {!hasSpools && filament.spoolWeight != null && (
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <label className="text-sm text-gray-500 flex-shrink-0">{t("detail.weight.updateScaleWeight")}:</label>
                <input
                  ref={weightRef}
                  type="number"
                  step="1"
                  min="0"
                  className="w-28 px-2 py-1 border border-gray-300 rounded text-sm bg-transparent"
                  value={weightInput}
                  onChange={(e) => setWeightInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleWeightUpdate(); }}
                  placeholder={filament.totalWeight != null ? `${filament.totalWeight}g` : "grams"}
                />
                <button
                  onClick={handleWeightUpdate}
                  disabled={weightSaving || !weightInput}
                  className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {weightSaving ? "..." : t("common.save")}
                </button>
                {isElectron && nfcStatus.tagPresent && (
                  <button
                    onClick={() => {
                      const val = parseFloat(weightInput);
                      if (!isNaN(val) && val > 0) {
                        handleNfcWeightUpdate(val);
                      } else if (filament.totalWeight != null) {
                        handleNfcWeightUpdate(filament.totalWeight);
                      } else {
                        toast(t("detail.weight.enterFirst"), "error");
                      }
                    }}
                    disabled={nfcWriting}
                    className="px-3 py-1 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 disabled:opacity-50"
                    title={t("detail.nfc.updateWeightTitle")}
                  >
                    {nfcWriting ? "..." : t("detail.nfc.updateNfc")}
                  </button>
                )}
              </div>
            )}

            {/* Migrate legacy to spool tracking */}
            {!hasSpools && filament.totalWeight != null && (
              <button
                onClick={handleMigrateToSpools}
                className="text-xs text-blue-600 hover:underline"
              >
                {t("detail.spool.trackMultiple")} &rarr;
              </button>
            )}

            {/* Multi-spool cards */}
            {hasSpools && (
              <div className="space-y-3">
                {filament.spools.map((spool) => (
                  <SpoolCard
                    key={spool._id}
                    spool={spool}
                    filament={filament}
                    onUpdateWeight={(weight) => handleUpdateSpool(spool._id, { totalWeight: weight })}
                    onUpdateLabel={(label) => handleUpdateSpool(spool._id, { label })}
                    onRemove={() => handleRemoveSpool(spool._id)}
                    onNfcWeightUpdate={(scaleWeight) => handleNfcWeightUpdate(scaleWeight)}
                    nfcAvailable={isElectron && nfcStatus.tagPresent}
                    nfcWriting={nfcWriting}
                  />
                ))}
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAddSpool()}
                    className="flex-1 py-2 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
                  >
                    + {t("detail.addSpool")}
                  </button>
                  <button
                    onClick={() => setShowPrusamentImport(true)}
                    className="py-2 px-3 border-2 border-dashed border-orange-300 dark:border-orange-700 rounded-lg text-sm text-orange-500 hover:border-orange-400 hover:text-orange-600 transition-colors"
                    title={t("detail.spool.prusamentImportTitle")}
                  >
                    + {t("detail.spool.prusamentQr")}
                  </button>
                </div>
              </div>
            )}

            {/* Add first spool button when no weight data exists yet */}
            {!hasSpools && filament.totalWeight == null && filament.spoolWeight != null && (
              <button
                onClick={() => handleAddSpool()}
                className="w-full py-2 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
              >
                + Add Spool
              </button>
            )}
          </div>
        );
      })()}

      {filament.compatibleNozzles && filament.compatibleNozzles.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">
            {filament.calibrations?.length > 0
              ? t("detail.section.nozzleCalibrations")
              : t("detail.section.compatibleNozzles")}
            {inherited.has("compatibleNozzles") && (
              <span className="ml-1 text-xs text-blue-500">({t("detail.inherited")})</span>
            )}
          </h2>
          {filament.calibrations?.length > 0 ? (
            <div className="overflow-x-auto space-y-4">
              {(() => {
                // Group calibrations by printer
                const groups = new Map<string, typeof filament.calibrations>();
                for (const cal of filament.calibrations) {
                  const key = cal.printer?._id || "default";
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(cal);
                }
                return Array.from(groups.entries()).map(([groupKey, cals]) => (
                  <div key={groupKey}>
                    {groups.size > 1 && (
                      <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">
                        {cals[0].printer?.name || t("detail.calibration.defaultPrinter")}
                      </h3>
                    )}
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b border-gray-300">
                          <th className="text-left py-2 px-2">{t("detail.calibration.nozzle")}</th>
                          <th className="text-right py-2 px-2">{t("detail.calibration.em")}</th>
                          <th className="text-right py-2 px-2">{t("detail.calibration.maxVol")}</th>
                          <th className="text-right py-2 px-2">{t("detail.calibration.pa")}</th>
                          <th className="text-right py-2 px-2">{t("detail.calibration.retract")}</th>
                          <th className="text-right py-2 px-2">{t("detail.calibration.speed")}</th>
                          <th className="text-right py-2 px-2">{t("detail.calibration.zLift")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cals.map((cal, i) => (
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
                ));
              })()}
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

      {filament.presets && filament.presets.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">
            {t("detail.section.presets")}
            {inherited.has("presets") && (
              <span className="ml-1 text-xs text-blue-500">({t("detail.inherited")})</span>
            )}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="text-left py-2 px-2">{t("detail.preset.label")}</th>
                  <th className="text-right py-2 px-2">{t("detail.calibration.em")}</th>
                  <th className="text-right py-2 px-2">{t("detail.calibration.nozzle")}</th>
                  <th className="text-right py-2 px-2">{t("detail.preset.nozzleFirst")}</th>
                  <th className="text-right py-2 px-2">{t("detail.preset.bed")}</th>
                  <th className="text-right py-2 px-2">{t("detail.preset.bedFirst")}</th>
                </tr>
              </thead>
              <tbody>
                {filament.presets.map((preset, i) => (
                  <tr
                    key={i}
                    className="border-b border-gray-200 dark:border-gray-800"
                  >
                    <td className="py-2 px-2 font-medium">{preset.label}</td>
                    <td className="py-2 px-2 text-right">
                      {preset.extrusionMultiplier ?? "—"}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {preset.temperatures?.nozzle ? `${preset.temperatures.nozzle}°C` : "—"}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {preset.temperatures?.nozzleFirstLayer ? `${preset.temperatures.nozzleFirstLayer}°C` : "—"}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {preset.temperatures?.bed ? `${preset.temperatures.bed}°C` : "—"}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {preset.temperatures?.bedFirstLayer ? `${preset.temperatures.bedFirstLayer}°C` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
            {showTdsPreview ? t("detail.tds.hide") : t("detail.tds.view")}
          </button>
          <a
            href={filament.tdsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-3 text-xs text-gray-500 hover:underline"
          >
            {t("detail.tds.openNewTab")}
          </a>
          {showTdsPreview && (
            <div className="mt-3 border border-gray-300 dark:border-gray-700 rounded overflow-hidden">
              <iframe
                src={filament.tdsUrl}
                className="w-full bg-white"
                style={{ height: "80vh" }}
                title={t("detail.tds.title")}
                sandbox="allow-same-origin allow-scripts"
              />
            </div>
          )}
        </div>
      )}

      {filament.inherits && (
        <p className="text-sm text-gray-500 mb-4">
          {t("detail.inheritsFrom")}: <span className="font-mono">{filament.inherits}</span>
        </p>
      )}

      {filament.settings && Object.keys(filament.settings).length > 0 && (<div>
        <button
          onClick={() => setShowAllSettings(!showAllSettings)}
          className="text-sm text-blue-600 hover:underline mb-3"
        >
          {showAllSettings ? t("detail.settings.hide") : t("detail.settings.show")} ({t("detail.settings.keyCount", { count: Object.keys(filament.settings).length })})
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
      </div>)}

      {showPrusamentImport && (
        <PrusamentImportDialog
          onClose={() => setShowPrusamentImport(false)}
          targetFilamentId={filament?._id}
          onImported={(message) => {
            toast(message, "success");
            // Refresh filament data
            fetch(`/api/filaments/${params.id}`)
              .then((r) => r.json())
              .then((data) => setFilament(data))
              .catch(() => {});
            setShowPrusamentImport(false);
          }}
        />
      )}
    </main>
  );
}

interface SpoolCardProps {
  spool: Filament["spools"][number];
  filament: Filament;
  onUpdateWeight: (weight: number) => void;
  onUpdateLabel: (label: string) => void;
  onRemove: () => void;
  onNfcWeightUpdate?: (scaleWeight: number) => void;
  nfcAvailable?: boolean;
  nfcWriting?: boolean;
}

function SpoolCard({ spool, filament, onUpdateWeight, onUpdateLabel, onRemove, onNfcWeightUpdate, nfcAvailable, nfcWriting }: SpoolCardProps) {
  const { t } = useTranslation();
  const [weightInput, setWeightInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelInput, setLabelInput] = useState(spool.label);

  const remaining = computeRemaining(filament, spool.totalWeight);

  const handleSave = async () => {
    const val = parseFloat(weightInput);
    if (isNaN(val) || val < 0) return;
    setSaving(true);
    await onUpdateWeight(val);
    setWeightInput("");
    setSaving(false);
  };

  const handleLabelSave = () => {
    if (labelInput !== spool.label) {
      onUpdateLabel(labelInput);
    }
    setEditingLabel(false);
  };

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {editingLabel ? (
            <input
              type="text"
              className="px-2 py-0.5 border border-gray-300 rounded text-sm bg-transparent w-40"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              onBlur={handleLabelSave}
              onKeyDown={(e) => { if (e.key === "Enter") handleLabelSave(); if (e.key === "Escape") { setLabelInput(spool.label); setEditingLabel(false); } }}
              autoFocus
              placeholder={t("detail.spool.labelPlaceholder")}
            />
          ) : (
            <button
              onClick={() => setEditingLabel(true)}
              className="text-sm font-medium hover:text-blue-600 transition-colors"
              title={t("detail.spool.clickToRename")}
            >
              {spool.label || t("detail.spool.unnamed")}
            </button>
          )}
        </div>
        <button
          onClick={onRemove}
          className="text-gray-400 hover:text-red-500 transition-colors"
          title={t("detail.spool.remove")}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Progress bar */}
      {remaining?.pct != null && (
        <div className="mb-2">
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                remaining.pct > 25 ? "bg-green-500" : remaining.pct > 10 ? "bg-yellow-500" : "bg-red-500"
              }`}
              style={{ width: `${remaining.pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-4 text-sm text-gray-500 mb-2">
        {remaining && (
          <span>{Math.round(remaining.remainingWeight)}g {t("detail.spool.remaining")}{remaining.pct != null ? ` (${remaining.pct}%)` : ""}</span>
        )}
        {remaining?.lengthMeters != null && (
          <span>{remaining.lengthMeters.toFixed(1)}m {t("detail.spool.left")}</span>
        )}
        {!remaining && spool.totalWeight != null && (
          <span>{spool.totalWeight}g {t("detail.spool.onScale")}</span>
        )}
      </div>

      {/* Inline weight update */}
      {filament.spoolWeight != null && (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="number"
            step="1"
            min="0"
            className="w-28 px-2 py-1 border border-gray-300 rounded text-sm bg-transparent"
            value={weightInput}
            onChange={(e) => setWeightInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            placeholder={spool.totalWeight != null ? `${spool.totalWeight}g` : "grams"}
          />
          <button
            onClick={handleSave}
            disabled={saving || !weightInput}
            className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "..." : t("common.save")}
          </button>
          {nfcAvailable && onNfcWeightUpdate && (
            <button
              onClick={() => {
                const val = parseFloat(weightInput);
                if (!isNaN(val) && val > 0) {
                  onNfcWeightUpdate(val);
                } else if (spool.totalWeight != null) {
                  onNfcWeightUpdate(spool.totalWeight);
                }
              }}
              disabled={nfcWriting}
              className="px-3 py-1 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 disabled:opacity-50"
              title={t("detail.nfc.updateWeightTitle")}
            >
              {nfcWriting ? "..." : t("detail.nfc.updateNfc")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function InfoCard({ label, value, inherited = false }: { label: string; value: string; inherited?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`rounded p-3 ${inherited ? "bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800" : "bg-gray-50 dark:bg-gray-900"}`}>
      <p className="text-xs text-gray-500 mb-1">
        {label}
        {inherited && <span className="ml-1 text-blue-500">({t("detail.inherited")})</span>}
      </p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

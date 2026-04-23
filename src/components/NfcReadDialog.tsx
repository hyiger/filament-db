"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useNfcContext, type NfcTagReadResult } from "./NfcProvider";
import CopyButton from "./CopyButton";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function NfcReadDialog() {
  const router = useRouter();
  const { tagReadResult, dismissTagRead } = useNfcContext();
  const { t } = useTranslation();

  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape key handler
  useEffect(() => {
    if (!tagReadResult) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissTagRead();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [tagReadResult, dismissTagRead]);

  // Focus trap: focus the dialog when it appears and trap tab within it
  useEffect(() => {
    if (!tagReadResult || !dialogRef.current) return;
    dialogRef.current.focus();

    const dialog = dialogRef.current;
    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || document.activeElement === dialog) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleTab);
    return () => document.removeEventListener("keydown", handleTab);
  }, [tagReadResult]);

  if (!tagReadResult) return null;

  const { data, error, empty, match, candidates } = tagReadResult;

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
    if (data.shoreHardnessA != null) params.set("shoreA", String(data.shoreHardnessA));
    if (data.shoreHardnessD != null) params.set("shoreD", String(data.shoreHardnessD));
    if (data.tags && data.tags.length > 0) params.set("optTags", data.tags.join(","));
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
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" aria-hidden="true" onClick={dismissTagRead} />
    <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nfc-dialog-title"
        tabIndex={-1}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-2xl max-w-md w-full mx-4 p-6 pointer-events-auto outline-none"
      >
        {/* Error state */}
        {error ? (
          <>
            <h2 id="nfc-dialog-title" className="text-xl font-bold text-gray-900 dark:text-white mb-4">{t("nfc.readDialog.errorTitle")}</h2>
            <div className="text-red-600 dark:text-red-400 mb-6">{error}</div>
            <div className="flex justify-end">
              <button
                onClick={dismissTagRead}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400 dark:hover:border-gray-500"
              >
                {t("nfc.readDialog.dismiss")}
              </button>
            </div>
          </>
        ) : empty ? (
          /* Empty/blank tag */
          <>
            <div className="flex items-center gap-2 mb-4">
              <svg className="w-5 h-5 text-blue-500 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h2 id="nfc-dialog-title" className="text-xl font-bold text-gray-900 dark:text-white">{t("nfc.readDialog.emptyTitle")}</h2>
            </div>
            <div className="text-gray-600 dark:text-gray-300 text-sm mb-6">{t("nfc.readDialog.emptyBody")}</div>
            <div className="flex justify-end">
              <button
                onClick={dismissTagRead}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400 dark:hover:border-gray-500"
              >
                {t("nfc.readDialog.dismiss")}
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
              <h2 id="nfc-dialog-title" className="text-xl font-bold text-gray-900 dark:text-white">{t("nfc.readDialog.found")}</h2>
            </div>

            <div className="flex items-center gap-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-4 mb-4">
              <div
                className="w-10 h-10 rounded-full border border-gray-300 dark:border-gray-600 flex-shrink-0"
                style={{ backgroundColor: match.color || "#808080" }}
                aria-label={`Color swatch: ${match.color || "#808080"}`}
              />
              <div className="min-w-0">
                <div className="text-gray-900 dark:text-white font-semibold truncate">{match.name}</div>
                <div className="text-gray-500 dark:text-gray-400 text-sm">
                  {match.vendor} &middot; {match.type}
                </div>
              </div>
            </div>

            {data && <TagDataGrid data={data} />}

            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={dismissTagRead}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400 dark:hover:border-gray-500"
              >
                {t("nfc.readDialog.dismiss")}
              </button>
              <button
                onClick={handleCreateNew}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400 dark:hover:border-gray-500"
              >
                {t("nfc.readDialog.createNew")}
              </button>
              <button
                onClick={() => handleGoToFilament(match._id)}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500"
              >
                {t("nfc.readDialog.viewFilament")}
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
              <h2 id="nfc-dialog-title" className="text-xl font-bold text-gray-900 dark:text-white">{t("nfc.readDialog.unknownFilament")}</h2>
            </div>

            <div className="flex items-center gap-3 mb-4">
              {data.color && (
                <div
                  className="w-8 h-8 rounded-full border border-gray-300 dark:border-gray-600 flex-shrink-0"
                  style={{ backgroundColor: data.color }}
                  aria-label={`Color swatch: ${data.color}`}
                />
              )}
              <div>
                <div className="text-gray-900 dark:text-white font-semibold">
                  {data.materialName || t("nfc.readDialog.unknown")}
                </div>
                <div className="text-gray-500 dark:text-gray-400 text-sm">
                  {data.brandName}{data.materialType ? ` · ${data.materialType}` : ""}
                </div>
              </div>
            </div>

            <TagDataGrid data={data} />

            {/* Similar filaments — offer to create as variant */}
            {candidates && candidates.length > 0 && (
              <div className="mt-4">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t("nfc.readDialog.similarFilaments")}</div>
                <div className="space-y-1">
                  {candidates.map((c) => (
                    <div
                      key={c._id}
                      className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded text-sm"
                    >
                      <div
                        className="w-4 h-4 rounded-full border border-gray-300 dark:border-gray-600 flex-shrink-0"
                        style={{ backgroundColor: c.color || "#808080" }}
                        aria-label={`Color swatch: ${c.color || "#808080"}`}
                      />
                      <span className="text-gray-900 dark:text-white truncate flex-1">{c.name}</span>
                      <button
                        onClick={() => handleGoToFilament(c._id)}
                        className="text-blue-400 hover:text-blue-300 text-xs flex-shrink-0"
                      >
                        {t("nfc.readDialog.view")}
                      </button>
                      <button
                        onClick={() => handleCreateAsVariant(c._id)}
                        className="text-amber-400 hover:text-amber-300 text-xs flex-shrink-0"
                      >
                        {t("nfc.readDialog.addVariant")}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={dismissTagRead}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400 dark:hover:border-gray-500"
              >
                {t("nfc.readDialog.dismiss")}
              </button>
              <button
                onClick={handleCreateNew}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500"
              >
                {t("nfc.readDialog.createNewFilament")}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
    </>
  );
}

function TagDataGrid({ data }: { data: NonNullable<NfcTagReadResult["data"]> }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2 text-sm">
      {data.tagSource === "bambu" && (
        <div className="col-span-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-3 py-1.5 rounded">
          {t("nfc.readDialog.bambuReadOnly")}
        </div>
      )}
      {data.materialName && (
        <Stat label={t("nfc.readDialog.labelMaterialName")} value={data.materialName} />
      )}
      {data.brandName && (
        <Stat label={t("nfc.readDialog.labelBrand")} value={data.brandName} />
      )}
      {data.materialType && (
        <Stat label={t("nfc.readDialog.labelMaterialType")} value={data.materialType} />
      )}
      {data.materialAbbreviation && data.materialAbbreviation !== data.materialType && (
        <Stat label={t("nfc.readDialog.labelAbbreviation")} value={data.materialAbbreviation} />
      )}
      {data.color && (
        <div className="bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded">
          <div className="text-gray-500 dark:text-gray-400 text-xs">{t("nfc.readDialog.labelColor")}</div>
          <div className="flex items-center gap-2">
            <div
              className="w-4 h-4 rounded-full border border-gray-300 dark:border-gray-600"
              style={{ backgroundColor: data.color }}
              aria-label={`Color swatch: ${data.color}`}
            />
            <span className="text-gray-900 dark:text-white">{data.color}</span>
          </div>
        </div>
      )}
      {data.diameter != null && (
        <Stat label={t("nfc.readDialog.labelDiameter")} value={`${data.diameter.toFixed(2)} mm`} />
      )}
      {data.density != null && (
        <Stat label={t("nfc.readDialog.labelDensity")} value={`${data.density.toFixed(2)} g/cm³`} />
      )}
      {data.weightGrams != null && (
        <Stat label={t("nfc.readDialog.labelNetWeight")} value={`${data.weightGrams} g`} />
      )}
      {data.actualWeightGrams != null && data.actualWeightGrams !== data.weightGrams && (
        <Stat label={t("nfc.readDialog.labelActualRemaining")} value={`${data.actualWeightGrams} g`} />
      )}
      {data.emptySpoolWeight != null && (
        <Stat label={t("nfc.readDialog.labelSpoolWeight")} value={`${data.emptySpoolWeight} g`} />
      )}
      {data.nozzleTemp != null && (
        <Stat label={t("nfc.readDialog.labelNozzleTemp")} value={`${data.nozzleTempMin ?? "?"}–${data.nozzleTemp}°C`} />
      )}
      {data.preheatTemp != null && (
        <Stat label={t("nfc.readDialog.labelPreheatTemp")} value={`${data.preheatTemp}°C`} />
      )}
      {data.bedTemp != null && (
        <Stat label={t("nfc.readDialog.labelBedTemp")} value={`${data.bedTempMin ?? "?"}–${data.bedTemp}°C`} />
      )}
      {data.chamberTemp != null && (
        <Stat label={t("nfc.readDialog.labelChamberTemp")} value={`${data.chamberTemp}°C`} />
      )}
      {data.dryingTemperature != null && (
        <Stat label={t("nfc.readDialog.labelDryingTemp")} value={`${data.dryingTemperature}°C`} />
      )}
      {data.dryingTime != null && (
        <Stat label={t("nfc.readDialog.labelDryingTime")} value={`${Math.floor(data.dryingTime / 60)}h ${data.dryingTime % 60}m`} />
      )}
      {data.transmissionDistance != null && (
        <Stat label={t("nfc.readDialog.labelHueForgeTD")} value={String(data.transmissionDistance)} />
      )}
      {data.countryOfOrigin && (
        <Stat label={t("nfc.readDialog.labelOrigin")} value={data.countryOfOrigin} />
      )}
      {data.spoolUid && (
        <Stat label={t("nfc.readDialog.labelInstanceId")} value={data.spoolUid} copyable />
      )}
      {data.filamentLength != null && (
        <Stat label={t("nfc.readDialog.labelFilamentLength")} value={`${data.filamentLength} m`} />
      )}
      {data.productionDate && (
        <Stat label={t("nfc.readDialog.labelProductionDate")} value={data.productionDate.replace(/_/g, "-").replace(/-(\d{2})-(\d{2})$/, " $1:$2")} />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded">
      <div className="text-gray-500 dark:text-gray-400 text-xs">{label}</div>
      <div className="text-gray-900 dark:text-white flex items-center gap-1.5">
        <span className={copyable ? "font-mono text-sm break-all" : ""}>{value}</span>
        {copyable && <CopyButton value={value} />}
      </div>
    </div>
  );
}

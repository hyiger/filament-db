"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

interface PrusamentScrapeResult {
  spoolId: string;
  productName: string;
  material: string;
  colorName: string;
  colorHex: string;
  diameter: number;
  diameterAvg: number;
  diameterStdDev: number | null;
  ovality: number;
  netWeight: number;
  spoolWeight: number;
  totalWeight: number;
  lengthMeters: number;
  nozzleTempMin: number;
  nozzleTempMax: number;
  bedTempMin: number;
  bedTempMax: number;
  manufactureDate: string;
  country: string;
  goodsId: number;
  priceUsd: number | null;
  priceEur: number | null;
  photoUrl: string;
  pageUrl: string;
}

interface MatchingFilament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
}

interface Props {
  onClose: () => void;
  onImported: (message: string) => void;
  /** Pre-fill with a filament ID to add a spool to */
  targetFilamentId?: string;
}

type Step = "input" | "preview" | "importing";

export default function PrusamentImportDialog({
  onClose,
  onImported,
  targetFilamentId,
}: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("input");
  const [spoolInput, setSpoolInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [spool, setSpool] = useState<PrusamentScrapeResult | null>(null);
  const [matches, setMatches] = useState<MatchingFilament[]>([]);
  const [action, setAction] = useState<"create" | "add-spool">(
    targetFilamentId ? "add-spool" : "create",
  );
  const [selectedFilamentId, setSelectedFilamentId] = useState<string>(
    targetFilamentId || "",
  );
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap & escape
  useEffect(() => {
    if (!dialogRef.current) return;
    dialogRef.current.focus();
    const dialog = dialogRef.current;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab") return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (
          document.activeElement === first ||
          document.activeElement === dialog
        ) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleLookup = async () => {
    const input = spoolInput.trim();
    if (!input) return;

    // Extract spool ID from URL or bare ID
    let id = input;
    if (input.includes("spoolId=")) {
      try {
        const url = new URL(input);
        id = url.searchParams.get("spoolId") || input;
      } catch {
        // not a URL, use as-is
      }
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch(
        `/api/prusament?spoolId=${encodeURIComponent(id)}`,
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t("prusament.import.lookupFailed"));
        setLoading(false);
        return;
      }

      setSpool(data);

      // Find matching filaments by material type
      const filRes = await fetch(
        `/api/filaments?type=${encodeURIComponent(data.material)}`,
      );
      if (filRes.ok) {
        const filaments = await filRes.json();
        setMatches(filaments);

        // Auto-select if target provided
        if (targetFilamentId) {
          setAction("add-spool");
          setSelectedFilamentId(targetFilamentId);
        } else {
          // Check for exact name match
          const exactName = `Prusament ${data.material} ${data.colorName}`;
          const exact = filaments.find(
            (f: MatchingFilament) => f.name === exactName,
          );
          if (exact) {
            setAction("add-spool");
            setSelectedFilamentId(exact._id);
          }
        }
      }

      setStep("preview");
    } catch {
      setError(t("prusament.import.networkError"));
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!spool) return;
    setStep("importing");
    setError("");

    try {
      const res = await fetch("/api/prusament/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spool,
          action,
          filamentId:
            action === "add-spool" ? selectedFilamentId : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t("prusament.import.importFailed"));
        setStep("preview");
        return;
      }

      onImported(data.message);
    } catch {
      setError(t("prusament.import.networkErrorDuringImport"));
      setStep("preview");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prusament-import-title"
        className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b dark:border-zinc-700">
          <h2 id="prusament-import-title" className="text-lg font-semibold">{t("prusament.import.title")}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {error && (
            <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded p-3 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {/* Step 1: Input */}
          {step === "input" && (
            <>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {t("prusament.import.description")}
              </p>
              <input
                type="text"
                value={spoolInput}
                onChange={(e) => setSpoolInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLookup()}
                placeholder={t("prusament.import.placeholder")}
                className="w-full px-3 py-2 border rounded dark:bg-zinc-800 dark:border-zinc-700 focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm border rounded hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  {t("prusament.import.cancel")}
                </button>
                <button
                  onClick={handleLookup}
                  disabled={loading || !spoolInput.trim()}
                  className="px-4 py-2 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
                >
                  {loading ? t("prusament.import.lookingUp") : t("prusament.import.lookUp")}
                </button>
              </div>
            </>
          )}

          {/* Step 2: Preview */}
          {step === "preview" && spool && (
            <>
              {/* Spool info card */}
              <div className="border rounded-lg dark:border-zinc-700 overflow-hidden">
                <div className="bg-zinc-50 dark:bg-zinc-800 px-4 py-3 border-b dark:border-zinc-700">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-full border dark:border-zinc-600 shrink-0"
                      style={{ backgroundColor: spool.colorHex }}
                    />
                    <div>
                      <div className="font-medium">{spool.productName}</div>
                      <div className="text-xs text-zinc-500">
                        {spool.colorName} &middot; {t("prusament.import.spool")} {spool.spoolId}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <div className="text-zinc-500">{t("prusament.import.material")}</div>
                  <div>{spool.material}</div>
                  <div className="text-zinc-500">{t("prusament.import.diameter")}</div>
                  <div>
                    {spool.diameterAvg.toFixed(2)} mm (avg) &plusmn;{" "}
                    {spool.diameterStdDev?.toFixed(1) ?? "?"} &micro;m
                  </div>
                  <div className="text-zinc-500">{t("prusament.import.netWeight")}</div>
                  <div>{spool.netWeight} g</div>
                  <div className="text-zinc-500">{t("prusament.import.spoolWeight")}</div>
                  <div>{spool.spoolWeight} g</div>
                  <div className="text-zinc-500">{t("prusament.import.totalWeight")}</div>
                  <div className="font-medium">{spool.totalWeight} g</div>
                  <div className="text-zinc-500">{t("prusament.import.length")}</div>
                  <div>{Math.round(spool.lengthMeters)} m</div>
                  <div className="text-zinc-500">{t("prusament.import.nozzleTemp")}</div>
                  <div>
                    {spool.nozzleTempMin}&ndash;{spool.nozzleTempMax} &deg;C
                  </div>
                  <div className="text-zinc-500">{t("prusament.import.bedTemp")}</div>
                  <div>
                    {spool.bedTempMin}&ndash;{spool.bedTempMax} &deg;C
                  </div>
                  <div className="text-zinc-500">{t("prusament.import.manufactured")}</div>
                  <div>{spool.manufactureDate.split(" ")[0]}</div>
                  {spool.priceUsd && (
                    <>
                      <div className="text-zinc-500">{t("prusament.import.price")}</div>
                      <div>${spool.priceUsd}</div>
                    </>
                  )}
                </div>
              </div>

              {/* Action selector */}
              <div className="space-y-3">
                <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {t("prusament.import.importAs")}
                </label>

                <label className="flex items-start gap-2 p-3 border rounded-lg cursor-pointer hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                  <input
                    type="radio"
                    name="action"
                    value="create"
                    checked={action === "create"}
                    onChange={() => setAction("create")}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-sm font-medium">
                      {t("prusament.import.newFilament")}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {t("prusament.import.createDescription", { material: spool.material, color: spool.colorName })}
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2 p-3 border rounded-lg cursor-pointer hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                  <input
                    type="radio"
                    name="action"
                    value="add-spool"
                    checked={action === "add-spool"}
                    onChange={() => setAction("add-spool")}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium">
                      {t("prusament.import.addToExisting")}
                    </div>
                    {matches.length > 0 ? (
                      <select
                        value={selectedFilamentId}
                        onChange={(e) => {
                          setSelectedFilamentId(e.target.value);
                          setAction("add-spool");
                        }}
                        className="mt-1 w-full text-sm px-2 py-1.5 border rounded dark:bg-zinc-800 dark:border-zinc-700"
                      >
                        <option value="">{t("prusament.import.selectFilament")}</option>
                        {matches.map((f) => (
                          <option key={f._id} value={f._id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="text-xs text-zinc-500 mt-1">
                        {t("prusament.import.noExistingFilaments", { material: spool.material })}
                      </div>
                    )}
                  </div>
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => {
                    setStep("input");
                    setSpool(null);
                    setError("");
                  }}
                  className="px-4 py-2 text-sm border rounded hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  {t("prusament.import.back")}
                </button>
                <button
                  onClick={handleImport}
                  disabled={
                    action === "add-spool" && !selectedFilamentId
                  }
                  className="px-4 py-2 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
                >
                  {t("prusament.import.import")}
                </button>
              </div>
            </>
          )}

          {/* Step 3: Importing */}
          {step === "importing" && (
            <div className="flex items-center justify-center py-8 gap-3 text-zinc-500">
              <svg
                className="animate-spin h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              {t("prusament.import.importingSpool")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

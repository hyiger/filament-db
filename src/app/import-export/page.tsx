"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import ImportAtlasDialog from "@/components/ImportAtlasDialog";
import PrusamentImportDialog from "@/components/PrusamentImportDialog";
import SpoolCsvImportDialog from "@/components/SpoolCsvImportDialog";
import { useTranslation } from "@/i18n/TranslationProvider";

/**
 * A dedicated page that mirrors the Import / Export dropdown on the filament
 * list. The dropdown stays — most users will use it because it's right where
 * they're managing filaments — but this page gives you a discoverable entry
 * point from Settings and a stable URL for documentation/links.
 *
 * The import dialogs are the same standalone components the filament list
 * uses, so behaviour stays identical. After a successful import this page
 * just toasts; the user can navigate back to the filament list to see the
 * results (linked at the top).
 */
export default function ImportExportPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [showAtlas, setShowAtlas] = useState(false);
  const [showPrusament, setShowPrusament] = useState(false);
  const [showSpoolCsv, setShowSpoolCsv] = useState(false);
  const [importingFile, setImportingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    let endpoint = "/api/filaments/import";
    if (ext === "csv") endpoint = "/api/filaments/import-csv";
    else if (ext === "xlsx") endpoint = "/api/filaments/import-xlsx";

    setImportingFile(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(endpoint, { method: "POST", body: formData });
      const data = await res.json();
      if (res.ok) {
        toast(data.message || t("importExport.fileImported"));
      } else {
        toast(t("filaments.importFailed", { error: data.error }), "error");
      }
    } catch {
      toast(t("filaments.importNetworkError"), "error");
    } finally {
      setImportingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; {t("importExport.backToFilaments")}
        </Link>
      </div>
      <h1 className="text-3xl font-bold mb-2">{t("importExport.title")}</h1>
      <p className="text-sm text-gray-500 mb-8">{t("importExport.subtitle")}</p>

      {/* Import filaments */}
      <Section title={t("importExport.importFilaments")}>
        <Tile
          dot="bg-orange-500"
          label={t("filaments.import.prusamentQR")}
          desc={t("importExport.prusamentDesc")}
          onClick={() => setShowPrusament(true)}
        />
        <Tile
          dot="bg-purple-500"
          label={t("filaments.import.fromAtlas")}
          desc={t("importExport.atlasDesc")}
          onClick={() => setShowAtlas(true)}
        />
        <Tile
          dot="bg-teal-500"
          label={t("filaments.import.browseOpenPrintTag")}
          desc={t("importExport.opentagDesc")}
          href="/openprinttag"
        />
        <Tile
          dot="bg-amber-500"
          label={importingFile ? t("filaments.import.importing") : t("filaments.import.file")}
          desc={t("importExport.fileDesc")}
          onClick={() => fileInputRef.current?.click()}
          disabled={importingFile}
        />
        <input
          ref={fileInputRef}
          type="file"
          // `.json` was here but the filament import handler routes
          // anything that isn't `.csv` or `.xlsx` to `/api/filaments/import`,
          // which parses INI bundles only — JSON snapshots come back
          // with a confusing "No filament profiles found in the INI
          // file" error. Snapshot restore is a separate flow under
          // Settings → Backup & Restore. Issue #363.
          accept=".csv,.xlsx,.ini"
          className="hidden"
          onChange={handleFileImport}
        />
      </Section>

      {/* Import spools */}
      <Section title={t("importExport.importSpools")}>
        <Tile
          dot="bg-blue-500"
          label={t("filaments.import.spoolCsv")}
          desc={t("importExport.spoolCsvDesc")}
          onClick={() => setShowSpoolCsv(true)}
        />
      </Section>

      {/* Export filaments */}
      <Section title={t("importExport.exportFilaments")}>
        <Tile
          dot="bg-green-500"
          label={t("filaments.export.ini")}
          desc={t("importExport.iniDesc")}
          href="/api/filaments/export"
          download
        />
        <Tile
          dot="bg-green-500"
          label={t("filaments.export.csv")}
          desc={t("importExport.csvDesc")}
          href="/api/filaments/export-csv"
          download
        />
        <Tile
          dot="bg-green-500"
          label={t("filaments.export.xlsx")}
          desc={t("importExport.xlsxDesc")}
          href="/api/filaments/export-xlsx"
          download
        />
      </Section>

      {/* Export spools */}
      <Section title={t("importExport.exportSpools")}>
        <Tile
          dot="bg-green-500"
          label={t("spools.export.csv")}
          desc={t("importExport.spoolCsvExportDesc")}
          href="/api/spools/export-csv"
          download
        />
      </Section>

      {/* Snapshot */}
      <Section title={t("importExport.snapshot")}>
        <p className="text-xs text-gray-500 mb-3">
          {t("importExport.snapshotDesc")}{" "}
          <Link href="/settings" className="text-blue-600 hover:underline">
            {t("importExport.snapshotInSettings")}
          </Link>
        </p>
      </Section>

      {showAtlas && (
        <ImportAtlasDialog
          onClose={() => setShowAtlas(false)}
          onImported={(message) => {
            toast(message, "success");
            setShowAtlas(false);
          }}
        />
      )}
      {showPrusament && (
        <PrusamentImportDialog
          onClose={() => setShowPrusament(false)}
          onImported={(message) => {
            toast(message, "success");
            setShowPrusament(false);
          }}
        />
      )}
      {showSpoolCsv && (
        <SpoolCsvImportDialog
          onClose={() => setShowSpoolCsv(false)}
          onImported={() => {
            // Toast is handled inside the dialog; nothing to refresh here
            // since this page doesn't render the spool list itself.
          }}
        />
      )}
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
        {title}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{children}</div>
    </section>
  );
}

function Tile({
  dot,
  label,
  desc,
  onClick,
  href,
  download,
  disabled,
}: {
  dot: string;
  label: string;
  desc?: string;
  onClick?: () => void;
  href?: string;
  download?: boolean;
  disabled?: boolean;
}) {
  const inner = (
    <div className="flex items-start gap-3">
      <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dot}`} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
        {desc && <p className="text-xs text-gray-500 mt-0.5">{desc}</p>}
      </div>
    </div>
  );
  const className =
    "block text-left p-3 border border-gray-200 dark:border-gray-700 rounded hover:border-gray-400 dark:hover:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors disabled:opacity-50";

  if (href) {
    // Use a plain anchor tag for downloads so the browser triggers the
    // attachment header instead of trying to client-route. /openprinttag
    // is a real page and works fine through anchor too.
    return (
      <a href={href} download={download} className={className}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={className}>
      {inner}
    </button>
  );
}

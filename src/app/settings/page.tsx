"use client";

import { useTranslation } from "@/i18n/TranslationProvider";
import { useIsElectron } from "@/hooks/useIsElectron";
import SettingsTile from "@/components/SettingsTile";

export default function SettingsPage() {
  const { t } = useTranslation();
  const isElectron = useIsElectron();

  return (
    <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-2">{t("settings.title")}</h1>
      <p className="text-gray-500 text-sm mb-8">{t("settings.subtitle")}</p>

      {/* Manage — entity catalogs, each its own page */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
        {t("settings.group.manage")}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <SettingsTile href="/nozzles" title={t("settings.nozzles")} description={t("settings.nozzlesDesc")} />
        <SettingsTile href="/printers" title={t("settings.printers")} description={t("settings.printersDesc")} />
        <SettingsTile href="/bed-types" title={t("settings.bedTypes")} description={t("settings.bedTypesDesc")} />
        <SettingsTile href="/locations" title={t("settings.locations")} description={t("settings.locationsDesc")} />
        <SettingsTile href="/trash" title={t("settings.trash")} description={t("settings.trashDesc")} />
        <SettingsTile href="/import-export" title={t("settings.importExport")} description={t("settings.importExportDesc")} />
        <SettingsTile href="/api-docs" title={t("settings.apiDocs")} description={t("settings.apiDocsDesc")} />
      </div>

      {/* Configure — preferences + integrations, each its own page */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3 mt-10">
        {t("settings.group.configure")}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <SettingsTile href="/settings/ui" title={t("settings.group.ui")} description={t("settings.group.ui.desc")} />
        {/* Network controls (connection mode, LAN share) are desktop-only, so
            the tile only appears in Electron. */}
        {isElectron && (
          <SettingsTile href="/settings/network" title={t("settings.group.network")} description={t("settings.group.network.desc")} />
        )}
        <SettingsTile href="/settings/backup" title={t("settings.group.data")} description={t("settings.group.data.desc")} />
        <SettingsTile href="/settings/ai" title={t("settings.group.ai")} description={t("settings.group.ai.desc")} />
        <SettingsTile href="/settings/devices" title={t("settings.group.devices")} description={t("settings.group.devices.desc")} />
      </div>

      {/* Danger Zone — its own red tile → page */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-10">
        <SettingsTile href="/settings/danger" title={t("settings.group.danger")} description={t("settings.group.danger.desc")} danger />
      </div>
    </main>
  );
}

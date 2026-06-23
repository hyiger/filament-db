"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useIsElectron } from "@/hooks/useIsElectron";

type ConnectionMode = "atlas" | "hybrid" | "offline" | "";

export default function NetworkSettingsPage() {
  const { t } = useTranslation();
  const isElectron = useIsElectron();

  const CONNECTION_MODES: { id: ConnectionMode; label: string; icon: string; description: string; needsUri: boolean }[] = [
    { id: "atlas", label: t("settings.connectionAtlas"), icon: "☁", description: t("settings.connectionAtlasDesc"), needsUri: true },
    { id: "hybrid", label: t("settings.connectionHybrid"), icon: "⇄", description: t("settings.connectionHybridDesc"), needsUri: true },
    { id: "offline", label: t("settings.connectionOffline"), icon: "💾", description: t("settings.connectionOfflineDesc"), needsUri: false },
  ];

  const [currentMode, setCurrentMode] = useState<ConnectionMode>("");
  const [pendingMode, setPendingMode] = useState<ConnectionMode>("");
  const [atlasUri, setAtlasUri] = useState("");
  const [hasStoredUri, setHasStoredUri] = useState(false);
  const [modeSwitching, setModeSwitching] = useState(false);
  const [modeResult, setModeResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showUriInput, setShowUriInput] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);

  const [exposeToLan, setExposeToLan] = useState(false);
  const [lanInfo, setLanInfo] = useState<{ ips: string[]; port: number } | null>(null);
  const [lanSaving, setLanSaving] = useState(false);
  const [lanError, setLanError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const api = window.electronAPI;
    if (!api?.getConfig) return;
    api.getConfig().then((cfg) => {
      if (controller.signal.aborted) return;
      if (cfg.connectionMode) setCurrentMode(cfg.connectionMode as ConnectionMode);
      if (cfg.atlasUri) setHasStoredUri(true);
      if (typeof cfg.exposeToLan === "boolean") setExposeToLan(cfg.exposeToLan);
    }).catch(() => {});
    api.getLanInfo?.().then((info) => {
      if (!controller.signal.aborted) setLanInfo(info);
    }).catch(() => {});
    return () => { controller.abort(); };
  }, []);

  async function toggleLanShare(next: boolean) {
    const api = window.electronAPI;
    if (!api?.saveConfig) return;
    setLanSaving(true);
    setLanError(false);
    try {
      const res = await api.saveConfig({ exposeToLan: next });
      if (res?.success) setExposeToLan(next);
      else setLanError(true);
    } catch {
      setLanError(true);
    } finally {
      setLanSaving(false);
    }
  }

  return (
    <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
      <Link href="/settings" className="text-blue-600 hover:underline text-sm">{t("settings.back")}</Link>
      <h1 className="text-3xl font-bold mb-2 mt-2">{t("settings.group.network")}</h1>
      <p className="text-gray-500 text-sm mb-8">{t("settings.group.network.desc")}</p>

      {!isElectron ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5 text-sm text-gray-500">
          {t("settings.network.desktopOnly")}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Connection Mode */}
          {currentMode && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-200 mb-1">{t("settings.connectionMode")}</h2>
              <p className="text-sm text-gray-500 mb-4">{t("settings.connectionModeDesc")}</p>

              <div className="space-y-2">
                {CONNECTION_MODES.map((m) => {
                  const isActive = currentMode === m.id;
                  const isPending = pendingMode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={modeSwitching}
                      onClick={() => {
                        if (isActive) return;
                        setModeResult(null);
                        if (m.needsUri && !hasStoredUri) {
                          setPendingMode(m.id);
                          setShowUriInput(true);
                        } else {
                          setPendingMode(m.id);
                          setShowUriInput(false);
                        }
                      }}
                      className={`w-full text-left p-3 rounded-lg border transition-colors ${
                        isActive
                          ? "border-blue-500 bg-blue-600/10"
                          : isPending
                            ? "border-yellow-500 bg-yellow-500/5"
                            : "border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500"
                      } ${modeSwitching ? "opacity-50 cursor-not-allowed" : ""}`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xl">{m.icon}</span>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-medium ${isActive ? "text-blue-600 dark:text-blue-400" : "text-gray-700 dark:text-gray-200"}`}>
                              {m.label}
                            </span>
                            {isActive && (
                              <span className="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-600/30 text-blue-600 dark:text-blue-300 rounded">{t("settings.connectionCurrent")}</span>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">{m.description}</p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {showUriInput && pendingMode && (
                <div className="mt-3 p-4 border border-gray-300 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900/50">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t("settings.atlasConnectionString")}</label>
                  <input
                    type="password"
                    value={atlasUri}
                    onChange={(e) => setAtlasUri(e.target.value)}
                    placeholder="mongodb+srv://user:pass@cluster.mongodb.net/filament-db"
                    className="w-full px-3 py-2 bg-transparent border border-gray-300 dark:border-gray-700 rounded text-sm text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-600 mb-2"
                    autoFocus
                  />
                  <p className="text-xs text-gray-500 mb-3">{t("settings.connectionStringPrivacy")}</p>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        if (!atlasUri.trim()) return;
                        setTestingConnection(true);
                        setModeResult(null);
                        try {
                          const result = await window.electronAPI!.testConnection(atlasUri.trim());
                          if (!result.success) {
                            setModeResult({ ok: false, message: result.error || t("settings.connectionFailed") });
                            setTestingConnection(false);
                            return;
                          }
                          setModeSwitching(true);
                          await window.electronAPI!.saveConfig({ connectionMode: pendingMode, atlasUri: atlasUri.trim() });
                          setCurrentMode(pendingMode);
                          setHasStoredUri(true);
                          setPendingMode("");
                          setShowUriInput(false);
                          setAtlasUri("");
                          setModeResult({ ok: true, message: t("settings.switchedTo", { mode: CONNECTION_MODES.find((m) => m.id === pendingMode)?.label || "" }) });
                        } catch (err) {
                          setModeResult({ ok: false, message: err instanceof Error ? err.message : t("settings.switchFailed") });
                        } finally {
                          setTestingConnection(false);
                          setModeSwitching(false);
                        }
                      }}
                      disabled={testingConnection || !atlasUri.trim()}
                      className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      {testingConnection ? t("settings.testing") : t("settings.connectAndSwitch")}
                    </button>
                    <button
                      onClick={() => { setPendingMode(""); setShowUriInput(false); setAtlasUri(""); setModeResult(null); }}
                      className="px-3 py-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 text-sm transition-colors"
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              )}

              {pendingMode && !showUriInput && (
                <div className="mt-3 flex items-center gap-3">
                  <button
                    onClick={async () => {
                      setModeSwitching(true);
                      setModeResult(null);
                      try {
                        await window.electronAPI!.saveConfig({ connectionMode: pendingMode });
                        setCurrentMode(pendingMode);
                        setPendingMode("");
                        setModeResult({ ok: true, message: t("settings.switchedTo", { mode: CONNECTION_MODES.find((m) => m.id === pendingMode)?.label || "" }) });
                      } catch (err) {
                        setModeResult({ ok: false, message: err instanceof Error ? err.message : t("settings.switchFailed") });
                      } finally {
                        setModeSwitching(false);
                      }
                    }}
                    disabled={modeSwitching}
                    className="px-4 py-1.5 bg-yellow-600 text-white rounded text-sm hover:bg-yellow-500 disabled:opacity-50 transition-colors"
                  >
                    {modeSwitching ? t("settings.switching") : t("settings.switchTo", { mode: CONNECTION_MODES.find((m) => m.id === pendingMode)?.label || "" })}
                  </button>
                  <button
                    onClick={() => { setPendingMode(""); setModeResult(null); }}
                    className="px-3 py-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 text-sm transition-colors"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              )}

              {modeResult && (
                <div className={`mt-3 text-sm px-3 py-2 rounded ${
                  modeResult.ok
                    ? "bg-green-50 dark:bg-green-900/50 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800"
                    : "bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
                }`}>
                  {modeResult.message}
                </div>
              )}
            </div>
          )}

          {/* Share on local network */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-1">{t("settings.lanShare.title")}</h2>
            <p className="text-sm text-gray-500 mb-4">{t("settings.lanShare.desc")}</p>

            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                role="switch"
                aria-checked={exposeToLan}
                disabled={lanSaving}
                onClick={() => toggleLanShare(!exposeToLan)}
                className={`px-4 py-2 text-sm rounded border transition-colors disabled:opacity-50 ${
                  exposeToLan
                    ? "border-green-500 bg-green-50 dark:bg-green-600/20 text-green-700 dark:text-green-300"
                    : "border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-300"
                }`}
              >
                {lanSaving ? t("settings.lanShare.applying") : exposeToLan ? t("settings.lanShare.on") : t("settings.lanShare.off")}
              </button>
              {exposeToLan && !lanSaving && (
                <span className="text-sm text-green-700 dark:text-green-300">{t("settings.lanShare.activeHint")}</span>
              )}
            </div>

            {lanError && (
              <div className="mt-3 text-sm px-3 py-2 rounded bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
                {t("settings.lanShare.error")}
              </div>
            )}

            {exposeToLan && (
              <div className="mt-4">
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">{t("settings.lanShare.autoDiscover")}</p>
                {lanInfo && lanInfo.ips.length > 0 ? (
                  <>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">{t("settings.lanShare.connectAt")}</p>
                    <ul className="space-y-1">
                      {lanInfo.ips.map((ip) => (
                        <li key={ip}>
                          <code className="text-sm px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded font-mono text-gray-800 dark:text-gray-200">
                            http://{ip}:{lanInfo.port}
                          </code>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-sm text-amber-600 dark:text-amber-400">{t("settings.lanShare.noIp")}</p>
                )}
              </div>
            )}

            <div className="mt-4 text-xs text-amber-700 dark:text-amber-300/90 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/60 rounded px-3 py-2">
              {t("settings.lanShare.warning")}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

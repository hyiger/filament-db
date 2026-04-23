"use client";

import { useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useIsElectron } from "@/hooks/useIsElectron";

type ConnectionMode = "atlas" | "offline" | "hybrid" | "";

export default function SetupPage() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ConnectionMode>("");
  const [mongoUri, setMongoUri] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const isElectron = useIsElectron();
  const [showUri, setShowUri] = useState(false);

  const handleAtlasConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setTesting(true);
    setError("");
    setSuccess("");

    try {
      if (window.electronAPI?.testConnection) {
        // Electron: test via IPC (main process has full MongoDB driver)
        const result = await window.electronAPI.testConnection(mongoUri);
        if (!result.success) {
          setError(result.error || t("setup.connectionFailed"));
          setTesting(false);
          return;
        }

        await window.electronAPI.saveConfig({
          connectionMode: mode === "hybrid" ? "hybrid" : "atlas",
          atlasUri: mongoUri,
        });
        // Electron will redirect to home
      } else {
        // Web app: test via API route
        const res = await fetch("/api/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mongodbUri: mongoUri }),
        });

        let data;
        try {
          data = await res.json();
        } catch {
          setError(t("setup.serverError"));
          setTesting(false);
          return;
        }

        if (!res.ok) {
          setError(data.error || t("setup.connectionFailed"));
          setTesting(false);
          return;
        }

        setSuccess(t("setup.webConnectionSuccess"));
        setTesting(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.connectionFailed"));
    } finally {
      setTesting(false);
    }
  };

  const handleOfflineSetup = async () => {
    if (!window.electronAPI) {
      setError(t("setup.offlineDesktopOnly"));
      return;
    }

    setTesting(true);
    setError("");

    try {
      await window.electronAPI.saveConfig({
        connectionMode: "offline",
      });
      // Electron will redirect to home
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.setupFailed"));
    } finally {
      setTesting(false);
    }
  };

  // Mode not yet selected — show options
  if (!mode) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-lg w-full">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold mb-2">{t("setup.title")}</h1>
            <p className="text-gray-500">
              {t("setup.subtitle")}
            </p>
          </div>

          <div className="space-y-3">
            {/* Atlas (Cloud) */}
            <button
              onClick={() => setMode("atlas")}
              className="w-full text-left p-4 border border-gray-600 rounded-lg hover:border-blue-500 hover:bg-blue-500/5 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="text-2xl mt-0.5">&#9729;</div>
                <div>
                  <div className="font-semibold text-gray-900 dark:text-white">{t("setup.atlasTitle")}</div>
                  <p className="text-sm text-gray-400 mt-1">
                    {t("setup.atlasDesc")}
                  </p>
                </div>
              </div>
            </button>

            {/* Hybrid */}
            {isElectron && (
              <button
                onClick={() => setMode("hybrid")}
                className="w-full text-left p-4 border border-gray-600 rounded-lg hover:border-purple-500 hover:bg-purple-500/5 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="text-2xl mt-0.5">&#8644;</div>
                  <div>
                    <div className="font-semibold text-gray-900 dark:text-white">{t("setup.hybridTitle")}</div>
                    <p className="text-sm text-gray-400 mt-1">
                      {t("setup.hybridDesc")} <span className="text-gray-500">{t("setup.recommended")}</span>
                    </p>
                  </div>
                </div>
              </button>
            )}

            {/* Offline Only */}
            {isElectron && (
              <button
                onClick={() => setMode("offline")}
                className="w-full text-left p-4 border border-gray-600 rounded-lg hover:border-green-500 hover:bg-green-500/5 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="text-2xl mt-0.5">&#128190;</div>
                  <div>
                    <div className="font-semibold text-gray-900 dark:text-white">{t("setup.offlineTitle")}</div>
                    <p className="text-sm text-gray-400 mt-1">
                      {t("setup.offlineDesc")}
                    </p>
                  </div>
                </div>
              </button>
            )}
          </div>

          {!isElectron && (
            <p className="text-xs text-gray-500 mt-6 text-center">
              {t("setup.desktopOnlyModes")}{" "}
              <a href="https://github.com/hyiger/filament-db/releases" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">
                {t("setup.desktopApp")}
              </a>.
            </p>
          )}
        </div>
      </main>
    );
  }

  // Offline mode — confirm and go
  if (mode === "offline") {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold mb-2">{t("setup.title")}</h1>
            <p className="text-gray-500">{t("setup.offlineModeTitle")}</p>
          </div>

          <div className="p-4 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg mb-6">
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
              {t("setup.offlineExplanation")}
            </p>
            <p className="text-xs text-gray-500">
              {t("setup.offlineSwitchLater")}
            </p>
          </div>

          {error && (
            <div className="p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-300 mb-4">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setMode("")}
              className="flex-1 px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
            >
              {t("common.back")}
            </button>
            <button
              onClick={handleOfflineSetup}
              disabled={testing}
              className="flex-1 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-500 disabled:opacity-50 text-sm"
            >
              {testing ? t("setup.settingUp") : t("setup.startOffline")}
            </button>
          </div>
        </div>
      </main>
    );
  }

  // Atlas or Hybrid mode — need connection string
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">{t("setup.title")}</h1>
          <p className="text-gray-500">
            {mode === "hybrid"
              ? t("setup.hybridPrompt")
              : t("setup.atlasPrompt")}
          </p>
        </div>

        {mode === "hybrid" && (
          <div className="p-3 bg-purple-900/20 border border-purple-800 rounded-lg mb-4 text-xs text-purple-300">
            <strong>{t("setup.hybridModeLabel")}</strong> {t("setup.hybridModeExplanation")}
          </div>
        )}

        <form onSubmit={handleAtlasConnect} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              {t("setup.mongoConnectionString")}
            </label>
            <div className="relative">
              <input
                type={showUri ? "text" : "password"}
                className="w-full px-3 py-2 pr-10 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent text-gray-900 dark:text-gray-100"
                value={mongoUri}
                onChange={(e) => setMongoUri(e.target.value)}
                placeholder="mongodb+srv://user:pass@cluster.mongodb.net/filament-db"
                required
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowUri(!showUri)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                tabIndex={-1}
              >
                {showUri ? (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {t("setup.connectionStringPrivacy")}
            </p>
          </div>

          {error && (
            <div className="p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {success && (
            <div className="p-3 bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-800 rounded text-sm text-green-700 dark:text-green-300">
              {success}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setMode(""); setError(""); setSuccess(""); }}
              className="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded hover:border-gray-500"
            >
              {t("common.back")}
            </button>
            <button
              type="submit"
              disabled={testing || !mongoUri}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
            >
              {testing ? t("setup.testingConnection") : t("setup.connect")}
            </button>
          </div>
        </form>

        <div className="mt-8 text-xs text-gray-500 space-y-2">
          <p>
            <strong>{t("setup.needAccount")}</strong> {t("setup.signUpAt")}{" "}
            <a
              href="https://www.mongodb.com/cloud/atlas/register"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              mongodb.com/atlas
            </a>
          </p>
          <p>
            {t("setup.connectionStringExample")}{" "}
            <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">
              mongodb+srv://user:password@cluster.mongodb.net/filament-db
            </code>
          </p>
        </div>
      </div>
    </main>
  );
}

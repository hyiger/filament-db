"use client";

import Link from "next/link";
import { useRef, useState, useEffect } from "react";

export default function SettingsPage() {
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ ok: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete database state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<{ ok: boolean; message: string } | null>(null);

  // AI provider state
  type AiProvider = "gemini" | "claude" | "openai";
  const AI_PROVIDERS: { id: AiProvider; name: string; keyUrl: string }[] = [
    { id: "gemini", name: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey" },
    { id: "claude", name: "Anthropic Claude", keyUrl: "https://console.anthropic.com/settings/keys" },
    { id: "openai", name: "OpenAI ChatGPT", keyUrl: "https://platform.openai.com/api-keys" },
  ];
  const [aiProvider, setAiProvider] = useState<AiProvider>("gemini");
  const [aiKey, setAiKey] = useState("");
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiResult, setAiResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showAiKey, setShowAiKey] = useState(false);

  // NFC state (Electron only)
  const [isElectron, setIsElectron] = useState(false);
  const [nfcStatus, setNfcStatus] = useState<{
    readerConnected: boolean;
    readerName: string | null;
    tagPresent: boolean;
    tagUid: string | null;
  }>({ readerConnected: false, readerName: null, tagPresent: false, tagUid: null });
  const [formatting, setFormatting] = useState(false);
  const [formatResult, setFormatResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showFormatConfirm, setShowFormatConfirm] = useState(false);

  // Load AI config status
  useEffect(() => {
    const api = window.electronAPI;
    if (api?.getConfig) {
      // Electron mode — check electron-store
      api.getConfig().then((cfg) => {
        if (cfg.aiApiKey || cfg.geminiApiKey) {
          setAiConfigured(true);
        }
        if (cfg.aiProvider) {
          setAiProvider(cfg.aiProvider as AiProvider);
        }
      }).catch(() => {});
    } else {
      // Web mode — check API
      fetch("/api/tds").then((r) => r.json()).then((d) => {
        setAiConfigured(d.configured);
        if (d.provider) setAiProvider(d.provider);
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.nfcGetStatus) return;
    setIsElectron(true);
    api.nfcGetStatus().then(setNfcStatus).catch(() => {});
    const unsub = api.onNfcStatusChange(setNfcStatus);
    return () => { unsub(); };
  }, []);

  // Auto-dismiss erase confirmation when tag is removed
  useEffect(() => {
    if (!nfcStatus.tagPresent && showFormatConfirm) {
      setShowFormatConfirm(false);
    }
  }, [nfcStatus.tagPresent, showFormatConfirm]);

  const handleFormat = async () => {
    setShowFormatConfirm(false);
    setFormatting(true);
    setFormatResult(null);
    try {
      if (!window.electronAPI?.nfcFormatTag) {
        throw new Error("NFC format not available — restart the app to load updated NFC support");
      }
      await window.electronAPI.nfcFormatTag();
      setFormatResult({ ok: true, message: "Tag erased successfully" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setFormatResult({ ok: false, message });
    } finally {
      setFormatting(false);
    }
  };

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset file input so the same file can be re-selected
    e.target.value = "";

    if (!confirm(
      "This will replace ALL data in the database with the snapshot contents.\n\n" +
      "All current filaments, nozzles, and printers will be deleted.\n\n" +
      "Are you sure?"
    )) return;

    setRestoring(true);
    setRestoreResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/snapshot", { method: "POST", body: formData });
      const data = await res.json();

      if (res.ok) {
        setRestoreResult({
          ok: true,
          message: `Restored ${data.restored.filaments} filaments, ${data.restored.nozzles} nozzles, ${data.restored.printers} printers`,
        });
      } else {
        setRestoreResult({ ok: false, message: data.error || "Restore failed" });
      }
    } catch {
      setRestoreResult({ ok: false, message: "Failed to connect to server" });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; Back to Filaments
        </Link>
      </div>

      <h1 className="text-3xl font-bold mb-2">Settings</h1>
      <p className="text-gray-500 text-sm mb-8">
        Manage your printers, nozzles, and other configuration.
      </p>

      <div className="grid gap-4">
        <Link
          href="/nozzles"
          className="block p-5 rounded-lg border border-gray-700 hover:border-gray-500 hover:bg-gray-900/50 transition-colors group"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-200 group-hover:text-white">
                Nozzles
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Manage nozzle sizes available for your printers.
              </p>
            </div>
            <svg className="w-5 h-5 text-gray-600 group-hover:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </div>
        </Link>

        <Link
          href="/printers"
          className="block p-5 rounded-lg border border-gray-700 hover:border-gray-500 hover:bg-gray-900/50 transition-colors group"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-200 group-hover:text-white">
                Printers
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Manage your 3D printers and their installed nozzles.
              </p>
            </div>
            <svg className="w-5 h-5 text-gray-600 group-hover:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </div>
        </Link>

        <Link
          href="/api-docs"
          className="block p-5 rounded-lg border border-gray-700 hover:border-gray-500 hover:bg-gray-900/50 transition-colors group"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-200 group-hover:text-white">
                API Documentation
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Interactive API reference for all REST endpoints.
              </p>
            </div>
            <svg className="w-5 h-5 text-gray-600 group-hover:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </div>
        </Link>
      </div>

      {/* Database Snapshots */}
      <div className="mt-8 pt-6 border-t border-gray-800">
        <h2 className="text-lg font-semibold text-gray-200 mb-1">Database Snapshots</h2>
        <p className="text-sm text-gray-500 mb-4">
          Download a full backup of all filaments, nozzles, and printers, or restore from a previous snapshot.
        </p>

        <div className="flex gap-3 items-center flex-wrap">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/api/snapshot"
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 transition-colors inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Download Snapshot
          </a>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleRestore}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={restoring}
            className="px-4 py-2 bg-gray-700 text-white rounded text-sm hover:bg-gray-600 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
            </svg>
            {restoring ? "Restoring..." : "Restore from Snapshot"}
          </button>
        </div>

        {restoreResult && (
          <div className={`mt-3 text-sm px-3 py-2 rounded ${
            restoreResult.ok
              ? "bg-green-900/50 text-green-300 border border-green-800"
              : "bg-red-900/50 text-red-300 border border-red-800"
          }`}>
            {restoreResult.message}
          </div>
        )}
      </div>

      {/* AI Features — Provider & API Key */}
      <div className="mt-8 pt-6 border-t border-gray-800">
        <h2 className="text-lg font-semibold text-gray-200 mb-1">AI Features</h2>
        <p className="text-sm text-gray-500 mb-4">
          Configure an AI provider to enable extraction of filament properties from Technical Data Sheets (TDS).
          Get a free API key from your chosen provider.
        </p>

        <div className="flex items-center gap-2 mb-4">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${aiConfigured ? "bg-green-500" : "bg-gray-600"}`} />
          <span className="text-sm text-gray-400">
            {aiConfigured
              ? `${AI_PROVIDERS.find((p) => p.id === aiProvider)?.name || aiProvider} configured`
              : "No API key configured"}
          </span>
        </div>

        {/* Provider selector */}
        <div className="mb-3">
          <label className="text-xs text-gray-500 block mb-1.5 font-medium uppercase tracking-wider">Provider</label>
          <div className="flex gap-2">
            {AI_PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { setAiProvider(p.id); setAiResult(null); }}
                className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                  aiProvider === p.id
                    ? "border-blue-500 bg-blue-600/20 text-blue-300"
                    : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-300"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        {/* API key link */}
        <p className="text-xs text-gray-500 mb-2">
          Get a key from{" "}
          <a
            href={AI_PROVIDERS.find((p) => p.id === aiProvider)?.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline"
          >
            {AI_PROVIDERS.find((p) => p.id === aiProvider)?.name}
          </a>
        </p>

        <div className="flex gap-2 items-center flex-wrap">
          <div className="relative flex-1 max-w-sm">
            <input
              type={showAiKey ? "text" : "password"}
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              placeholder={aiConfigured ? "••••••••••••••••" : "Enter API key"}
              className="w-full px-3 py-2 bg-transparent border border-gray-700 rounded text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600"
            />
            <button
              type="button"
              onClick={() => setShowAiKey((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs"
            >
              {showAiKey ? "Hide" : "Show"}
            </button>
          </div>

          <button
            onClick={async () => {
              if (!aiKey.trim()) return;
              setAiSaving(true);
              setAiResult(null);
              try {
                const api = window.electronAPI;
                if (api?.saveConfig) {
                  // Electron mode
                  await api.saveConfig({ aiApiKey: aiKey.trim(), aiProvider });
                  setAiConfigured(true);
                  setAiKey("");
                  setAiResult({ ok: true, message: `${AI_PROVIDERS.find((p) => p.id === aiProvider)?.name} API key saved` });
                } else {
                  // Web mode — validate via API
                  const res = await fetch("/api/tds", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ apiKey: aiKey.trim(), provider: aiProvider }),
                  });
                  const data = await res.json();
                  if (res.ok) {
                    setAiConfigured(true);
                    setAiKey("");
                    setAiResult({ ok: true, message: `${AI_PROVIDERS.find((p) => p.id === aiProvider)?.name} API key saved and validated` });
                  } else {
                    setAiResult({ ok: false, message: data.error || "Failed to save key" });
                  }
                }
              } catch {
                setAiResult({ ok: false, message: "Failed to save API key" });
              } finally {
                setAiSaving(false);
              }
            }}
            disabled={aiSaving || !aiKey.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {aiSaving ? "Validating..." : "Save Key"}
          </button>

          {aiConfigured && (
            <button
              onClick={async () => {
                const api = window.electronAPI;
                if (api?.saveConfig) {
                  await api.saveConfig({ aiApiKey: "", aiProvider: "gemini" });
                } else {
                  await fetch("/api/tds", { method: "DELETE" });
                }
                setAiConfigured(false);
                setAiResult({ ok: true, message: "API key removed" });
              }}
              className="px-4 py-2 bg-gray-700 text-white rounded text-sm hover:bg-gray-600 transition-colors"
            >
              Remove Key
            </button>
          )}
        </div>

        {aiResult && (
          <div className={`mt-3 text-sm px-3 py-2 rounded ${
            aiResult.ok
              ? "bg-green-900/50 text-green-300 border border-green-800"
              : "bg-red-900/50 text-red-300 border border-red-800"
          }`}>
            {aiResult.message}
          </div>
        )}
      </div>

      {/* NFC Tools (Electron only) */}
      {isElectron && (
        <div className="mt-8 pt-6 border-t border-gray-800">
          <h2 className="text-lg font-semibold text-gray-200 mb-1">NFC Tools</h2>
          <p className="text-sm text-gray-500 mb-4">
            Format or erase NFC tags. Place a tag on the reader before using these tools.
          </p>

          <div className="flex items-center gap-3 mb-4">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${
              nfcStatus.tagPresent
                ? "bg-green-500"
                : nfcStatus.readerConnected
                  ? "bg-yellow-500"
                  : "bg-gray-600"
            }`} />
            <span className="text-sm text-gray-400">
              {nfcStatus.tagPresent
                ? `Tag detected${nfcStatus.tagUid ? ` (${nfcStatus.tagUid.slice(-8).toUpperCase()})` : ""}`
                : nfcStatus.readerConnected
                  ? "Reader ready — place a tag"
                  : "No NFC reader connected"}
            </span>
          </div>

          {!showFormatConfirm ? (
            <button
              onClick={() => { setShowFormatConfirm(true); setFormatResult(null); }}
              disabled={formatting || !nfcStatus.tagPresent}
              className="px-4 py-2 bg-gray-700 text-white rounded text-sm hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75 14.25 12m0 0 2.25 2.25M14.25 12l2.25-2.25M14.25 12 12 14.25m-2.58 4.92-6.374-6.375a1.125 1.125 0 0 1 0-1.59L9.42 4.83a1.125 1.125 0 0 1 1.59 0l6.375 6.375a1.125 1.125 0 0 1 0 1.59l-6.375 6.375a1.125 1.125 0 0 1-1.59 0Z" />
              </svg>
              Erase Tag
            </button>
          ) : (
            <div className="p-4 border border-yellow-800 rounded-lg bg-yellow-950/30">
              <p className="text-sm text-yellow-300 mb-3">
                This will erase ALL data on the NFC tag. Are you sure?
              </p>
              <div className="flex gap-2 items-center">
                <button
                  onClick={handleFormat}
                  disabled={formatting}
                  className="px-4 py-1.5 bg-yellow-700 text-white rounded text-sm hover:bg-yellow-600 disabled:opacity-50 transition-colors"
                >
                  {formatting ? "Erasing..." : "Confirm Erase"}
                </button>
                <button
                  onClick={() => setShowFormatConfirm(false)}
                  className="px-3 py-1.5 text-gray-400 hover:text-gray-200 text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {formatResult && (
            <div className={`mt-3 text-sm px-3 py-2 rounded ${
              formatResult.ok
                ? "bg-green-900/50 text-green-300 border border-green-800"
                : "bg-red-900/50 text-red-300 border border-red-800"
            }`}>
              {formatResult.message}
            </div>
          )}
        </div>
      )}

      {/* Danger Zone */}
      <div className="mt-8 pt-6 border-t border-red-900/50">
        <h2 className="text-lg font-semibold text-red-400 mb-1">Danger Zone</h2>
        <p className="text-sm text-gray-500 mb-4">
          Permanently delete all filaments, nozzles, and printers. This cannot be undone.
        </p>

        {!showDeleteConfirm ? (
          <button
            onClick={() => { setShowDeleteConfirm(true); setDeleteResult(null); }}
            className="px-4 py-2 bg-red-900/50 text-red-400 border border-red-800 rounded text-sm hover:bg-red-900 hover:text-red-300 transition-colors inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
            Delete Database
          </button>
        ) : (
          <div className="p-4 border border-red-800 rounded-lg bg-red-950/30">
            <p className="text-sm text-red-300 mb-3">
              Type <span className="font-mono font-bold">delete</span> to confirm:
            </p>
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={deleteInput}
                onChange={(e) => setDeleteInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setShowDeleteConfirm(false);
                    setDeleteInput("");
                  }
                }}
                placeholder="type delete"
                className="w-40 px-3 py-1.5 border border-red-800 rounded text-sm bg-transparent text-red-200 placeholder-red-800 focus:outline-none focus:border-red-600"
                autoFocus
              />
              <button
                onClick={async () => {
                  setDeleting(true);
                  setDeleteResult(null);
                  try {
                    const res = await fetch("/api/snapshot/delete", { method: "DELETE" });
                    const data = await res.json();
                    if (res.ok) {
                      setDeleteResult({
                        ok: true,
                        message: `Deleted ${data.deleted.filaments} filaments, ${data.deleted.nozzles} nozzles, ${data.deleted.printers} printers`,
                      });
                    } else {
                      setDeleteResult({ ok: false, message: data.error || "Delete failed" });
                    }
                  } catch {
                    setDeleteResult({ ok: false, message: "Failed to connect to server" });
                  } finally {
                    setDeleting(false);
                    setShowDeleteConfirm(false);
                    setDeleteInput("");
                  }
                }}
                disabled={deleteInput !== "delete" || deleting}
                className="px-4 py-1.5 bg-red-700 text-white rounded text-sm hover:bg-red-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                {deleting ? "Deleting..." : "Confirm Delete"}
              </button>
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteInput(""); }}
                className="px-3 py-1.5 text-gray-400 hover:text-gray-200 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {deleteResult && (
          <div className={`mt-3 text-sm px-3 py-2 rounded ${
            deleteResult.ok
              ? "bg-green-900/50 text-green-300 border border-green-800"
              : "bg-red-900/50 text-red-300 border border-red-800"
          }`}>
            {deleteResult.message}
          </div>
        )}
      </div>

      <div className="mt-8 pt-6 border-t border-gray-800">
        <p className="text-xs text-gray-600">
          Filament DB v{process.env.APP_VERSION}
        </p>
      </div>
    </main>
  );
}

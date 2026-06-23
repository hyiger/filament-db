"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

type AiProvider = "gemini" | "claude" | "openai";

const AI_PROVIDERS: { id: AiProvider; name: string; keyUrl: string }[] = [
  { id: "gemini", name: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "claude", name: "Anthropic Claude", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI ChatGPT", keyUrl: "https://platform.openai.com/api-keys" },
];

export default function AiSettingsPage() {
  const { t } = useTranslation();
  const [aiProvider, setAiProvider] = useState<AiProvider>("gemini");
  const [aiKey, setAiKey] = useState("");
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiResult, setAiResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showAiKey, setShowAiKey] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const api = window.electronAPI;
    if (api?.getConfig) {
      api.getConfig().then((cfg) => {
        if (controller.signal.aborted) return;
        if (cfg.aiApiKey || cfg.geminiApiKey) setAiConfigured(true);
        if (cfg.aiProvider) setAiProvider(cfg.aiProvider as AiProvider);
      }).catch(() => {});
    } else {
      fetch("/api/tds", { signal: controller.signal }).then((r) => r.json()).then((d) => {
        setAiConfigured(d.configured);
        if (d.provider) setAiProvider(d.provider);
      }).catch(() => {});
    }
    return () => { controller.abort(); };
  }, []);

  return (
    <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
      <Link href="/settings" className="text-blue-600 hover:underline text-sm">{t("settings.back")}</Link>
      <h1 className="text-3xl font-bold mb-2 mt-2">{t("settings.group.ai")}</h1>
      <p className="text-gray-500 text-sm mb-8">{t("settings.group.ai.desc")}</p>

      <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-1">{t("settings.aiFeatures")}</h2>
        <p className="text-sm text-gray-500 mb-4">{t("settings.aiFeaturesDesc")}</p>

        <div className="flex items-center gap-2 mb-4">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${aiConfigured ? "bg-green-500" : "bg-gray-600"}`} />
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {aiConfigured
              ? t("settings.aiConfigured", { provider: AI_PROVIDERS.find((p) => p.id === aiProvider)?.name || aiProvider })
              : t("settings.aiNotConfigured")}
          </span>
        </div>

        {/* Provider selector */}
        <div className="mb-3">
          <label className="text-xs text-gray-500 block mb-1.5 font-medium uppercase tracking-wider">{t("settings.aiProvider")}</label>
          <div className="flex gap-2">
            {AI_PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { setAiProvider(p.id); setAiResult(null); }}
                className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                  aiProvider === p.id
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-300"
                    : "border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        {/* Cost info note */}
        <div className="mb-3 text-xs px-3 py-2 rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
          {aiProvider === "gemini"
            ? t("settings.aiCostNote.gemini")
            : t("settings.aiCostNote.paid", { provider: AI_PROVIDERS.find((p) => p.id === aiProvider)?.name || aiProvider })}
        </div>

        {/* API key link */}
        <p className="text-xs text-gray-500 mb-2">
          {t("settings.getKeyFrom")}{" "}
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
              placeholder={aiConfigured ? "••••••••••••••••" : t("settings.enterApiKey")}
              className="w-full px-3 py-2 bg-transparent border border-gray-300 dark:border-gray-700 rounded text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-600"
            />
            <button
              type="button"
              onClick={() => setShowAiKey((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xs"
            >
              {showAiKey ? t("common.hide") : t("common.show")}
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
                  await api.saveConfig({ aiApiKey: aiKey.trim(), aiProvider });
                  setAiConfigured(true);
                  setAiKey("");
                  setAiResult({ ok: true, message: t("settings.aiKeySaved", { provider: AI_PROVIDERS.find((p) => p.id === aiProvider)?.name || aiProvider }) });
                } else {
                  const res = await fetch("/api/tds", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ apiKey: aiKey.trim(), provider: aiProvider }),
                  });
                  const data = await res.json();
                  if (res.ok) {
                    setAiConfigured(true);
                    setAiKey("");
                    setAiResult({ ok: true, message: t("settings.aiKeySavedValidated", { provider: AI_PROVIDERS.find((p) => p.id === aiProvider)?.name || aiProvider }) });
                  } else {
                    setAiResult({ ok: false, message: data.error || t("settings.aiKeySaveFailed") });
                  }
                }
              } catch {
                setAiResult({ ok: false, message: t("settings.aiKeySaveFailed") });
              } finally {
                setAiSaving(false);
              }
            }}
            disabled={aiSaving || !aiKey.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {aiSaving ? t("settings.validating") : t("settings.saveKey")}
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
                setAiProvider("gemini");
                setAiResult({ ok: true, message: t("settings.aiKeyRemoved") });
              }}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              {t("settings.removeKey")}
            </button>
          )}
        </div>

        {aiResult && (
          <div className={`mt-3 text-sm px-3 py-2 rounded ${
            aiResult.ok
              ? "bg-green-50 dark:bg-green-900/50 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800"
              : "bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800"
          }`}>
            {aiResult.message}
          </div>
        )}
      </div>
    </main>
  );
}

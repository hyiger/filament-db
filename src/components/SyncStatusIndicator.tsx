"use client";

import { useEffect, useState, useCallback } from "react";

interface SyncStatus {
  state: "idle" | "syncing" | "error" | "offline";
  lastSyncAt: string | null;
  error: string | null;
  progress: string | null;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function SyncStatusIndicator() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [mode, setMode] = useState<string>("");
  const [isFallback, setIsFallback] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getSyncStatus) return;

    api.getConfig().then((config) => {
      setMode(config.connectionMode);
    });

    api.getSyncStatus().then(setStatus);

    const unsub1 = api.onSyncStatusChange(setStatus);
    const unsub2 = api.onConnectionModeFallback(() => {
      setIsFallback(true);
    });

    return () => {
      unsub1();
      unsub2();
    };
  }, []);

  const handleSync = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    await api.triggerSync();
  }, []);

  // Only show for hybrid mode or atlas-with-fallback
  if (!mode || (mode === "atlas" && !isFallback) || mode === "offline") {
    // For offline mode, show a small indicator
    if (mode === "offline") {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs bg-gray-700 text-gray-300">
          <span className="w-2 h-2 rounded-full bg-gray-500" />
          Local
        </span>
      );
    }
    return null;
  }

  if (!status) return null;

  const pill = (() => {
    if (isFallback) {
      return {
        bg: "bg-amber-900/50",
        dot: "bg-amber-500",
        text: "text-amber-300",
        label: "Offline (Atlas unreachable)",
      };
    }
    switch (status.state) {
      case "syncing":
        return {
          bg: "bg-blue-900/50",
          dot: "bg-blue-400 animate-pulse",
          text: "text-blue-300",
          label: status.progress || "Syncing...",
        };
      case "error":
        return {
          bg: "bg-red-900/50",
          dot: "bg-red-500",
          text: "text-red-300",
          label: "Sync error",
        };
      case "idle":
        return {
          bg: "bg-green-900/50",
          dot: "bg-green-500",
          text: "text-green-300",
          label: status.lastSyncAt
            ? `Synced ${formatRelativeTime(status.lastSyncAt)}`
            : "Hybrid",
        };
      default:
        return {
          bg: "bg-gray-700",
          dot: "bg-gray-500",
          text: "text-gray-300",
          label: "Hybrid",
        };
    }
  })();

  return (
    <div className="relative inline-flex">
      <button
        onClick={() => setShowTooltip(!showTooltip)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs ${pill.bg} ${pill.text} hover:opacity-80`}
      >
        <span className={`w-2 h-2 rounded-full ${pill.dot}`} />
        {pill.label}
      </button>

      {showTooltip && (
        <div className="absolute top-full right-0 mt-1 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-3 z-50 text-xs">
          <div className="text-gray-300 mb-2">
            <strong>Mode:</strong> {mode === "hybrid" ? "Hybrid (Local + Cloud)" : "Atlas with local fallback"}
          </div>
          {status.lastSyncAt && (
            <div className="text-gray-400 mb-2">
              <strong>Last sync:</strong> {new Date(status.lastSyncAt).toLocaleString()}
            </div>
          )}
          {status.error && (
            <div className="text-red-400 mb-2">
              <strong>Error:</strong> {status.error}
            </div>
          )}
          <button
            onClick={handleSync}
            disabled={status.state === "syncing"}
            className="w-full px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50 mt-1"
          >
            {status.state === "syncing" ? "Syncing..." : "Sync Now"}
          </button>
        </div>
      )}
    </div>
  );
}

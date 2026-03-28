"use client";

import { useEffect, useState, useCallback, useRef } from "react";

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
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Browser online/offline detection
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Close tooltip on outside click
  useEffect(() => {
    if (!showTooltip) return;
    const handleClick = (e: MouseEvent) => {
      if (
        tooltipRef.current && !tooltipRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setShowTooltip(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showTooltip]);

  // Electron sync status
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

  // Periodically refresh the "Synced Xm ago" label
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const handleSync = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    await api.triggerSync();
  }, []);

  const isElectron = typeof window !== "undefined" && !!window.electronAPI;

  // ── Determine what to display ──

  // Non-Electron (web app): show simple online/offline pill
  if (!isElectron) {
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${
        online
          ? "bg-green-900/40 text-green-400"
          : "bg-red-900/40 text-red-400"
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-green-500" : "bg-red-500"}`} />
        {online ? "Connected" : "Offline"}
      </span>
    );
  }

  // Electron: offline mode
  if (mode === "offline") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-gray-700 text-gray-300">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
        Local
      </span>
    );
  }

  // Electron: atlas mode (no fallback active) — show connectivity
  if (mode === "atlas" && !isFallback) {
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${
        online
          ? "bg-green-900/40 text-green-400"
          : "bg-amber-900/40 text-amber-400"
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-green-500" : "bg-amber-500"}`} />
        {online ? "Connected" : "No Connection"}
      </span>
    );
  }

  // Electron: hybrid or atlas-with-fallback — full sync indicator
  if (!status) return null;

  const pill = (() => {
    if (!online || isFallback) {
      return {
        bg: "bg-amber-900/40",
        dot: "bg-amber-500",
        text: "text-amber-400",
        label: isFallback ? "Offline — using local data" : "Offline",
      };
    }
    switch (status.state) {
      case "syncing":
        return {
          bg: "bg-blue-900/40",
          dot: "bg-blue-400 animate-pulse",
          text: "text-blue-300",
          label: status.progress || "Syncing...",
        };
      case "error":
        return {
          bg: "bg-red-900/40",
          dot: "bg-red-500",
          text: "text-red-300",
          label: "Sync error",
        };
      case "idle":
        return {
          bg: "bg-green-900/40",
          dot: "bg-green-500",
          text: "text-green-400",
          label: status.lastSyncAt
            ? `Synced ${formatRelativeTime(status.lastSyncAt)}`
            : "Connected",
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
        ref={buttonRef}
        onClick={() => setShowTooltip(!showTooltip)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${pill.bg} ${pill.text} hover:opacity-80 transition-opacity`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${pill.dot}`} />
        {pill.label}
      </button>

      {showTooltip && (
        <div
          ref={tooltipRef}
          className="absolute top-full right-0 mt-1.5 w-72 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-3 z-50 text-xs"
        >
          <div className="text-gray-300 mb-2">
            <strong>Mode:</strong>{" "}
            {mode === "hybrid"
              ? "Hybrid (Local + Cloud)"
              : isFallback
                ? "Atlas (local fallback active)"
                : "Atlas (Cloud)"}
          </div>
          <div className="text-gray-300 mb-2">
            <strong>Network:</strong>{" "}
            <span className={online ? "text-green-400" : "text-amber-400"}>
              {online ? "Online" : "Offline"}
            </span>
          </div>
          {status.lastSyncAt && (
            <div className="text-gray-400 mb-2">
              <strong>Last sync:</strong> {new Date(status.lastSyncAt).toLocaleString()}
            </div>
          )}
          {status.error && (
            <div className="text-red-400 mb-2 break-words">
              <strong>Error:</strong> {status.error}
            </div>
          )}
          <button
            onClick={handleSync}
            disabled={status.state === "syncing" || !online}
            className="w-full px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50 mt-1"
          >
            {status.state === "syncing" ? "Syncing..." : !online ? "Offline" : "Sync Now"}
          </button>
        </div>
      )}
    </div>
  );
}

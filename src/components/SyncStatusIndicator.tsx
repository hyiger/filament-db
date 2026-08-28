"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useDateFormat } from "@/hooks/useDateFormat";

interface SyncStatus {
  // GH #369: "partial" = at least one collection synced, at least one failed.
  state: "idle" | "syncing" | "error" | "offline" | "partial";
  lastSyncAt: string | null;
  error: string | null;
  progress: string | null;
  /** GH #1164: trim-collision conflicts the sync pass saw, side-tagged.
   *  Optional — an older main process simply omits it. */
  nameConflicts?: Array<{
    collection: string;
    name: string;
    trimsTo: string | null;
    collidesWith: { id: string; name: string } | null;
    side: "local" | "remote";
  }>;
}

function formatRelativeTime(iso: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("sync.time.justNow");
  if (mins < 60) return t("sync.time.minutesAgo", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("sync.time.hoursAgo", { count: hours });
  return t("sync.time.daysAgo", { count: Math.floor(hours / 24) });
}

export default function SyncStatusIndicator() {
  const { t } = useTranslation();
  const { formatDateTime } = useDateFormat();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [mode, setMode] = useState<string>("");
  const [isFallback, setIsFallback] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [online, setOnline] = useState(true);
  const [mounted, setMounted] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Avoid hydration mismatch — only render after mount
  useEffect(() => {
    setOnline(navigator.onLine); // eslint-disable-line react-hooks/set-state-in-effect -- mount-only initialization to avoid hydration mismatch
    setMounted(true);
  }, []);

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

  // Track actual Atlas reachability (not just navigator.onLine)
  const [atlasReachable, setAtlasReachable] = useState<boolean | null>(null);

  // Electron sync status
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getSyncStatus) return;

    // The IPC calls below resolve asynchronously; guard every setState
    // behind `active` so a fast unmount can't set state after unmount.
    let active = true;

    api.getConfig().then((config) => {
      if (!active) return;
      setMode(config.connectionMode);
      // For atlas mode, check actual Atlas connectivity
      if (config.connectionMode === "atlas" && api.checkAtlasConnectivity) {
        api.checkAtlasConnectivity().then((r) => {
          if (active) setAtlasReachable(r.connected);
        });
      }
    });

    // A live event can beat this promise; adopting the older snapshot
    // would roll the indicator back to a pre-completion state — and with
    // it the conflict count, which may be the only notice a remote-only
    // conflict ever gets. The mount snapshot yields to anything already
    // seen.
    let sawLiveStatus = false;
    api.getSyncStatus().then((s) => {
      if (active && !sawLiveStatus) setStatus(s);
    });

    const unsub1 = api.onSyncStatusChange((s) => {
      sawLiveStatus = true;
      setStatus(s);
    });
    const unsub2 = api.onConnectionModeFallback(() => {
      setIsFallback(true);
    });

    return () => {
      active = false;
      unsub1();
      unsub2();
    };
  }, []);

  // Periodically re-check Atlas connectivity in atlas mode
  useEffect(() => {
    if (mode !== "atlas" || isFallback) return;
    const api = window.electronAPI;
    if (!api?.checkAtlasConnectivity) return;
    let active = true;
    const id = setInterval(() => {
      api.checkAtlasConnectivity().then((r) => {
        if (active) setAtlasReachable(r.connected);
      });
    }, 60000); // check every 60s
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [mode, isFallback]);

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

  // Don't render until client-side mount to avoid hydration mismatch
  if (!mounted) return null;

  // ── Determine what to display ──

  // Non-Electron (web app): show simple online/offline pill
  if (!isElectron) {
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${
        online
          ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400"
          : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400"
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-green-500" : "bg-red-500"}`} />
        {online ? t("sync.status.connected") : t("sync.status.offline")}
      </span>
    );
  }

  // First-run Electron has connectionMode === "" (wizard not completed).
  // Suppress the pill entirely until the user picks a mode — the empty
  // string would fall through to the hybrid branch and render a
  // misleading green "Connected".
  if (!mode) return null;

  // Electron: offline mode
  if (mode === "offline") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
        {t("sync.status.local")}
      </span>
    );
  }

  // Electron: atlas mode (no fallback active) — show actual Atlas connectivity
  if (mode === "atlas" && !isFallback) {
    // Use actual Atlas ping result; fall back to navigator.onLine while first check is pending
    const connected = atlasReachable !== null ? atlasReachable : online;
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${
        connected
          ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400"
          : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400"
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-500" : "bg-amber-500"}`} />
        {connected ? t("sync.status.connected") : t("sync.status.noConnection")}
      </span>
    );
  }

  // Electron: hybrid or atlas-with-fallback — full sync indicator
  if (!status) return null;

  const pill = (() => {
    if (!online || isFallback) {
      return {
        bg: "bg-amber-100 dark:bg-amber-900/40",
        dot: "bg-amber-500",
        text: "text-amber-800 dark:text-amber-400",
        label: isFallback ? t("sync.status.offlineLocalData") : t("sync.status.offline"),
      };
    }
    switch (status.state) {
      case "syncing":
        return {
          bg: "bg-blue-100 dark:bg-blue-900/40",
          dot: "bg-blue-400 animate-pulse",
          text: "text-blue-800 dark:text-blue-300",
          label: status.progress || t("sync.status.syncing"),
        };
      case "error":
        return {
          bg: "bg-red-100 dark:bg-red-900/40",
          dot: "bg-red-500",
          text: "text-red-800 dark:text-red-300",
          label: t("sync.status.syncError"),
        };
      case "partial":
        // Amber, distinct from red — partial convergence is recoverable;
        // the tooltip's status.error names the failed collection(s).
        return {
          bg: "bg-amber-100 dark:bg-amber-900/40",
          dot: "bg-amber-500",
          text: "text-amber-800 dark:text-amber-300",
          label: t("sync.status.partial"),
        };
      case "idle":
        return {
          bg: "bg-green-100 dark:bg-green-900/40",
          dot: "bg-green-500",
          text: "text-green-800 dark:text-green-400",
          label: status.lastSyncAt
            ? t("sync.status.synced", { time: formatRelativeTime(status.lastSyncAt, t) })
            : t("sync.status.connected"),
        };
      default:
        return {
          bg: "bg-gray-200 dark:bg-gray-700",
          dot: "bg-gray-500",
          text: "text-gray-700 dark:text-gray-300",
          label: t("sync.status.hybrid"),
        };
    }
  })();

  return (
    <div className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setShowTooltip(!showTooltip)}
        // `aria-haspopup="dialog"` + `aria-expanded` announce that this
        // pill expands sync controls. The aria-label folds pill.label in
        // — a static "Open sync details" label would hide the visible
        // state (error/partial/offline/syncing) from SR users.
        aria-haspopup="dialog"
        aria-expanded={showTooltip}
        aria-label={`${pill.label} — ${t("sync.tooltip.openDetails")}`}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${pill.bg} ${pill.text} hover:opacity-80 transition-opacity`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${pill.dot}`} aria-hidden="true" />
        {pill.label}
      </button>

      {showTooltip && (
        <div
          ref={tooltipRef}
          className="absolute top-full right-0 mt-1.5 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 z-50 text-xs text-gray-700 dark:text-gray-200"
        >
          <div className="text-gray-700 dark:text-gray-300 mb-2">
            <strong>{t("sync.tooltip.mode")}:</strong>{" "}
            {mode === "hybrid"
              ? t("sync.tooltip.modeHybrid")
              : isFallback
                ? t("sync.tooltip.modeAtlasFallback")
                : t("sync.tooltip.modeAtlas")}
          </div>
          <div className="text-gray-700 dark:text-gray-300 mb-2">
            <strong>{t("sync.tooltip.network")}:</strong>{" "}
            <span className={online ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}>
              {online ? t("sync.tooltip.online") : t("sync.tooltip.offline")}
            </span>
          </div>
          {status.lastSyncAt && (
            <div className="text-gray-500 dark:text-gray-400 mb-2">
              <strong>{t("sync.tooltip.lastSync")}:</strong> {formatDateTime(status.lastSyncAt)}
            </div>
          )}
          {status.error && (
            <div className="text-red-600 dark:text-red-400 mb-2 break-words">
              <strong>{t("sync.tooltip.error")}:</strong> {status.error}
            </div>
          )}
          {/* GH #1164: name conflicts the sync pass found — the ONLY surface
              for one that exists solely on the remote database (the Data
              health page scans the local side). Deliberately NOT wired into
              the pill's state machine: "partial" means a collection failed
              to sync, which these are not. */}
          {(status.nameConflicts?.length ?? 0) > 0 && (
            <div className="text-amber-600 dark:text-amber-400 mb-2 break-words">
              <strong>{t("sync.tooltip.nameConflicts")}:</strong>{" "}
              {t("sync.tooltip.nameConflicts.count", {
                count: status.nameConflicts!.length,
              })}
              <ul className="mt-1 space-y-0.5">
                {status.nameConflicts!.slice(0, 3).map((c) => (
                  <li key={`${c.side}-${c.collection}-${c.name}`} className="font-mono text-[11px]">
                    {c.side} · {c.collection} · {JSON.stringify(c.name)}
                  </li>
                ))}
              </ul>
              <Link
                href="/settings/health"
                className="underline hover:no-underline mt-1 inline-block"
              >
                {t("sync.tooltip.nameConflicts.link")}
              </Link>
            </div>
          )}
          <button
            onClick={handleSync}
            disabled={status.state === "syncing" || !online}
            className="w-full px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50 mt-1"
          >
            {status.state === "syncing" ? t("sync.tooltip.syncing") : !online ? t("sync.tooltip.offline") : t("sync.tooltip.syncNow")}
          </button>
        </div>
      )}
    </div>
  );
}

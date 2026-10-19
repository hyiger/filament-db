"use client";

import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import Link from "next/link";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useDateFormat } from "@/hooks/useDateFormat";
import {
  dbErrorFromBody,
  type DbConnectionErrorInfo,
  type DbErrorInfo,
} from "@/lib/dbErrorKinds";
import DbErrorHint from "./DbErrorHint";

interface ConnectionFallback {
  intended: string;
  actual: string;
  /** GH #1231: why Atlas couldn't be reached. */
  reason?: DbConnectionErrorInfo | null;
}

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
  /** GH #1231: why the last cycle couldn't connect, and to which side. */
  connectionError?: DbConnectionErrorInfo | null;
  /** GH #1231: the startup Atlas-to-local fallback, readable on any mount. */
  fallback?: ConnectionFallback | null;
}

/** GH #1231: the web pill's last database verdict, kept across remounts.
 *  The header remounts on navigation, and starting each page from "no
 *  verdict" showed "Connected" until the next check answered (up to a full
 *  connection timeout while the database is down). Module scope is safe
 *  here: the pill renders nothing until mounted, so the server render never
 *  reads it. */
let lastDbHealth: "ok" | DbErrorInfo | null = null;

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
  const [fallbackEvent, setFallbackEvent] = useState<ConnectionFallback | null>(null);
  // GH #1231: WHICH pill's popover is open, not just "open". Three pills
  // can open one now, and the web/atlas ones turn back into plain spans when
  // the connection recovers; a bare boolean outlived that and reopened the
  // popover by itself on the next failure.
  const [openPill, setOpenPill] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [mounted, setMounted] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // GH #1231: the fallback lives on the sync status too, because the
  // one-shot event is gone after a reload, and with it the indicator used
  // to drop back to the Atlas pill and hide the fallback sync's errors.
  const fallback = status?.fallback ?? fallbackEvent;
  const isFallback = fallback !== null;

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
    if (!openPill) return;
    const handleClick = (e: MouseEvent) => {
      if (
        tooltipRef.current && !tooltipRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpenPill(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openPill]);

  // Track actual Atlas reachability (not just navigator.onLine), and since
  // GH #1231 the reason when it isn't.
  const [atlasCheck, setAtlasCheck] = useState<{
    connected: boolean;
    error?: DbConnectionErrorInfo;
  } | null>(null);

  // GH #1231: web mode's database reachability, from /api/health. "ok",
  // a classified failure, or null when there is no verdict (still pending,
  // the server itself unreachable, or a response that isn't ours).
  const [dbHealth, setDbHealth] = useState<"ok" | DbErrorInfo | null>(() => lastDbHealth);

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
          if (active) setAtlasCheck(r);
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
    const unsub2 = api.onConnectionModeFallback((info) => {
      setFallbackEvent({ intended: info.intended, actual: info.actual, reason: info.reason ?? null });
    });

    return () => {
      active = false;
      unsub1();
      unsub2();
    };
  }, []);

  // GH #1231: web mode used to show "Connected" from navigator.onLine while
  // every API call was failing. Ask the server whether IT can reach the
  // database: on mount, when the browser comes back online, and every 60 s.
  useEffect(() => {
    if (window.electronAPI) return;
    let active = true;
    const ac = new AbortController();
    const check = async () => {
      let verdict: "ok" | DbErrorInfo | null;
      try {
        const res = await fetch("/api/health", { cache: "no-store", signal: ac.signal });
        const body = await res.json().catch(() => null);
        verdict = res.ok ? "ok" : dbErrorFromBody(body);
      } catch {
        verdict = null;
      }
      // An unmount aborts the request; that is no verdict on the database.
      if (!active) return;
      lastDbHealth = verdict;
      setDbHealth(verdict);
    };
    void check();
    const id = setInterval(check, 60000);
    window.addEventListener("online", check);
    return () => {
      active = false;
      ac.abort();
      clearInterval(id);
      window.removeEventListener("online", check);
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
        if (active) setAtlasCheck(r);
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

  /** A pill that opens a details popover. `colors` carries the background,
   *  text and hover classes. The aria-label folds the visible label in, so
   *  a static "Open sync details" can't hide the state from SR users. */
  const detailsPill = (
    kind: "web-db" | "atlas-error" | "sync",
    colors: string,
    dot: string,
    label: string,
    body: ReactNode,
  ) => {
    const open = openPill === kind;
    return (
      <div className="relative inline-flex">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpenPill(open ? null : kind)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label} — ${t("sync.tooltip.openDetails")}`}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${colors} hover:opacity-80 transition-opacity`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
          {label}
        </button>
        {open && (
          <div
            ref={tooltipRef}
            className="absolute top-full right-0 mt-1.5 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 z-50 text-xs text-gray-700 dark:text-gray-200"
          >
            {body}
          </div>
        )}
      </div>
    );
  };

  /** A classified connection failure: heading, translated hint, details. */
  const connectionProblem = (
    heading: string,
    info: DbErrorInfo,
    surface: "desktop" | "server",
    detail?: string | null,
  ) => (
    <div className="text-red-600 dark:text-red-400 mb-2 break-words">
      <strong>{heading}:</strong>
      <DbErrorHint info={info} surface={surface} detail={detail} className="mt-1" />
    </div>
  );

  // ── Determine what to display ──

  // Non-Electron (web app): online/offline pill, plus the server's own
  // verdict on its database (GH #1231).
  if (!isElectron) {
    if (online && dbHealth !== null && dbHealth !== "ok") {
      return detailsPill(
        "web-db",
        "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400",
        "bg-red-500",
        t("sync.status.dbUnavailable"),
        connectionProblem(t("db.error.heading"), dbHealth, "server"),
      );
    }
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
    const connected = atlasCheck !== null ? atlasCheck.connected : online;
    const atlasError = atlasCheck && !atlasCheck.connected ? atlasCheck.error : undefined;
    if (!connected && atlasError) {
      // GH #1231: the reason, where there used to be only "No connection".
      return detailsPill(
        "atlas-error",
        "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400",
        "bg-amber-500",
        t("sync.status.noConnection"),
        <>
          <div className="text-gray-700 dark:text-gray-300 mb-2">
            <strong>{t("sync.tooltip.mode")}:</strong> {t("sync.tooltip.modeAtlas")}
          </div>
          {connectionProblem(t("db.error.heading"), atlasError, "desktop", atlasError.detail)}
        </>,
      );
    }
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

  // GH #1231: a classified connect failure replaces the raw text (which
  // moves under "Technical details"). The startup fallback's reason shows
  // only until a sync cycle has a fresher verdict: a failed connect (shown
  // instead) or a completed cycle (`lastSyncAt`, which a fresh fallback
  // service starts without and only a cycle that reached Atlas sets). After
  // that, Atlas is reachable again and the app is only waiting to be
  // switched back.
  const connectionError = status.connectionError ?? null;
  const fallbackReason =
    !connectionError && isFallback && !status.lastSyncAt ? fallback?.reason ?? null : null;
  const atlasBackWhileFallback = !connectionError && isFallback && !!status.lastSyncAt;

  return detailsPill(
    "sync",
    `${pill.bg} ${pill.text}`,
    pill.dot,
    pill.label,
    <>
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
      {connectionError
        ? connectionProblem(t("db.error.heading"), connectionError, "desktop", connectionError.detail)
        : status.error && (
            <div className="text-red-600 dark:text-red-400 mb-2 break-words">
              <strong>{t("sync.tooltip.error")}:</strong> {status.error}
            </div>
          )}
      {fallbackReason &&
        connectionProblem(t("sync.tooltip.fallbackReason"), fallbackReason, "desktop", fallbackReason.detail)}
      {atlasBackWhileFallback && (
        <div className="text-green-700 dark:text-green-400 mb-2 break-words">
          {t("sync.tooltip.atlasReachableAgain")}
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
    </>,
  );
}

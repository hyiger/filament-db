"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useIsElectron } from "@/hooks/useIsElectron";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useConfirm } from "@/components/ConfirmDialog";
import CopyButton from "@/components/CopyButton";
import type { SecureGatewayStatus } from "@/lib/gatewayRuntime";

type SecurityStatus = SecureGatewayStatus & { httpKeyRequired: boolean };

/** The gateway's own sign-out endpoint (src/lib/secureGateway.ts). */
const LOGOUT_PATH = "/__filamentdb/logout";

/** The current status, or null when it could not be read. */
async function fetchStatus(signal?: AbortSignal): Promise<SecurityStatus | null> {
  try {
    const res = await fetch("/api/security", { signal, cache: "no-store" });
    return res.ok ? ((await res.json()) as SecurityStatus) : null;
  } catch {
    return null;
  }
}

const noSubscription = () => () => {};
/** The gateway is the only HTTPS way in, so an https page is a signed-in
 * gateway session and can be signed out. False on the server and during
 * hydration, so the first client render matches the server's. */
const pageIsHttps = () => window.location.protocol === "https:";

/**
 * Settings → Network: access from other devices.
 *
 * This computer always reaches the app over plain HTTP with no key. Other
 * devices go through the secure gateway: HTTPS, with an API key that is
 * generated on first start and can be rolled here. On the desktop the switch
 * turns the gateway on and off; on a server it is configured through the
 * environment and this card reports it.
 */
export default function SecureAccessCard() {
  const { t } = useTranslation();
  const isElectron = useIsElectron();
  const { formatDate } = useDateFormat();
  const confirm = useConfirm();

  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [exposeToLan, setExposeToLan] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggleError, setToggleError] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [justRolled, setJustRolled] = useState(false);
  const viaGateway = useSyncExternalStore(noSubscription, pageIsHttps, () => false);

  const applyStatus = useCallback((next: SecurityStatus | null) => {
    if (next) setStatus(next);
    setLoadFailed(next === null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const ifCurrent = <T,>(apply: (value: T) => void) => (value: T) => {
      if (!controller.signal.aborted) apply(value);
    };
    fetchStatus(controller.signal).then(ifCurrent(applyStatus));
    window.electronAPI
      ?.getConfig?.()
      .then(
        ifCurrent((cfg) => {
          if (typeof cfg.exposeToLan === "boolean") setExposeToLan(cfg.exposeToLan);
        }),
      )
      .catch(() => {});
    return () => controller.abort();
  }, [applyStatus]);

  async function toggleLanShare(next: boolean) {
    const api = window.electronAPI;
    if (!api?.saveConfig) return;
    setSaving(true);
    setToggleError(false);
    setKey(null);
    setJustRolled(false);
    try {
      // The embedded server restarts to start or stop the gateway; saveConfig
      // resolves once it is back, so the status read below is the new state.
      const res = await api.saveConfig({ exposeToLan: next });
      if (res?.success) setExposeToLan(next);
      else setToggleError(true);
    } catch {
      setToggleError(true);
    } finally {
      applyStatus(await fetchStatus());
      setSaving(false);
    }
  }

  async function keyRequest(action: "reveal" | "roll"): Promise<string | null> {
    setKeyBusy(true);
    setKeyError(null);
    try {
      const res = await fetch(`/api/security/key/${action}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { key?: string };
      if (!res.ok || typeof body.key !== "string") throw new Error(String(res.status));
      return body.key;
    } catch {
      setKeyError(t(action === "roll" ? "settings.secure.rollFailed" : "settings.secure.revealFailed"));
      return null;
    } finally {
      setKeyBusy(false);
    }
  }

  async function showKey() {
    if (key !== null) {
      setKey(null);
      setJustRolled(false);
      return;
    }
    setKey(await keyRequest("reveal"));
  }

  async function rollKey() {
    const ok = await confirm({
      title: t("settings.secure.rollConfirmTitle"),
      message: t("settings.secure.rollConfirmBody"),
      confirmLabel: t("settings.secure.rollConfirmAction"),
      destructive: true,
    });
    if (!ok) return;
    const next = await keyRequest("roll");
    if (next === null) return;
    setKey(next);
    setJustRolled(true);
  }

  const running = status?.running === true;
  const tls = status?.tls ?? null;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5">
      <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-1">{t("settings.lanShare.title")}</h2>
      <p className="text-sm text-gray-500 mb-4">{t("settings.lanShare.desc")}</p>

      {isElectron && (
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            role="switch"
            aria-checked={exposeToLan}
            disabled={saving}
            onClick={() => toggleLanShare(!exposeToLan)}
            className={`px-4 py-2 text-sm rounded border transition-colors disabled:opacity-50 ${
              exposeToLan
                ? "border-green-500 bg-green-50 dark:bg-green-600/20 text-green-700 dark:text-green-300"
                : "border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-300"
            }`}
          >
            {saving ? t("settings.lanShare.applying") : exposeToLan ? t("settings.lanShare.on") : t("settings.lanShare.off")}
          </button>
          {running && !saving && (
            <span className="text-sm text-green-700 dark:text-green-300">{t("settings.lanShare.activeHint")}</span>
          )}
        </div>
      )}

      {toggleError && (
        <div className="mt-3 text-sm px-3 py-2 rounded bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
          {t("settings.lanShare.error")}
        </div>
      )}

      {loadFailed && (
        <div className="mt-3 text-sm px-3 py-2 rounded bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
          {t("settings.secure.statusFailed")}
        </div>
      )}

      {status && !status.configured && !isElectron && (
        <p className="text-sm text-gray-600 dark:text-gray-400">{t("settings.secure.notConfigured")}</p>
      )}

      {status?.configured && !running && status.error && (
        <div role="alert" className="mt-3 text-sm px-3 py-2 rounded bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
          {t("settings.secure.notRunning", { error: status.error })}
        </div>
      )}

      {running && status && (
        <div className="mt-4 space-y-5">
          <section>
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">{t("settings.secure.addresses")}</h3>
            {isElectron && (
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">{t("settings.lanShare.autoDiscover")}</p>
            )}
            {status.urls.length > 0 ? (
              <ul className="space-y-1">
                {status.urls.map((url) => (
                  <li key={url} className="flex items-center gap-2">
                    <code className="text-sm px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded font-mono text-gray-800 dark:text-gray-200 break-all">{url}</code>
                    <CopyButton value={url} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-amber-600 dark:text-amber-400">{t("settings.lanShare.noIp")}</p>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">{t("settings.secure.key")}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">{t("settings.secure.keyDesc")}</p>
            <div className="flex items-center gap-2 flex-wrap">
              <code
                aria-label={key === null ? t("settings.secure.keyHidden") : undefined}
                className="text-sm px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded font-mono text-gray-800 dark:text-gray-200 break-all"
              >
                {key ?? "••••••••••••••••••••••••"}
              </code>
              {key !== null && <CopyButton value={key} label={t("settings.secure.copyKey")} />}
              <button
                type="button"
                onClick={showKey}
                disabled={keyBusy}
                className="px-3 py-1 text-sm rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 disabled:opacity-50 transition-colors"
              >
                {key === null ? t("settings.secure.showKey") : t("settings.secure.hideKey")}
              </button>
              {status.key?.rollable && (
                <button
                  type="button"
                  onClick={rollKey}
                  disabled={keyBusy}
                  className="px-3 py-1 text-sm rounded border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50 transition-colors"
                >
                  {t("settings.secure.rollKey")}
                </button>
              )}
            </div>
            {status.key?.source === "env" && (
              <p className="mt-2 text-xs text-gray-500">{t("settings.secure.keyFromEnv")}</p>
            )}
            {justRolled && (
              <p role="status" className="mt-2 text-sm text-green-700 dark:text-green-300">{t("settings.secure.rolled")}</p>
            )}
            {keyError && (
              <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{keyError}</p>
            )}
          </section>

          {tls && (
            <section>
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">{t("settings.secure.certificate")}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                {t(tls.mode === "custom" ? "settings.secure.certCustom" : "settings.secure.certGenerated")}
              </p>
              <dl className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
                <div>
                  <dt className="inline text-gray-500">{t("settings.secure.fingerprint")} </dt>
                  <dd className="inline font-mono text-xs break-all">{tls.caFingerprint256 ?? tls.fingerprint256}</dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">{t("settings.secure.expires")} </dt>
                  <dd className="inline">{formatDate(tls.notAfter)}</dd>
                </div>
              </dl>
              {tls.mode === "self-signed" && (
                <a
                  href="/api/security/ca"
                  download="filament-db-ca.crt"
                  className="inline-block mt-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {t("settings.secure.downloadCa")}
                </a>
              )}
            </section>
          )}

          {viaGateway && (
            <form method="post" action={LOGOUT_PATH}>
              <button
                type="submit"
                className="px-3 py-1 text-sm rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
              >
                {t("settings.secure.signOut")}
              </button>
            </form>
          )}
        </div>
      )}

      <div className="mt-4 text-xs text-amber-700 dark:text-amber-300/90 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/60 rounded px-3 py-2">
        {t("settings.lanShare.warning")}
      </div>
    </div>
  );
}

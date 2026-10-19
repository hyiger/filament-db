"use client";

import { useTranslation } from "@/i18n/TranslationProvider";
import { useIsElectron } from "@/hooks/useIsElectron";
import type { LoadFailure } from "@/lib/loadFailure";
import DbErrorHint from "./DbErrorHint";

/**
 * GH #1231: the persistent panel a list page shows in place of its content
 * when the load failed. It replaces the transient toast, after which the
 * page used to fall through to its empty state. With a database failure it
 * explains the cause; otherwise it shows the page's own message. Either way
 * it offers Retry.
 */
export default function LoadErrorPanel({
  failure,
  message,
  onRetry,
}: {
  failure: LoadFailure;
  /** The page's generic load-error text, used when the cause is unknown. */
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  // The renderer is the same Next app on the desktop, where the advice is
  // about this computer rather than a server host.
  const isElectron = useIsElectron();
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300"
    >
      {failure.db ? (
        <>
          <p className="font-semibold mb-1">{t("db.error.heading")}</p>
          <DbErrorHint info={failure.db} surface={isElectron ? "desktop" : "server"} />
        </>
      ) : (
        <p>{message}</p>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 hover:border-gray-400"
      >
        {t("common.retry")}
      </button>
    </div>
  );
}

"use client";

import { useTranslation } from "@/i18n/TranslationProvider";
import {
  dbErrorMessageKey,
  type DbErrorInfo,
  type DbErrorSurface,
} from "@/lib/dbErrorKinds";

/**
 * GH #1231: the translated explanation for a database-connection failure,
 * with the raw driver text (already redacted) folded under "Technical
 * details" when there is any. Only desktop surfaces pass `detail`; API
 * responses never carry the raw message.
 */
export default function DbErrorHint({
  info,
  surface,
  detail,
  className,
}: {
  info: DbErrorInfo;
  surface: DbErrorSurface;
  detail?: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={className}>
      <p>{t(dbErrorMessageKey(info, surface))}</p>
      {detail ? (
        <details className="mt-1">
          <summary className="cursor-pointer opacity-80">{t("db.error.details")}</summary>
          <p className="mt-1 font-mono text-[11px] break-words opacity-80">{detail}</p>
        </details>
      ) : null}
    </div>
  );
}

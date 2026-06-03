"use client";

import { useState, useEffect } from "react";
import { useNfcContext } from "@/components/NfcProvider";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function NfcStatus() {
  const {
    isElectron,
    status,
    loadedTagName,
    tagReadResult,
    dialogOpen,
    reopenTagRead,
  } = useNfcContext();
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — only render after client mount
  useEffect(() => {
    setMounted(true); // eslint-disable-line react-hooks/set-state-in-effect -- mount-only initialization to avoid hydration mismatch
  }, []);

  if (!mounted || !isElectron) return null;

  // GH #450: classify the reader's lastError into a human-readable hint
  // so a macOS user denied Smart Card access (or whose reader is busy
  // with another app) sees an actionable message instead of the generic
  // "No reader connected" pill. `status.lastError` is null on healthy
  // readers — render the normal three-state pill in that case.
  const errorHint = status.lastError
    ? (() => {
        const code = status.lastError.code;
        const knownCodes = ["permission", "busy", "no-daemon", "generic"] as const;
        const i18nKey = (knownCodes as readonly string[]).includes(code)
          ? `nfc.error.${code}`
          : "nfc.error.generic";
        return t(i18nKey);
      })()
    : null;

  let dotColor: string;
  let label: string;
  // Optional plain-language hint appended to the tooltip for states whose
  // short pill label can read as over-promising. GH #575 item 7: "Ready —
  // place tag" implies a tag resting on the reader will be picked up, but a
  // read only fires on a fresh placement (the arrival edge) — detection of an
  // already-resting tag is tracked separately in #572. The hint sets accurate
  // expectations without bloating the space-constrained pill.
  let hint: string | null = null;

  if (errorHint) {
    // Error takes precedence over reader/tag state — the user needs to
    // see what to fix before "Tag detected" matters.
    dotColor = "bg-red-500";
    label = errorHint;
  } else if (!status.readerConnected) {
    dotColor = "bg-gray-500";
    label = t("nfc.status.noReader");
  } else if (!status.tagPresent) {
    dotColor = "bg-yellow-400";
    label = t("nfc.status.readyPlaceTag");
    hint = t("nfc.status.readyPlaceTagHint");
  } else {
    dotColor = "bg-green-400";
    // `loadedTagName` is gated on the reader's tagPresent state in the
    // provider, so an A→B tag swap shows "Tag detected (<uid>)" during
    // the brief decode window rather than the previous tag's name.
    if (loadedTagName) {
      label = t("nfc.status.tagLoaded", { name: loadedTagName });
    } else if (status.tagUid) {
      label = t("nfc.status.tagDetectedWithUid", { uid: status.tagUid.slice(-8).toUpperCase() });
    } else {
      label = t("nfc.status.tagDetected");
    }
  }

  // Tooltip surfaces the raw error message when we have one (PR-Q #476)
  // — useful for diagnostics even if the classified hint already
  // explains what to do.
  const tooltip = status.lastError
    ? `${label}\n\n${status.lastError.message}`
    : hint
      ? `${label}\n\n${hint}`
      : label;

  // GH #451 follow-up (Codex P2 on PR #475): when an NFC scan has
  // landed but the dialog is currently dismissed (either auto-suppressed
  // because the user was typing, or manually closed), make the pill
  // clickable so the user can pull the scan dialog back up. Without
  // this, a typing-suppressed scan was unreachable until the next
  // physical tag-rescan.
  const canReopen = tagReadResult != null && !dialogOpen;
  const sharedClasses =
    "inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full text-xs text-gray-600 dark:text-gray-300 max-w-[260px]";

  const inner = (
    <>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </>
  );

  if (canReopen) {
    // Codex P2 on PR #475 round 2: don't drop the live region when the
    // pill becomes a button — a SR user would lose announcements while
    // the dialog is dismissed (which is the very state this branch
    // exists to support). `aria-live` + `aria-atomic` work on any
    // element, so they go on the button directly; `role="status"` is
    // omitted because it would override the implicit button role and
    // strip the click affordance. The live-region behaviour matches
    // the <div> branch below.
    //
    // Codex P2 on PR #475 round 3: also DON'T clobber the visible pill
    // text with a static "Reopen NFC scan details" aria-label — that
    // hides the actual NFC status (the very thing the user needs to
    // discover via this pill). Fold the visible status into the
    // accessible name so a SR user hears "<status> — Reopen scan
    // details", preserving both the state and the action affordance.
    return (
      <button
        type="button"
        onClick={reopenTagRead}
        title={`${tooltip}\n\n${t("nfc.reopen")}`}
        aria-label={`${label} — ${t("nfc.reopen")}`}
        aria-live="polite"
        aria-atomic="true"
        className={`${sharedClasses} cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      // GH #417: a screen reader user has no other way to know an NFC
      // tag landed — wrap the live-updating label in a polite live region
      // so SRs announce the change without interrupting other speech.
      // `aria-atomic` ensures the full label re-reads each time (the
      // text varies between "no reader", "ready", and "<tag name>" — a
      // partial update would sound clipped).
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={sharedClasses}
      title={tooltip}
    >
      {inner}
    </div>
  );
}

/**
 * GH #450 — map opaque pcsclite/reader error messages to one of four
 * classes so the NFC status pill can render a translated, actionable
 * hint instead of falling back to the generic "No reader connected"
 * label that masked permission-denied / reader-busy situations on
 * macOS.
 *
 * Lives in `src/lib/` (and not co-located with NfcService in
 * `electron/`) so the project's vitest config — which excludes
 * `electron/` from compilation — can still exercise this with a unit
 * test. NfcService re-exports the types and calls into here.
 *
 * The matches are deliberately loose. Driver and OS variants
 * paraphrase the same conditions in many different ways and we can't
 * enumerate every wording — substring-match keeps the classification
 * robust as new drivers ship.
 */

/** Four buckets the renderer translates to a plain-language hint:
 *   - permission: macOS Smart Card access not granted (or Linux pcscd
 *     group membership missing)
 *   - busy: another PC/SC client holds the reader (CryptoTokenKit, a
 *     vendor utility, etc.)
 *   - no-daemon: pcscd / Smart Card service not running
 *   - generic: everything else — fall back to the raw message tooltip */
export type NfcErrorCode = "permission" | "busy" | "no-daemon" | "generic";

export function classifyNfcError(err: unknown): NfcErrorCode {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);
  const lower = message.toLowerCase();

  // macOS Sequoia onwards prompts for Smart Card access; deny → "not
  // authorized" / "service not available" depending on path. Linux also
  // reports "access denied" when the user isn't in the pcscd group.
  if (
    lower.includes("not authorized") ||
    lower.includes("permission") ||
    lower.includes("access denied") ||
    lower.includes("scard_e_no_access")
  ) {
    return "permission";
  }

  // Reader held by another PC/SC client. The most common macOS case is
  // Apple's CryptoTokenKit holding the reader for a smart-card login
  // flow; "sharing violation" is the canonical SCardConnect failure.
  if (
    lower.includes("shared") ||
    lower.includes("in use") ||
    lower.includes("sharing violation") ||
    lower.includes("scard_e_sharing_violation")
  ) {
    return "busy";
  }

  // pcscd / "Smart Card Services" not running. `SCardEstablishContext`
  // failures usually mean the daemon isn't reachable.
  //
  // Codex P2 on PR #476 round 2: the canonical macOS wording is
  // "SCardEstablishContext: Service not available" — neither "no
  // service" nor "daemon" appears as a substring of that. Add the
  // wider "service not available" / "service unavailable" wordings
  // so a stopped pcscd / Smart Card Service surfaces the actionable
  // no-daemon hint instead of falling through to generic.
  if (
    lower.includes("no service") ||
    lower.includes("service not available") ||
    lower.includes("service unavailable") ||
    lower.includes("scard_e_no_service") ||
    lower.includes("daemon") ||
    lower.includes("scardestablishcontext")
  ) {
    return "no-daemon";
  }

  return "generic";
}

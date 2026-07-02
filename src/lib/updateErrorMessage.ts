/**
 * Classify an auto-updater failure into a small, stable "kind" the renderer can
 * localize, plus a short, stack-free detail string for logs / a hover tooltip.
 *
 * GH #946: electron-updater surfaces failures as errors whose `.message` is a
 * multi-line blob — the HTTP status body, every response header, and a JS stack
 * trace (see the 404 `latest-mac.yml` example in the issue). Emitting that raw
 * message straight to the update banner dumps a stack trace at the user. This
 * helper maps the error to a cause so the banner can show a friendly, localized
 * line while the full error still goes to the log.
 *
 * Pure + DB-free so it's unit-tested and shared by the Electron main process
 * (electron/auto-updater.ts) and — via the `kind` — the renderer's i18n.
 */

export type UpdateErrorKind = "no-metadata" | "network" | "signature" | "unknown";

export interface ClassifiedUpdateError {
  /** Stable cause the renderer maps to a localized message. */
  kind: UpdateErrorKind;
  /** First meaningful line of the raw message: stack frames removed, trimmed,
   *  and length-capped. Safe to show as a tooltip and to log. Never the
   *  multi-line blob. */
  detail: string;
}

/** Keep the tooltip/log line to one short line. */
const MAX_DETAIL = 140;

function rawMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === "string") return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err ?? "");
}

/** First non-empty, non-stack-frame line, trimmed and capped. */
function shortDetail(raw: string): string {
  const line =
    raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("at ")) ?? raw.trim();
  if (line.length <= MAX_DETAIL) return line;
  return line.slice(0, MAX_DETAIL - 1).trimEnd() + "…";
}

export function classifyUpdateError(err: unknown): ClassifiedUpdateError {
  const raw = rawMessage(err);
  const lower = raw.toLowerCase();

  let kind: UpdateErrorKind = "unknown";
  if (
    // UNAMBIGUOUS TRANSPORT errors first: a DNS / connection / timeout failure
    // while requesting the metadata file carries the `latest*.yml` URL in its
    // message too, so it must be classified `network` BEFORE the URL-based
    // no-metadata check below — otherwise "couldn't reach the server" would
    // read as "no update for this release" (Codex review). Certificate/TLS
    // wording is deliberately NOT matched here — see the ordering note on the
    // signature branch.
    /enotfound|econnrefused|econnreset|etimedout|eai_again|enetunreach|epipe|net::|getaddrinfo|request timed out|timed out|socket hang up|network error|\bdns\b/.test(
      lower,
    )
  ) {
    kind = "network";
  } else if (
    // Signature / integrity: the downloaded update is corrupt or its
    // code-signature / checksum doesn't validate. Checked BEFORE the TLS
    // certificate patterns below because a rejected installer signature often
    // mentions its signing `certificate` too (e.g. electron-updater's "not
    // signed by the application owner: publisherNames …") — a broad
    // `certificate` transport match would misreport a failed verification as
    // "check your connection" (Codex review).
    /sha512|checksum|integrity|code ?sign|not signed|signature|notariz|publisher/.test(lower)
  ) {
    kind = "signature";
  } else if (
    // TLS-layer certificate failures reaching the update server (proxy MITM,
    // clock skew, corporate TLS interception). Narrowed to TLS-specific
    // shapes — a bare `certificate` is no longer enough, so a signing-cert
    // message without explicit signature wording falls through to `unknown`
    // rather than misclassifying as network.
    /self[- ]signed|certificate has expired|certificate verify failed|unable to (verify|get)|\btls\b|\bssl\b/.test(
      lower,
    )
  ) {
    kind = "network";
  } else if (
    // The release is missing its update-metadata file, or the release/asset
    // isn't found (404). Requires an explicit not-found signal — merely
    // mentioning `latest*.yml` isn't enough, because that URL also appears in
    // the transport errors handled above.
    lower.includes("cannot find") ||
    lower.includes("no published versions") ||
    ((lower.includes("404") || lower.includes("not found")) &&
      (lower.includes(".yml") || lower.includes("release")))
  ) {
    kind = "no-metadata";
  }

  return { kind, detail: shortDetail(raw) };
}

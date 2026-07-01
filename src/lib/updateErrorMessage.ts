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
    // The reported case: the release is missing its update-metadata file, or
    // the GitHub API can't find the release/asset (404). electron-updater's
    // "Cannot find <latest*.yml>" and "No published versions" fall here.
    /latest[\w-]*\.yml/.test(lower) ||
    lower.includes("cannot find") ||
    lower.includes("no published versions") ||
    ((lower.includes("404") || lower.includes("not found")) &&
      (lower.includes("release") || lower.includes(".yml")))
  ) {
    kind = "no-metadata";
  } else if (
    // Signature / integrity: the downloaded update is corrupt or its
    // code-signature / checksum doesn't validate.
    /sha512|checksum|integrity|code sign|not signed|signature|notariz/.test(lower)
  ) {
    kind = "signature";
  } else if (
    // Couldn't reach the update server (DNS / connection / TLS / timeout).
    /enotfound|econnrefused|econnreset|etimedout|eai_again|enetunreach|epipe|net::|getaddrinfo|request timed out|timed out|socket hang up|network|dns|certificate|self[- ]signed|unable to (verify|get)/.test(
      lower,
    )
  ) {
    kind = "network";
  }

  return { kind, detail: shortDetail(raw) };
}

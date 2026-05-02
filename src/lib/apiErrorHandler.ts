import { NextResponse } from "next/server";

/**
 * Extracts a human-readable error message from an unknown error value.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Creates a standardized JSON error response.
 */
export function errorResponse(
  error: string,
  status: number,
  detail?: string,
): NextResponse {
  return NextResponse.json(
    detail ? { error, detail } : { error },
    { status },
  );
}

/**
 * Checks if an error is a MongoDB duplicate-key error (code 11000).
 * Returns a formatted 409 response if so, otherwise null.
 */
export function handleDuplicateKeyError(
  err: unknown,
  entityName: string,
): NextResponse | null {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: number }).code === 11000
  ) {
    const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue;
    const field = keyValue ? Object.keys(keyValue)[0] : "field";
    const value = keyValue ? Object.values(keyValue)[0] : "unknown";
    return errorResponse(
      `A ${entityName} with that ${field} already exists: "${value}"`,
      409,
    );
  }
  return null;
}

/**
 * True when a message text matches a known client-input rejection — pre-update
 * hooks (`tdsUrl must be a valid http(s) URL`) and the shared SSRF guard
 * (`assertExternalUrl` rejections from src/lib/externalUrlGuard.ts). Used both
 * for thrown Errors (see `isClientInputError`) and for failure objects whose
 * error is returned as a string (e.g. tdsExtractor result.error).
 *
 * `Invalid URL:` is colon-anchored on purpose. `assertExternalUrl` re-throws
 * its constructor failure as `Invalid URL: <input>` so it matches here, while
 * the bare `new URL(...)` constructor (used by the TDS redirect resolver in
 * src/lib/tdsExtractor.ts when the upstream Location header is malformed)
 * throws just `Invalid URL`. The bare form is an upstream/bad-gateway
 * failure, not user input, and must NOT be mapped to 400 (Codex P2 on PR
 * #167).
 */
export function isClientInputErrorMessage(message: string): boolean {
  return /must be a valid|Disallowed URL scheme|private\/internal address|URL hostname does not resolve|URL has no hostname|Invalid URL:/i.test(message);
}

/**
 * True when an error is a client-input rejection rather than a server fault —
 * Mongoose schema validators (`ValidationError`), our pre-update hooks
 * (`tdsUrl must be a valid http(s) URL`), and the shared SSRF guard
 * (`assertExternalUrl` rejections from src/lib/externalUrlGuard.ts).
 *
 * Used by route handlers to distinguish 4xx-worthy "your input was bad"
 * from 5xx "the server crashed". Without this, validators throw a generic
 * Error and the catch-all returns 500/502, which is wrong for monitoring
 * (alerts on legitimate user-input rejections) and bad UX (renderers can't
 * branch on "show form error" vs "show server error").
 */
export function isClientInputError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "ValidationError") return true; // Mongoose
  return isClientInputErrorMessage(err.message);
}

/**
 * Wrap a try/catch in a route handler — if the error is client-input, return
 * a 400 with the message; otherwise return the supplied 5xx fallback. Keeps
 * the handler-level catch idiomatic without per-call branching.
 */
export function errorResponseFromCaught(
  err: unknown,
  fallbackMessage: string,
  fallbackStatus = 500,
): NextResponse {
  if (isClientInputError(err)) {
    return errorResponse(getErrorMessage(err), 400);
  }
  return errorResponse(fallbackMessage, fallbackStatus, getErrorMessage(err));
}

/** Maximum upload file size (10 MB) */
export const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

/**
 * Validates a file upload isn't too large. Returns an error response if it is.
 */
export function checkFileSize(file: File): NextResponse | null {
  if (file.size > MAX_UPLOAD_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    return errorResponse(
      `File too large (${sizeMB} MB). Maximum upload size is 10 MB.`,
      413,
    );
  }
  return null;
}

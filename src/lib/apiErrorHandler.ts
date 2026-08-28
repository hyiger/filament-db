import { NextResponse } from "next/server";

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
 * True when an error is a MongoDB duplicate-key error (code 11000) — e.g. a
 * `create` that collided with a partial-unique index.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === 11000
  );
}

/** Returns a formatted 409 response for a duplicate-key error, else null. */
export function handleDuplicateKeyError(
  err: unknown,
  entityName: string,
): NextResponse | null {
  if (isDuplicateKeyError(err)) {
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
 * a bare `new URL(...)` constructor failure (e.g. a malformed upstream
 * Location header in src/lib/tdsExtractor.ts) throws just `Invalid URL` —
 * an upstream/bad-gateway failure, not user input, which must NOT be mapped
 * to 400.
 */
export function isClientInputErrorMessage(message: string): boolean {
  return /must be a valid|Disallowed URL scheme|private\/internal address|URL hostname does not resolve|URL has no hostname|Invalid URL:/i.test(message);
}

/**
 * True when an error is a client-input rejection rather than a server fault —
 * Mongoose `ValidationError`, Mongoose `CastError` (a route path param like
 * `{id}` that isn't a parseable ObjectId — GH #202), plus the message shapes
 * in `isClientInputErrorMessage`. Route handlers use it to distinguish
 * 4xx-worthy input rejections from 5xx server faults.
 */
export function isClientInputError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "ValidationError") return true; // Mongoose validators
  if (err.name === "CastError") return true; // Mongoose ObjectId/cast rejections (GH #202)
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

/**
 * GH #504: Mongoose `VersionError` is the optimistic-concurrency signal — two
 * writers raced the same document version. Surface it as 409 so the caller can
 * re-fetch and retry, instead of a generic 500. Returns null when the caller
 * should fall through to its generic-error branch.
 */
export function handleVersionError(err: unknown): NextResponse | null {
  // Match on the name, not instanceof, to avoid importing mongoose into
  // edge-runtime callers; the name survives the framework-internal subclass.
  if (
    err instanceof Error &&
    (err.name === "VersionError" || err.constructor?.name === "VersionError")
  ) {
    return errorResponse(
      "This record was modified by another request. Please retry.",
      409,
    );
  }
  return null;
}

/**
 * GH #519: assert every id in `ids` corresponds to an active (non-trashed)
 * document in `model`. Returns null when every id resolves, else a 400 naming
 * the offending field. The check ignores order and duplicates (counts the
 * deduped `$in` set) — dedupe ids at the route entry so per-route messages
 * match the deduped count.
 */
interface CountableModel {
  countDocuments(filter: Record<string, unknown>): Promise<number> | { exec(): Promise<number> };
}

export async function assertActiveRefs(
  model: CountableModel,
  ids: string[] | undefined,
  fieldLabel: string,
): Promise<NextResponse | null> {
  if (!ids || ids.length === 0) return null;
  const deduped = Array.from(new Set(ids.map(String)));
  const result = model.countDocuments({
    _id: { $in: deduped },
    _deletedAt: null,
  });
  // Both Mongoose Query and a plain Promise resolve to a number — handle
  // either so route-level mocks don't have to fake the .exec() shape.
  const activeCount = await (typeof (result as { exec?: () => Promise<number> }).exec === "function"
    ? (result as { exec(): Promise<number> }).exec()
    : (result as Promise<number>));
  if (activeCount !== deduped.length) {
    return errorResponse(`One or more ${fieldLabel} no longer exist.`, 400);
  }
  return null;
}

/** 24-hex ObjectId shape — kept local so this module stays mongoose-free and
 * edge-safe (see the handleVersionError lazy-import note). */
const SPOOL_OID_RE = /^[a-f0-9]{24}$/i;

/**
 * GH #953: assert a spool's `locationId` references an existing, ACTIVE
 * (non-soft-deleted) Location — a dangling ref (e.g. a mobile offline-queue
 * move replayed after the location was deleted) produces phantom "no location"
 * groups in every location-grouped view. `null`/empty = "no location" and
 * passes. The Location model is injected so this module stays edge-safe.
 * Returns a 400 on a bad/dangling ref, else null.
 */
export async function assertActiveSpoolLocation(
  locationModel: CountableModel,
  locationId: unknown,
): Promise<NextResponse | null> {
  if (locationId === null || locationId === undefined || locationId === "") {
    return null;
  }
  if (typeof locationId !== "string" || !SPOOL_OID_RE.test(locationId)) {
    return errorResponse("Invalid location id", 400);
  }
  const result = locationModel.countDocuments({ _id: locationId, _deletedAt: null });
  const count = await (typeof (result as { exec?: () => Promise<number> }).exec === "function"
    ? (result as { exec(): Promise<number> }).exec()
    : (result as Promise<number>));
  if (count === 0) {
    return errorResponse("The selected location no longer exists.", 400);
  }
  return null;
}

/** Maximum upload file size (10 MB) */
export const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

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

/**
 * GH #676: cap a raw (non-multipart) request body via its Content-Length
 * header BEFORE buffering it with `request.text()`/`.json()`, so a huge body
 * can't drive unbounded memory use. Returns a 413 when the declared length
 * exceeds the limit (default `MAX_UPLOAD_SIZE`), else null. A missing/lying
 * Content-Length isn't caught here — callers that need a hard guarantee
 * should additionally check the buffered length.
 */
export function checkContentLength(
  request: Request,
  max: number = MAX_UPLOAD_SIZE,
): NextResponse | null {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    const sizeMB = (declared / (1024 * 1024)).toFixed(1);
    // Format a sub-megabyte limit in KB — a 64 KB cap used to render as "0 MB".
    const maxLabel =
      max < 1024 * 1024
        ? `${Math.round(max / 1024)} KB`
        : `${(max / (1024 * 1024)).toFixed(0)} MB`;
    return errorResponse(
      `Request body too large (${sizeMB} MB). Maximum is ${maxLabel}.`,
      413,
    );
  }
  return null;
}

/**
 * GH #338: short-circuit a route with a 400 when the body isn't
 * `multipart/form-data` — otherwise `request.formData()` throws and the
 * catch-all maps a client input error to 500. Returns null when multipart.
 */
export function assertMultipartFormData(request: Request): NextResponse | null {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("multipart/form-data")) {
    return errorResponse(
      "Upload the file as multipart/form-data (Content-Type: multipart/form-data with a 'file' field).",
      400,
    );
  }
  return null;
}

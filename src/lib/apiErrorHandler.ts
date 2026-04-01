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

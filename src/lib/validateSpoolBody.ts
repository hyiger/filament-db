/**
 * Validate a spool create/update body from an API request.
 *
 * Background: the spool endpoints use the Mongoose positional `$` update
 * operator when editing an existing spool, which bypasses subdocument
 * validation. POST uses `$push` which also skips per-field validation. So
 * if we don't type-check here, a client sending `{ totalWeight: "abc" }`
 * can persist a non-numeric value that later breaks weight math in the
 * PrusaSlicer spool-check endpoint and the export/import cycle.
 *
 * Returns a discriminated union so routes can narrow cleanly.
 */

export type SpoolValidation =
  | {
      ok: true;
      label?: string;
      totalWeight?: number | null;
      lotNumber?: string | null;
      purchaseDate?: string | null;
      openedDate?: string | null;
      // v1.11 additions
      locationId?: string | null;
      photoDataUrl?: string | null;
      retired?: boolean;
    }
  | { ok: false; error: string };

export interface ValidateOpts {
  /** If true, any missing field is allowed (PUT semantics). Otherwise all
   * fields are optional but must be the right type if present (POST). */
  partial?: boolean;
}

/**
 * Verify a string names a real ISO 8601 calendar date.
 *
 * GH #372 (Codex follow-up): the original implementation used only
 * `isNaN(new Date(s).getTime())`, which silently *normalises* out-of-range
 * inputs — `new Date("2025-02-29")` becomes March 1st rather than failing,
 * so a user typo on a non-leap-year date persisted as a shifted day. Match
 * the YYYY-MM-DD prefix against `Date.UTC`-reconstructed components so any
 * normalisation surfaces as a rejected input. Accepts the two shapes the
 * API actually receives in practice:
 *
 *   - `YYYY-MM-DD`                                  (date-only)
 *   - `YYYY-MM-DDThh:mm[:ss[.SSS]][Z|±hh:mm]`       (full ISO 8601)
 *
 * Anything else (free-form "yesterday", localised "1/15/2025", Unix epoch
 * numbers as strings) is rejected — Mongoose would have coerced these in
 * unpredictable ways downstream.
 */
export function isValidIsoDateString(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Round-trip the date components through a UTC Date. If the input named a
  // day that doesn't exist (Feb 29 outside a leap year, Nov 31, month 13,
  // day 0, etc.), the normalisation shifts at least one component and the
  // round-trip won't match.
  //
  // `setUTCFullYear` is used instead of `Date.UTC(year, ...)` because
  // Date.UTC has a legacy 2-digit-year remap: years 0-99 are silently
  // shifted to 1900-1999, so `Date.UTC(99, 11, 31)` returns 1999-12-31
  // and the regex-matched input `"0099-12-31"` would be wrongly rejected
  // (Codex P3 on PR #375). `setUTCFullYear(year, month, day)` takes the
  // year verbatim regardless of magnitude.
  const reconstructed = new Date(0);
  reconstructed.setUTCFullYear(year, month - 1, day);
  if (
    reconstructed.getUTCFullYear() !== year ||
    reconstructed.getUTCMonth() !== month - 1 ||
    reconstructed.getUTCDate() !== day
  ) {
    return false;
  }
  // If a time portion is present, also confirm the whole string parses
  // (catches bad hours/minutes/offsets like "T25:00Z").
  if (s.length > 10 && isNaN(new Date(s).getTime())) return false;
  // GH #524.2: ECMA-262 allows `T24:00` and `T24:00:00` as aliases for
  // 00:00 of the following day, so `new Date('2025-01-01T24:00:00Z')`
  // returns 2025-01-02 instead of failing. That's a silent +1-day shift
  // a user wouldn't expect. Parse the hour component out of the regex
  // capture and reject 24+ explicitly (every other invalid hour like 25
  // is already caught by the `isNaN` check above).
  if (m[4]) {
    const hourMatch = /^T(\d{2}):/.exec(m[4]);
    if (hourMatch && Number(hourMatch[1]) >= 24) return false;
  }
  return true;
}

/**
 * Validate a single spool `photoDataUrl` value. A 5MB hard cap is a safety
 * net — the UI compresses to ~200KB. The MIME allow-list is intentionally
 * narrow (raster formats only): `image/svg+xml` permits inline <script>
 * tags that would execute if the URL were ever rendered in a context that
 * doesn't treat it as an image (e.g. copied into an <object>), so we
 * reject it even though the current UI only uses <img>.
 *
 * Extracted from `validateSpoolBody` (GH #626) so the embedded-spool write
 * paths (`POST /api/filaments`, `POST /api/filaments/import-atlas`) can
 * enforce the same rules as the dedicated spool routes without duplicating
 * the regex. `undefined` passes through as `undefined` (field absent);
 * empty string normalises to `null` to match validateSpoolBody.
 */
export function validateSpoolPhotoDataUrl(
  value: unknown,
):
  | { ok: true; value: string | null | undefined }
  | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: "photoDataUrl must be a string or null" };
  }
  if (value.length > 5 * 1024 * 1024) {
    return { ok: false, error: "photoDataUrl exceeds 5MB limit" };
  }
  if (
    value !== "" &&
    !/^data:image\/(jpeg|jpg|png|gif|webp|avif|heic|heif);base64,/i.test(value)
  ) {
    return {
      ok: false,
      error: "photoDataUrl must be a JPEG/PNG/GIF/WebP/AVIF/HEIC/HEIF image data URL",
    };
  }
  return { ok: true, value: value === "" ? null : value };
}

export function validateSpoolBody(
  body: unknown,
  opts: ValidateOpts = {},
): SpoolValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be an object" };
  }
  const b = body as Record<string, unknown>;

  const result: SpoolValidation & { ok: true } = { ok: true };

  if (b.label !== undefined) {
    if (typeof b.label !== "string") {
      return { ok: false, error: "label must be a string" };
    }
    result.label = b.label;
  } else if (!opts.partial) {
    // POST: default empty string to match prior behaviour
    result.label = "";
  }

  if (b.totalWeight !== undefined) {
    if (b.totalWeight === null) {
      result.totalWeight = null;
    } else if (typeof b.totalWeight === "number" && Number.isFinite(b.totalWeight)) {
      if (b.totalWeight < 0) {
        return { ok: false, error: "totalWeight must be non-negative" };
      }
      result.totalWeight = b.totalWeight;
    } else {
      return { ok: false, error: "totalWeight must be a finite number or null" };
    }
  } else if (!opts.partial) {
    result.totalWeight = null;
  }

  // lotNumber: free-form string or null.
  if (b.lotNumber !== undefined) {
    if (b.lotNumber === null) {
      result.lotNumber = null;
    } else if (typeof b.lotNumber === "string") {
      result.lotNumber = b.lotNumber;
    } else {
      return { ok: false, error: "lotNumber must be a string or null" };
    }
  }

  // Date fields — string-typed at the API surface (Mongoose casts on save)
  // but the string has to name a real ISO 8601 calendar date. GH #372:
  // pre-fix accepted any string at all, so a bad client could persist
  // "Invalid Date" which then broke downstream consumers (analytics,
  // dashboards, CSV export, sync). Codex follow-up: `new Date(s)` alone
  // also accepts impossible days by silently normalising (Feb 29 in a
  // non-leap year → March 1), so use `isValidIsoDateString` which round-
  // trips the components through Date.UTC.
  for (const field of ["purchaseDate", "openedDate"] as const) {
    if (b[field] !== undefined) {
      if (b[field] === null) {
        result[field] = null;
      } else if (typeof b[field] === "string") {
        if (!isValidIsoDateString(b[field] as string)) {
          return { ok: false, error: `${field} must be a valid ISO date string (YYYY-MM-DD or full ISO 8601) or null` };
        }
        result[field] = b[field] as string;
      } else {
        return { ok: false, error: `${field} must be a string or null` };
      }
    }
  }

  // locationId: string (an ObjectId) or null
  if (b.locationId !== undefined) {
    if (b.locationId === null) {
      result.locationId = null;
    } else if (typeof b.locationId === "string") {
      result.locationId = b.locationId;
    } else {
      return { ok: false, error: "locationId must be a string or null" };
    }
  }

  // photoDataUrl: data URL string or null — MIME allow-list + 5MB cap.
  // The actual rules live in `validateSpoolPhotoDataUrl` above (shared
  // with the embedded-spool write paths since GH #626).
  if (b.photoDataUrl !== undefined) {
    const photo = validateSpoolPhotoDataUrl(b.photoDataUrl);
    if (!photo.ok) {
      return { ok: false, error: photo.error };
    }
    result.photoDataUrl = photo.value as string | null;
  }

  // retired: boolean
  if (b.retired !== undefined) {
    if (typeof b.retired !== "boolean") {
      return { ok: false, error: "retired must be a boolean" };
    }
    result.retired = b.retired;
  }

  return result;
}

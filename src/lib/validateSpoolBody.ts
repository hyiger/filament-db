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

  // Optional string fields — only validated if present.
  for (const field of ["lotNumber", "purchaseDate", "openedDate"] as const) {
    if (b[field] !== undefined) {
      if (b[field] === null) {
        result[field] = null;
      } else if (typeof b[field] === "string") {
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

  // photoDataUrl: data URL string or null. A 5MB hard cap is a safety net —
  // the UI compresses to ~200KB. The MIME allow-list is intentionally
  // narrow (raster formats only): `image/svg+xml` permits inline <script>
  // tags that would execute if the URL were ever rendered in a context
  // that doesn't treat it as an image (e.g. copied into an <object>), so
  // we reject it here even though the current UI only uses <img>.
  if (b.photoDataUrl !== undefined) {
    if (b.photoDataUrl === null) {
      result.photoDataUrl = null;
    } else if (typeof b.photoDataUrl === "string") {
      if (b.photoDataUrl.length > 5 * 1024 * 1024) {
        return { ok: false, error: "photoDataUrl exceeds 5MB limit" };
      }
      if (b.photoDataUrl !== "" &&
          !/^data:image\/(jpeg|jpg|png|gif|webp|avif|heic|heif);base64,/i.test(b.photoDataUrl)) {
        return {
          ok: false,
          error: "photoDataUrl must be a JPEG/PNG/GIF/WebP/AVIF/HEIC image data URL",
        };
      }
      result.photoDataUrl = b.photoDataUrl === "" ? null : b.photoDataUrl;
    } else {
      return { ok: false, error: "photoDataUrl must be a string or null" };
    }
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

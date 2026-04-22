/**
 * Compress an uploaded image file to a JPEG base64 data URL under a target
 * size budget. Runs entirely client-side; we store the result inline on the
 * spool subdocument so there's no file-upload endpoint or storage layer.
 *
 * Strategy:
 *   1. Draw the image to an OffscreenCanvas (or regular canvas fallback)
 *      at a maximum dimension (default 1200px on the longest edge).
 *   2. Encode as JPEG at descending qualities until the result fits
 *      within `maxBytes`. Very rough bound: most spool photos fit
 *      comfortably at q=0.75 / 1200px.
 *
 * Returns null on error or if the browser doesn't support the required
 * APIs (fallback: the caller should surface a "photo upload not supported
 * in this browser" toast).
 */

export interface CompressOpts {
  /** Max size of the longest edge, in px. Default 1200. */
  maxEdge?: number;
  /** Soft upper bound on the encoded payload size, in bytes. Default 200KB. */
  maxBytes?: number;
}

export async function compressImageToDataUrl(
  file: File,
  opts: CompressOpts = {},
): Promise<string | null> {
  const maxEdge = opts.maxEdge ?? 1200;
  const maxBytes = opts.maxBytes ?? 200 * 1024;

  if (typeof window === "undefined") return null;

  // Read the source file into an HTMLImageElement via object URL. Using
  // createImageBitmap would be faster but has patchy support in older
  // Electron builds; the image element fallback is universally safe.
  const bitmap = await loadImage(file);
  if (!bitmap) return null;

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // White background so transparent PNGs don't become black JPEGs.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);

  // Try descending qualities. If even q=0.3 is too large, return whatever
  // we got — caller can warn but still save.
  const qualities = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
  let best: string | null = null;
  for (const q of qualities) {
    const dataUrl = canvas.toDataURL("image/jpeg", q);
    best = dataUrl;
    if (dataUrlSizeBytes(dataUrl) <= maxBytes) return dataUrl;
  }
  return best;
}

function loadImage(file: File): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** Approximate decoded size of a base64 data URL payload. */
export function dataUrlSizeBytes(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx < 0) return dataUrl.length;
  const b64 = dataUrl.slice(commaIdx + 1);
  // base64 → bytes: (len * 3/4) minus padding
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

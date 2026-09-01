/**
 * Server-side label bitmap renderer for the Brother PT-P710BT pipeline.
 *
 * Companion to `src/lib/labelBitmap.ts`, which does the same pixel
 * composition in the BROWSER via HTMLCanvasElement. This module is the
 * Node-side twin: it composes with `sharp` so the same label can be
 * rendered where there is no DOM — the CLI (`scripts/print-label.ts`) and
 * the loopback-gated print API (`src/app/api/labels/print`). Both twins
 * feed the SAME wire encoder (`packGrayscaleBitmap()` → `encodeLabel()`),
 * which is what keeps them honest about the byte format.
 *
 * The implementation is lifted VERBATIM from the CLI's own
 * `renderLabelBitmap()` (PR #487, hardware-validated on a real PT-P710BT)
 * so that extracting it changed no bytes. `scripts/print-label.ts` now
 * calls this instead of carrying its own copy.
 *
 * GEOMETRY (24mm tape, 180 dpi)
 *   - Print head: 128 dots tall (PRINT_HEAD_DOTS in labelEncoder.ts).
 *   - Content is composed in human-reading orientation (width = label
 *     length, height = 128) and rotated 90° CW so each output row is one
 *     raster line. The line order is then REVERSED — see #587 below.
 *
 * KNOWN GAP vs. the browser twin: this renderer predates the customizable
 * LabelFormat (GH #592). It always produces the DEFAULT layout — QR left,
 * one bold text line — and honours neither the presets, the font stacks,
 * the vertical text orientation, nor invert. Callers that must match what
 * the app's own dialog previews should render in the renderer instead.
 * Porting `composeLabelLines()` here would close it; it is pure and shared.
 *
 * NOT client-safe: importing `sharp` from a client component would break
 * the browser build. Import this only from route handlers and CLIs.
 */

import sharp from "sharp";
import QRCode from "qrcode";
import { PRINT_HEAD_DOTS } from "./labelEncoder";

/** Vertical padding above/below content inside the 128-dot print band. */
export const VERTICAL_PADDING_DOTS = 6;
/** Horizontal padding at each end of the printable area. */
export const HORIZONTAL_PADDING_DOTS = 14;
/** Gap between the QR block and the text band, in dots. */
export const QR_TEXT_GAP_DOTS = 12;
/** QR spec requires a 4-module quiet zone for reliable scanning. */
const QR_QUIET_ZONE_MODULES = 4;
/** Largest QR footprint that fits the band with padding at both sides. */
const MAX_QR_DOTS = PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS;

export interface ServerLabelInput {
  /** Single text line rendered beside the QR. */
  name: string;
  /** QR payload — a bare instanceId or a deep-link URL. */
  qrPayload: string;
}

export interface ServerLabelRaster {
  /** Row-major 1-byte-per-dot buffer; rows = raster lines, cols = 128. */
  raster: Buffer;
  rasterLines: number;
  /** Always PRINT_HEAD_DOTS; returned so callers can assert. */
  cols: number;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;",
  })[c] as string);
}

/**
 * Render `input` to the raster buffer `packGrayscaleBitmap()` expects.
 *
 * Throws rather than clipping when the QR payload cannot fit the tape —
 * a silently-cropped QR scans as nothing while still looking like a QR,
 * which is the worst possible failure for a printed label.
 */
export async function renderLabelRaster(
  input: ServerLabelInput,
): Promise<ServerLabelRaster> {
  /* --- QR --- */
  // errorCorrectionLevel 'M' is the practical sweet spot for label use:
  // robust against tape scuffs, doesn't bloat short payloads. Probe at
  // scale=1 (quiet zone included) to find the module footprint, then pick
  // the largest integer scale that fits.
  const probePng = await QRCode.toBuffer(input.qrPayload, {
    errorCorrectionLevel: "M",
    margin: QR_QUIET_ZONE_MODULES,
    scale: 1,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  const probeMeta = await sharp(probePng).metadata();
  const widthWithQuietZone = probeMeta.width!;
  if (widthWithQuietZone > MAX_QR_DOTS) {
    throw new Error(
      `QR payload (${input.qrPayload.length} chars) needs ${widthWithQuietZone} dots ` +
        `including the required 4-module quiet zone — exceeds the ` +
        `${MAX_QR_DOTS}-dot budget for 24mm tape.`,
    );
  }
  const qrScale = Math.floor(MAX_QR_DOTS / widthWithQuietZone);
  const qrPng = await QRCode.toBuffer(input.qrPayload, {
    errorCorrectionLevel: "M",
    margin: QR_QUIET_ZONE_MODULES,
    scale: qrScale,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  const qrMeta = await sharp(qrPng).metadata();
  const qrDots = qrMeta.width!; // QR is square

  /* --- text --- */
  // Rendered via SVG so we get crisp output with no antialias artifacts
  // surviving the threshold pass.
  const textHeight = Math.min(56, PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS);
  const fontPx = Math.floor(textHeight * 0.72);
  const svgText = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${textHeight}">
      <text x="0" y="${fontPx}"
            font-family="Helvetica, Arial, sans-serif"
            font-weight="700"
            font-size="${fontPx}"
            fill="#000000">${escapeXml(input.name)}</text>
    </svg>`;
  const textPng = await sharp(Buffer.from(svgText))
    .threshold(128)
    .trim({ threshold: 250 })
    .png()
    .toBuffer();
  const textMeta = await sharp(textPng).metadata();
  const textWidth = textMeta.width!;

  /* --- compose --- */
  const labelWidthDots =
    HORIZONTAL_PADDING_DOTS + qrDots + QR_TEXT_GAP_DOTS + textWidth + HORIZONTAL_PADDING_DOTS;

  // sharp's `create` requires 3 or 4 channels; we collapse to grayscale
  // at the threshold step below.
  const canvas = sharp({
    create: {
      width: labelWidthDots,
      height: PRINT_HEAD_DOTS,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });

  const qrTop = Math.floor((PRINT_HEAD_DOTS - qrDots) / 2);
  const textTop = Math.floor((PRINT_HEAD_DOTS - textMeta.height!) / 2);

  const composed = await canvas
    .composite([
      { input: qrPng, top: qrTop, left: HORIZONTAL_PADDING_DOTS },
      {
        input: textPng,
        top: textTop,
        left: HORIZONTAL_PADDING_DOTS + qrDots + QR_TEXT_GAP_DOTS,
      },
    ])
    .toColorspace("b-w")
    .png()
    .toBuffer();

  // Rotate 90° CW so each output ROW is one raster line.
  //
  // `.raw()` yields 4-channel RGBA even from a grayscale source because the
  // pipeline still carries alpha; `extractChannel(0)` collapses to exactly
  // one byte per dot so the packing logic can rely on 1 byte = 1 dot.
  const rotated = await sharp(composed)
    .rotate(90)
    .threshold(128)
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rasterLines = rotated.info.height;
  const cols = rotated.info.width;
  /* c8 ignore start -- unreachable internal-consistency asserts. The source
     canvas is created at exactly PRINT_HEAD_DOTS tall and rotated 90°, so
     the width is that constant by construction; extractChannel(0) yields
     exactly one channel; and a raw buffer is width*height by definition.
     They exist so a future geometry change fails loudly here rather than
     emitting a misaligned raster the printer would happily consume. Same
     posture as tsplEncoder.ts's asserts. */
  if (cols !== PRINT_HEAD_DOTS) {
    throw new Error(
      `Internal error: rotated width is ${cols}, expected ${PRINT_HEAD_DOTS}. ` +
        `Did the source canvas height drift from PRINT_HEAD_DOTS?`,
    );
  }
  if (rotated.info.channels !== 1) {
    throw new Error(
      `Internal error: expected 1 channel after extractChannel, got ${rotated.info.channels}`,
    );
  }
  if (rotated.data.length !== rasterLines * cols) {
    throw new Error(
      `Internal error: raw buffer is ${rotated.data.length} bytes, expected ${rasterLines * cols}`,
    );
  }
  /* c8 ignore stop */

  // HARDWARE FIX (#587): emitting raster lines in the rotate-90-CW order
  // prints the label MIRRORED along its length — verified on a real
  // PT-P710BT, where the QR came out unscannable and the text read
  // backwards. The printer's physical feed direction is opposite our
  // raster-line order, so reverse the line order. (Content within each
  // line is untouched; only the feed order changes, which reflects the
  // label along its length and un-mirrors it.)
  // Mirror of the same fix in src/lib/labelBitmap.ts.
  const raster = Buffer.alloc(rotated.data.length);
  for (let r = 0; r < rasterLines; r++) {
    rotated.data.copy(raster, (rasterLines - 1 - r) * cols, r * cols, (r + 1) * cols);
  }

  return { raster, rasterLines, cols };
}

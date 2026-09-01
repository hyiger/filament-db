/**
 * Server-side label bitmap renderer for the Brother PT-P710BT pipeline.
 *
 * Node twin of `src/lib/labelBitmap.ts`, which does the same composition in
 * the BROWSER via HTMLCanvasElement. This one composes with `sharp` so a
 * label can be rendered where there is no DOM — the CLI
 * (`scripts/print-label.ts`) and the print API (`src/app/api/labels/print`).
 *
 * WHAT IS SHARED, AND WHAT IS NOT. Everything that decides what the label
 * SAYS and how it is proportioned is imported from `labelFormat.ts` and used
 * unchanged: `composeWrappedLabelLines` (field selection, presets like
 * `vendorOverType`, per-field wrapping), `FONT_STACKS`, `FONT_SIZE_DOTS`,
 * and the auto-fit math (band / lines, LINE_LEADING). Only the final act of
 * putting ink on pixels differs — canvas `fillText` there, SVG through sharp
 * here — because that step cannot run without a DOM. Keep the geometry
 * constants below in lockstep with labelBitmap.ts; they are the contract
 * that keeps the on-screen preview and the printed tape agreeing.
 *
 * GEOMETRY (24mm tape, 180 dpi)
 *   - Print head 128 dots (PRINT_HEAD_DOTS). Content is composed in
 *     human-reading orientation (width = label length, height = 128), then
 *     rotated 90° CW so each output row is one raster line, and the line
 *     order REVERSED (#587, hardware-verified — feeding in rotate order
 *     prints the label mirrored along its length).
 *
 * NOT client-safe: `sharp` must never reach the browser bundle. Import only
 * from route handlers and CLIs.
 */

import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import QRCode from "qrcode";
import { PRINT_HEAD_DOTS } from "./labelEncoder";
import {
  composeWrappedLabelLines,
  DEFAULT_LABEL_FORMAT,
  FONT_STACKS,
  FONT_SIZE_DOTS,
  type LabelFilament,
  type LabelFormat,
} from "./labelFormat";

/** Vertical padding above/below content inside the 128-dot print band. */
export const VERTICAL_PADDING_DOTS = 6;
/** Horizontal padding at each end of the printable area. */
export const HORIZONTAL_PADDING_DOTS = 14;
/** Gap between the QR block and the text band, in dots. */
export const QR_TEXT_GAP_DOTS = 12;
/** Line box height as a multiple of font px. Mirrors labelBitmap.ts. */
export const LINE_LEADING = 1.18;
/** QR spec requires a 4-module quiet zone for reliable scanning. */
const QR_QUIET_ZONE_MODULES = 4;
/** Cross-axis budget shared by the QR and the stacked text lines. */
const BAND_DOTS = PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS;
/** Floor on auto-fit font size, matching the browser renderer. */
const MIN_FONT_PX = 8;

export interface ServerRenderOpts {
  filament: LabelFilament;
  /** QR payload (instanceId or URL). Ignored when format.qr.enabled is false. */
  qrPayload: string;
  /** Defaults to DEFAULT_LABEL_FORMAT (QR left, name only). */
  format?: LabelFormat;
  /** Defaults to 'M'. */
  qrErrorCorrection?: "L" | "M" | "Q" | "H";
}

export interface ServerLabelRaster {
  /** Row-major 1-byte-per-dot buffer; rows = raster lines, cols = 128. */
  raster: Buffer;
  rasterLines: number;
  /** Always PRINT_HEAD_DOTS; returned so callers can assert. */
  cols: number;
  /** The composed text lines, for logging/telemetry. */
  lines: string[];
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
 * Auto-fit the font so N stacked lines fit the print band.
 * Lifted from labelBitmap.ts's renderTextBlock so both twins shrink alike.
 */
export function fitFontPx(lineCount: number, baseFontPx: number): number {
  if (lineCount <= 0) return baseFontPx;
  const maxLineBox = BAND_DOTS / lineCount;
  return Math.max(MIN_FONT_PX, Math.min(baseFontPx, Math.floor(maxLineBox / LINE_LEADING)));
}

/** Render the QR at the largest integer module scale fitting the band. */
async function renderQrTile(
  payload: string,
  ecc: "L" | "M" | "Q" | "H",
): Promise<{ png: Buffer; dots: number }> {
  const probe = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: ecc,
    margin: QR_QUIET_ZONE_MODULES,
    scale: 1,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  const probeWidth = (await sharp(probe).metadata()).width!;
  if (probeWidth > BAND_DOTS) {
    throw new Error(
      `QR payload (${payload.length} chars) needs ${probeWidth} dots including the ` +
        `required 4-module quiet zone — exceeds the ${BAND_DOTS}-dot budget for 24mm tape.`,
    );
  }
  const scale = Math.floor(BAND_DOTS / probeWidth);
  const png = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: ecc,
    margin: QR_QUIET_ZONE_MODULES,
    scale,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  return { png, dots: (await sharp(png).metadata()).width! };
}

/**
 * Render a label to the raster buffer `packGrayscaleBitmap()` expects.
 *
 * Throws rather than clipping when the QR cannot fit: a cropped QR still
 * looks like a QR but scans as nothing, which is the worst way for a printed
 * label to fail.
 */
export async function renderLabelRaster(
  opts: ServerRenderOpts,
): Promise<ServerLabelRaster> {
  const format = opts.format ?? DEFAULT_LABEL_FORMAT;
  if (format.orientation === "vertical") {
    // The browser twin supports it; this one does not yet. Fail loudly
    // rather than silently printing a horizontal label the caller did not
    // ask for.
    throw new Error(
      "Vertical text orientation is not supported by the server renderer yet — " +
        "print from the app, or use a horizontal format.",
    );
  }

  const lines = composeWrappedLabelLines(opts.filament, format);
  const qrEnabled = format.qr.enabled;
  if (!qrEnabled && lines.length === 0) {
    throw new Error("Nothing to print: the format has no QR and no non-empty text fields.");
  }

  /* --- QR --- */
  let qrPng: Buffer | null = null;
  let qrDots = 0;
  if (qrEnabled) {
    const tile = await renderQrTile(opts.qrPayload, opts.qrErrorCorrection ?? "M");
    qrPng = tile.png;
    qrDots = tile.dots;
  }

  /* --- text block --- */
  // Rendered via SVG so output is crisp with no antialias surviving the
  // threshold pass. Rendered black-on-transparent then trimmed to its ink
  // box, which is what makes the label length follow the text.
  let textPng: Buffer | null = null;
  let textWidth = 0;
  let textHeight = 0;
  if (lines.length > 0) {
    const fontPx = fitFontPx(lines.length, FONT_SIZE_DOTS[format.font.size]);
    const lineBox = Math.ceil(fontPx * LINE_LEADING);
    const blockHeight = lineBox * lines.length;
    const fontStack = FONT_STACKS[format.font.family];
    const tspans = lines
      .map(
        (line, i) =>
          `<text x="0" y="${i * lineBox + lineBox / 2}" dominant-baseline="central" ` +
          `font-family="${escapeXml(fontStack)}" font-weight="700" font-size="${fontPx}" ` +
          `fill="#000000">${escapeXml(line)}</text>`,
      )
      .join("");
    // Oversize canvas + trim: we cannot measure text without a DOM, so let
    // the rasterizer decide the ink extent.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${blockHeight}">${tspans}</svg>`;
    textPng = await sharp(Buffer.from(svg)).threshold(128).trim({ threshold: 250 }).png().toBuffer();
    const meta = await sharp(textPng).metadata();
    textWidth = meta.width!;
    textHeight = meta.height!;
  }

  /* --- compose --- */
  const qrSlot = qrEnabled ? qrDots + QR_TEXT_GAP_DOTS : 0;
  const labelWidthDots =
    HORIZONTAL_PADDING_DOTS + qrSlot + textWidth + HORIZONTAL_PADDING_DOTS;

  // Background honours invert; the QR is always composited as its own
  // white tile so it stays dark-on-light and scannable.
  const bg = format.invert ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  const canvas = sharp({
    create: { width: labelWidthDots, height: PRINT_HEAD_DOTS, channels: 3, background: bg },
  });

  const layers: OverlayOptions[] = [];
  let textLeft = HORIZONTAL_PADDING_DOTS;
  if (qrEnabled && qrPng) {
    const qrLeft =
      format.qr.placement === "left"
        ? HORIZONTAL_PADDING_DOTS
        : HORIZONTAL_PADDING_DOTS + textWidth + QR_TEXT_GAP_DOTS;
    layers.push({ input: qrPng, top: Math.floor((PRINT_HEAD_DOTS - qrDots) / 2), left: qrLeft });
    if (format.qr.placement === "left") textLeft = HORIZONTAL_PADDING_DOTS + qrSlot;
  }
  if (textPng) {
    // Under invert the text tile is negated to white-on-black so it reads
    // against the inverted background.
    const tile = format.invert
      ? await sharp(textPng).negate({ alpha: false }).png().toBuffer()
      : textPng;
    layers.push({
      input: tile,
      top: Math.floor((PRINT_HEAD_DOTS - textHeight) / 2),
      left: textLeft,
    });
  }

  const composed = await canvas.composite(layers).toColorspace("b-w").png().toBuffer();

  // Rotate 90° CW so each output ROW is one raster line. `.raw()` yields
  // 4-channel data even from grayscale because the pipeline carries alpha;
  // extractChannel(0) collapses to exactly one byte per dot.
  const rotated = await sharp(composed)
    .rotate(90)
    .threshold(128)
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rasterLines = rotated.info.height;
  const cols = rotated.info.width;
  /* c8 ignore start -- unreachable internal-consistency asserts. The canvas
     is created at exactly PRINT_HEAD_DOTS tall and rotated 90°, so the width
     is that constant by construction; extractChannel(0) yields one channel;
     a raw buffer is width*height by definition. They exist so a future
     geometry change fails loudly rather than emitting a misaligned raster
     the printer would happily consume. Same posture as tsplEncoder.ts. */
  if (cols !== PRINT_HEAD_DOTS) {
    throw new Error(
      `Internal error: rotated width is ${cols}, expected ${PRINT_HEAD_DOTS}.`,
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

  // HARDWARE FIX (#587): see the module docblock. Reverse the raster-line
  // order so the physical feed direction un-mirrors the label.
  const raster = Buffer.alloc(rotated.data.length);
  for (let r = 0; r < rasterLines; r++) {
    rotated.data.copy(raster, (rasterLines - 1 - r) * cols, r * cols, (r + 1) * cols);
  }

  return { raster, rasterLines, cols, lines };
}

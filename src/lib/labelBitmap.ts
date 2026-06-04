/**
 * Browser-safe label bitmap renderer for the Brother PT-P710BT pipeline.
 *
 * Companion to src/lib/labelEncoder.ts. The encoder is wire-format
 * serialization; this module is pixel composition. It takes a filament + a
 * QR payload + a LabelFormat (src/lib/labelFormat.ts) and returns the
 * row-major grayscale buffer ready to feed `packGrayscaleBitmap()` then
 * `encodeLabel()`, or a preview data URL.
 *
 * No Node deps — uses HTMLCanvasElement and the `qrcode` npm browser entry.
 * The CLI at scripts/print-label.ts uses sharp instead; both share the
 * encoder.
 *
 * GEOMETRY (24mm tape, 180 dpi)
 *   - Print head: 128 dots tall (PRINT_HEAD_DOTS in labelEncoder.ts).
 *   - The label content is composed length × 128 (human-reading
 *     orientation), then rotated 90° clockwise so each output row is one
 *     raster line. The raster-line order is then REVERSED — feeding lines
 *     in rotate-order prints the label mirrored along its length (#587,
 *     hardware-verified).
 *
 * FORMATTING (GH #592)
 *   The QR placement (left/right/off), the stacked text lines, font
 *   family/size, text orientation, and invert (white-on-black) all come
 *   from the LabelFormat. The text composition itself lives in the pure,
 *   unit-tested `composeLabelLines()`.
 */

import QRCode from "qrcode";
import { PRINT_HEAD_DOTS } from "./labelEncoder";
import {
  composeLabelLines,
  FONT_STACKS,
  FONT_SIZE_DOTS,
  type LabelFilament,
  type LabelFormat,
} from "./labelFormat";

/** Horizontal padding (dots, ≈2mm) at each end of the printable area. */
const HORIZONTAL_PADDING_DOTS = 14;
/** Vertical padding above/below content inside the 128-dot print band. */
const VERTICAL_PADDING_DOTS = 6;
/** Gap between the QR and the text band, in dots. */
const QR_TEXT_GAP_DOTS = 12;
/** Largest QR pixel size that fits the print band with vertical padding. */
const MAX_QR_DOTS = PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS; // 116
/** QR spec requires a 4-module quiet zone for reliable scanning. */
const QR_QUIET_ZONE_MODULES = 4;
/** Line leading multiplier (rendered line box height / font px). */
const LINE_LEADING = 1.18;

export interface RenderLabelOpts {
  filament: LabelFilament;
  /** QR payload (instanceId or URL). Ignored when format.qr.enabled is false. */
  qrPayload: string;
  format: LabelFormat;
  /** Defaults to 'M'. */
  qrErrorCorrection?: "L" | "M" | "Q" | "H";
}

export interface RenderedLabel {
  /** Row-major grayscale buffer, one byte per dot (0 black / 255 white).
   *  Length = rasterLines × PRINT_HEAD_DOTS. */
  grayscale: Uint8Array;
  rasterLines: number;
}

function assertDom() {
  if (typeof document === "undefined") {
    throw new Error("label rendering requires a DOM canvas; call it from the renderer.");
  }
}

/** Render the QR at the largest module scale fitting `maxDots` (incl. the
 *  4-module quiet zone). Throws if it doesn't fit even at scale 1. */
async function renderQr(
  payload: string,
  errorCorrection: "L" | "M" | "Q" | "H",
  maxDots: number,
): Promise<HTMLCanvasElement> {
  const probe = document.createElement("canvas");
  await QRCode.toCanvas(probe, payload, {
    errorCorrectionLevel: errorCorrection,
    margin: QR_QUIET_ZONE_MODULES,
    scale: 1,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  const widthWithQuietZone = probe.width;
  if (widthWithQuietZone > maxDots) {
    const modules = widthWithQuietZone - 2 * QR_QUIET_ZONE_MODULES;
    throw new Error(
      `QR payload is too long for 24mm tape — needs ${widthWithQuietZone} dots ` +
        `(incl. the 4-module quiet zone; ${modules} QR modules) but only ${maxDots} fit. ` +
        `Use a shorter payload (the instance ID mode is always safe).`,
    );
  }
  const scale = Math.floor(maxDots / widthWithQuietZone);
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, payload, {
    errorCorrectionLevel: errorCorrection,
    margin: QR_QUIET_ZONE_MODULES,
    scale,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  return canvas;
}

/**
 * Render the (possibly multi-line) text block to its own canvas with black
 * text on a transparent background. Auto-fits the font so the block fits the
 * supplied limits:
 *   - `maxCross` bounds the stacked-line direction (the 128-dot tape width
 *     for horizontal text; the line-length for vertical).
 * Returns null when there are no lines.
 */
function renderTextBlock(
  lines: string[],
  fontStack: string,
  baseFontPx: number,
  orientation: LabelFormat["orientation"],
): HTMLCanvasElement | null {
  if (lines.length === 0) return null;
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("Canvas 2D context unavailable");

  // Available cross dimension (perpendicular to reading direction) is always
  // the 128-dot print band minus padding. For horizontal text the N stacked
  // lines share it; for vertical text each line's WIDTH must fit it.
  const band = PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS;

  let fontPx = baseFontPx;
  if (orientation === "horizontal") {
    // N lines stacked vertically must fit the band.
    const maxLineBox = band / lines.length;
    fontPx = Math.min(fontPx, Math.floor(maxLineBox / LINE_LEADING));
  } else {
    // Vertical: each line reads across the tape, so the WIDEST line's text
    // width must fit the band. Measure at base px, scale down to fit.
    measure.font = `bold ${baseFontPx}px ${fontStack}`;
    const widest = Math.max(1, ...lines.map((l) => measure.measureText(l).width));
    if (widest > band) fontPx = Math.max(8, Math.floor((baseFontPx * band) / widest));
  }
  fontPx = Math.max(8, fontPx);

  const font = `bold ${fontPx}px ${fontStack}`;
  measure.font = font;
  const lineBox = Math.ceil(fontPx * LINE_LEADING);
  const textWidth = Math.max(1, Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width))));
  const blockWidth = textWidth;
  const blockHeight = lineBox * lines.length;

  const canvas = document.createElement("canvas");
  canvas.width = blockWidth;
  canvas.height = blockHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.font = font;
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, i * lineBox + lineBox / 2);
  });
  return canvas;
}

/**
 * Compose the full label (QR + text) into a length × 128 canvas in
 * human-reading orientation. Shared by the bitmap and preview paths so they
 * can never drift. Background + text colors honor `invert`; the QR is always
 * drawn dark-on-light (an inverted QR won't scan).
 */
async function composeLabelCanvas(opts: RenderLabelOpts): Promise<HTMLCanvasElement> {
  assertDom();
  const { filament, qrPayload, format } = opts;
  const ec = opts.qrErrorCorrection ?? "M";

  const qrCanvas =
    format.qr.enabled && qrPayload ? await renderQr(qrPayload, ec, MAX_QR_DOTS) : null;
  const qrDots = qrCanvas ? qrCanvas.width : 0;

  const lines = composeLabelLines(filament, format);
  const baseFontPx = Math.floor(FONT_SIZE_DOTS[format.font.size] / LINE_LEADING);
  const textBlock = renderTextBlock(lines, FONT_STACKS[format.font.family], baseFontPx, format.orientation);

  // The text occupies blockW × blockH; after a 90° rotation (vertical mode)
  // its footprint on the label swaps to blockH × blockW.
  let textFootW = 0;
  let textFootH = 0;
  if (textBlock) {
    if (format.orientation === "horizontal") {
      textFootW = textBlock.width;
      textFootH = textBlock.height;
    } else {
      textFootW = textBlock.height;
      textFootH = textBlock.width;
    }
  }

  // Label length = padding + [QR + gap] + textFootW + padding.
  const qrSlot = qrCanvas ? qrDots + QR_TEXT_GAP_DOTS : 0;
  const labelWidthDots = Math.max(
    qrDots + 2 * HORIZONTAL_PADDING_DOTS, // never narrower than the QR + padding
    HORIZONTAL_PADDING_DOTS + qrSlot + textFootW + HORIZONTAL_PADDING_DOTS,
  );

  const canvas = document.createElement("canvas");
  canvas.width = labelWidthDots;
  canvas.height = PRINT_HEAD_DOTS;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Background.
  ctx.fillStyle = format.invert ? "#000000" : "#FFFFFF";
  ctx.fillRect(0, 0, labelWidthDots, PRINT_HEAD_DOTS);

  // QR — on its own white tile (so it scans even on an inverted label),
  // placed left or right, vertically centered.
  let textLeft = HORIZONTAL_PADDING_DOTS;
  if (qrCanvas) {
    const qrTop = Math.floor((PRINT_HEAD_DOTS - qrDots) / 2);
    const qrLeft =
      format.qr.placement === "left"
        ? HORIZONTAL_PADDING_DOTS
        : labelWidthDots - HORIZONTAL_PADDING_DOTS - qrDots;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(qrLeft, qrTop, qrDots, qrDots);
    ctx.drawImage(qrCanvas, qrLeft, qrTop);
    if (format.qr.placement === "left") textLeft = HORIZONTAL_PADDING_DOTS + qrSlot;
  }

  // Text — recolor the black-on-transparent block to the text color, then
  // composite (rotated 90° for vertical), centered in the remaining space.
  if (textBlock) {
    const colored = recolor(textBlock, format.invert ? "#FFFFFF" : "#000000");
    const regionLeft = format.qr.placement === "right" ? HORIZONTAL_PADDING_DOTS : textLeft;
    const regionWidth = Math.max(textFootW, labelWidthDots - regionLeft - HORIZONTAL_PADDING_DOTS - (format.qr.placement === "right" ? qrSlot : 0));
    const cx = regionLeft + Math.floor((regionWidth - textFootW) / 2);
    const cy = Math.floor((PRINT_HEAD_DOTS - textFootH) / 2);
    if (format.orientation === "horizontal") {
      ctx.drawImage(colored, cx, cy);
    } else {
      // Rotate 90° CW about the footprint's top-left.
      ctx.save();
      ctx.translate(cx + textFootW, cy);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(colored, 0, 0);
      ctx.restore();
    }
  }

  return canvas;
}

/** Return a copy of a black-on-transparent text canvas recolored to `color`. */
function recolor(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  if (color === "#000000") return src;
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(src, 0, 0);
  // Keep the text alpha, swap the color.
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, out.width, out.height);
  return out;
}

/**
 * Render a label to a 1-byte-per-dot grayscale buffer ready for the encoder.
 * Browser-only.
 */
export async function renderLabelBitmap(opts: RenderLabelOpts): Promise<RenderedLabel> {
  const composed = await composeLabelCanvas(opts);
  const labelWidthDots = composed.width;

  // Rotate 90° CW so each output row is one raster line.
  const rotated = document.createElement("canvas");
  rotated.width = PRINT_HEAD_DOTS;
  rotated.height = labelWidthDots;
  const rctx = rotated.getContext("2d");
  if (!rctx) throw new Error("Canvas 2D context unavailable");
  rctx.fillStyle = "#FFFFFF";
  rctx.fillRect(0, 0, PRINT_HEAD_DOTS, labelWidthDots);
  rctx.translate(PRINT_HEAD_DOTS, 0);
  rctx.rotate(Math.PI / 2);
  rctx.drawImage(composed, 0, 0);

  const img = rctx.getImageData(0, 0, PRINT_HEAD_DOTS, labelWidthDots);
  const rasterLines = labelWidthDots;
  const grayscale = new Uint8Array(rasterLines * PRINT_HEAD_DOTS);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
    const lum = img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
    grayscale[j] = lum < 128 ? 0 : 255;
  }

  // HARDWARE FIX (#587): reverse the raster-line order — feeding lines in the
  // rotate order prints the label mirrored along its length. See the module
  // header + scripts/print-label.ts.
  const reversed = new Uint8Array(grayscale.length);
  for (let r = 0; r < rasterLines; r++) {
    reversed.set(
      grayscale.subarray(r * PRINT_HEAD_DOTS, (r + 1) * PRINT_HEAD_DOTS),
      (rasterLines - 1 - r) * PRINT_HEAD_DOTS,
    );
  }
  return { grayscale: reversed, rasterLines };
}

/**
 * Render a human-readable preview (length × 128) — the exact pixels that will
 * print, shown the way a person reads them (before the 90° raster spin).
 */
export async function renderLabelPreviewDataUrl(
  opts: RenderLabelOpts,
): Promise<{ dataUrl: string; widthDots: number; heightDots: number }> {
  const composed = await composeLabelCanvas(opts);
  return {
    dataUrl: composed.toDataURL("image/png"),
    widthDots: composed.width,
    heightDots: composed.height,
  };
}

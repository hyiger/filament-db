/**
 * Browser-safe label bitmap renderer for the Brother PT-P710BT pipeline.
 *
 * Companion to src/lib/labelEncoder.ts. The encoder is wire-format
 * serialization; this module is pixel composition. It takes a filament
 * name + QR payload and returns the row-major grayscale buffer ready
 * to feed to `packGrayscaleBitmap()` and then `encodeLabel()`.
 *
 * No Node deps — uses HTMLCanvasElement, OffscreenCanvas when available,
 * and the `qrcode` npm package's browser entry. Same code runs in the
 * renderer (PrintLabelDialog live preview + print payload) and in the
 * eventual Storybook/test harness.
 *
 * The CLI at scripts/print-label.ts uses sharp instead
 * because Node can't use HTMLCanvas without a polyfill; both paths
 * produce the same wire output because they share the encoder.
 *
 * GEOMETRY (24mm tape, 180 dpi)
 *   - Print head: 128 dots tall (PRINT_HEAD_DOTS in labelEncoder.ts).
 *   - Source canvas is composed as length × 128 (human-reading
 *     orientation) and then rotated 90° clockwise so each output row
 *     is one raster line the printer fires.
 */

import QRCode from "qrcode";
import { PRINT_HEAD_DOTS } from "./labelEncoder";

/** Horizontal padding (in dots, ≈ 2mm at 180 dpi) at each end of the
 *  printable area. Keeps the QR / text off the literal edge. */
const HORIZONTAL_PADDING_DOTS = 14;

/** Vertical padding above/below content inside the 128-dot print band. */
const VERTICAL_PADDING_DOTS = 6;

/** Gap between QR and the text band, in dots. */
const QR_TEXT_GAP_DOTS = 12;

/** Largest QR pixel size that fits the print band with vertical padding.
 *  PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS = 116. */
const MAX_QR_DOTS = PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS;

/** QR specification requires a 4-module quiet zone (the all-white
 *  border) around the data for reliable scanning. We render the QR
 *  with `margin: 4` so the qrcode library includes it, and include
 *  it in the fit calculation. (Codex P2 round 5 on PR #487.) */
const QR_QUIET_ZONE_MODULES = 4;

/**
 * Render the QR at the largest module-pixel scale that fits the print
 * band, accounting for the spec-required 4-module quiet zone on each
 * side. The naive `scale: 3` for any payload >16 chars would overflow
 * once the URL pushes the QR past v10 (≈57 modules → 171 px at scale 3,
 * clipped by the 128-dot head). Probe at scale=1 with margin=4 first
 * to discover total width (modules + 8 quiet-zone), then pick
 * `floor(MAX_QR_DOTS / total)` as the largest fitting scale. Throws
 * if even scale=1 doesn't fit (the payload is genuinely too long for
 * a 24mm tape label). (Codex P2 rounds 4 + 5 on PR #487.)
 */
async function renderQrForTape(
  payload: string,
  errorCorrection: "L" | "M" | "Q" | "H",
): Promise<HTMLCanvasElement> {
  // scale=1 with margin=4 → output width = modules + 2 × 4 = modules + 8.
  const probe = document.createElement("canvas");
  await QRCode.toCanvas(probe, payload, {
    errorCorrectionLevel: errorCorrection,
    margin: QR_QUIET_ZONE_MODULES,
    scale: 1,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  const widthWithQuietZone = probe.width;
  if (widthWithQuietZone > MAX_QR_DOTS) {
    const modules = widthWithQuietZone - 2 * QR_QUIET_ZONE_MODULES;
    throw new Error(
      `QR payload is too long for 24mm tape — would render at ${widthWithQuietZone} ` +
        `dots tall including the required 4-module quiet zone (QR data: ${modules} modules), ` +
        `but the print band is only ${MAX_QR_DOTS} dots after padding. ` +
        `Use a shorter payload (the instance ID mode is always safe) or print to a wider tape.`,
    );
  }
  const scale = Math.floor(MAX_QR_DOTS / widthWithQuietZone);
  const finalCanvas = document.createElement("canvas");
  await QRCode.toCanvas(finalCanvas, payload, {
    errorCorrectionLevel: errorCorrection,
    margin: QR_QUIET_ZONE_MODULES,
    scale,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  return finalCanvas;
}

export interface RenderLabelOpts {
  filamentName: string;
  qrPayload: string;
  /** Defaults to 'M' — the practical sweet spot for label use: robust
   *  against tape scuffs without bloating short payloads. */
  qrErrorCorrection?: "L" | "M" | "Q" | "H";
}

export interface RenderedLabel {
  /** Row-major grayscale buffer, one byte per dot. Length = rasterLines
   *  × PRINT_HEAD_DOTS. Ready for packGrayscaleBitmap(). */
  grayscale: Uint8Array;
  /** Number of raster lines = label length in dots (180 dpi → 70 dots
   *  ≈ 1cm). */
  rasterLines: number;
}

/**
 * Render a single-tape label to a 1-byte-per-dot grayscale buffer.
 *
 * Browser-only — needs DOM canvas. The renderer composes everything in
 * human-reading orientation (length × 128), then rotates 90° to produce
 * the raster-line-major output the printer expects.
 */
export async function renderLabelBitmap(
  opts: RenderLabelOpts,
): Promise<RenderedLabel> {
  if (typeof document === "undefined") {
    throw new Error(
      "renderLabelBitmap requires a DOM canvas; call it from the renderer.",
    );
  }

  /* --- QR --- */
  // Helper picks the largest scale that fits the print band and throws
  // on payloads too long even at scale=1.
  const qrCanvas = await renderQrForTape(
    opts.qrPayload,
    opts.qrErrorCorrection ?? "M",
  );
  const qrDots = qrCanvas.width;

  /* --- text --- */
  // Measure first so we know the label length before allocating the
  // main canvas. Use a sacrificial canvas at the printer's pixel
  // density to keep the metrics honest.
  const textHeight = Math.min(56, PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS);
  // ~24px CSS → ~32 dots at 180 dpi (the same heuristic the spike
  // script uses). Bold sans renders crisply at this scale after
  // threshold.
  const fontPx = Math.floor(textHeight * 0.72);
  const fontSpec = `bold ${fontPx}px Helvetica, Arial, sans-serif`;
  const measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) throw new Error("Canvas 2D context unavailable");
  measureCtx.font = fontSpec;
  const textWidth = Math.ceil(measureCtx.measureText(opts.filamentName).width);

  /* --- compose --- */
  const labelWidthDots =
    HORIZONTAL_PADDING_DOTS +
    qrDots +
    QR_TEXT_GAP_DOTS +
    textWidth +
    HORIZONTAL_PADDING_DOTS;

  const canvas = document.createElement("canvas");
  canvas.width = labelWidthDots;
  canvas.height = PRINT_HEAD_DOTS;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // White background.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, labelWidthDots, PRINT_HEAD_DOTS);

  // QR at left, vertically centred.
  const qrTop = Math.floor((PRINT_HEAD_DOTS - qrDots) / 2);
  ctx.drawImage(qrCanvas, HORIZONTAL_PADDING_DOTS, qrTop);

  // Text band to the right of QR, vertically centred via textBaseline.
  ctx.font = fontSpec;
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "middle";
  ctx.fillText(
    opts.filamentName,
    HORIZONTAL_PADDING_DOTS + qrDots + QR_TEXT_GAP_DOTS,
    Math.floor(PRINT_HEAD_DOTS / 2),
  );

  /* --- rotate + threshold ---
   *
   * Rotate 90° clockwise so each row of the output is one raster line
   * the printer fires. We do this via a second canvas because <canvas>
   * doesn't have a "rotate the whole bitmap" primitive — we transform
   * before drawing the source.
   */
  const rotated = document.createElement("canvas");
  rotated.width = PRINT_HEAD_DOTS;
  rotated.height = labelWidthDots;
  const rctx = rotated.getContext("2d");
  if (!rctx) throw new Error("Canvas 2D context unavailable");
  rctx.fillStyle = "#FFFFFF";
  rctx.fillRect(0, 0, PRINT_HEAD_DOTS, labelWidthDots);
  rctx.translate(PRINT_HEAD_DOTS, 0);
  rctx.rotate(Math.PI / 2);
  rctx.drawImage(canvas, 0, 0);

  // Threshold to pure black/white. Reading raw pixel data + processing
  // in JS is fast at this size (a typical label is ~40k pixels) and
  // sidesteps anti-aliasing artifacts that would survive into the
  // printer as random dot noise.
  const img = rctx.getImageData(0, 0, PRINT_HEAD_DOTS, labelWidthDots);
  const grayscale = new Uint8Array(labelWidthDots * PRINT_HEAD_DOTS);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
    // Standard luminance: 0.299 R + 0.587 G + 0.114 B. After threshold
    // every pixel is either 0 (black) or 255 (white).
    const lum =
      img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
    grayscale[j] = lum < 128 ? 0 : 255;
  }

  return { grayscale, rasterLines: labelWidthDots };
}

/**
 * Render a label preview suitable for showing the user before they
 * print. Returns a *human-readable-orientation* PNG data URL (length ×
 * 128) — i.e. the rotated source canvas before the 90° spin into
 * raster-line orientation. The exact same pixels that will hit the
 * printer, just shown in the orientation a human reads them.
 */
export async function renderLabelPreviewDataUrl(
  opts: RenderLabelOpts,
): Promise<{ dataUrl: string; widthDots: number; heightDots: number }> {
  // Composition is identical to renderLabelBitmap above, minus the
  // rotation step. Duplicates a small amount of code but the alternative
  // (rotating twice — once to print orientation, once back for preview)
  // is the kind of cleverness that introduces bugs.
  if (typeof document === "undefined") {
    throw new Error(
      "renderLabelPreviewDataUrl requires a DOM canvas; call it from the renderer.",
    );
  }

  const qrCanvas = await renderQrForTape(
    opts.qrPayload,
    opts.qrErrorCorrection ?? "M",
  );
  const qrDots = qrCanvas.width;

  const textHeight = Math.min(56, PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS);
  const fontPx = Math.floor(textHeight * 0.72);
  const fontSpec = `bold ${fontPx}px Helvetica, Arial, sans-serif`;
  const measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) throw new Error("Canvas 2D context unavailable");
  measureCtx.font = fontSpec;
  const textWidth = Math.ceil(measureCtx.measureText(opts.filamentName).width);
  const labelWidthDots =
    HORIZONTAL_PADDING_DOTS +
    qrDots +
    QR_TEXT_GAP_DOTS +
    textWidth +
    HORIZONTAL_PADDING_DOTS;

  const canvas = document.createElement("canvas");
  canvas.width = labelWidthDots;
  canvas.height = PRINT_HEAD_DOTS;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, labelWidthDots, PRINT_HEAD_DOTS);
  const qrTop = Math.floor((PRINT_HEAD_DOTS - qrDots) / 2);
  ctx.drawImage(qrCanvas, HORIZONTAL_PADDING_DOTS, qrTop);
  ctx.font = fontSpec;
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "middle";
  ctx.fillText(
    opts.filamentName,
    HORIZONTAL_PADDING_DOTS + qrDots + QR_TEXT_GAP_DOTS,
    Math.floor(PRINT_HEAD_DOTS / 2),
  );

  return {
    dataUrl: canvas.toDataURL("image/png"),
    widthDots: labelWidthDots,
    heightDots: PRINT_HEAD_DOTS,
  };
}

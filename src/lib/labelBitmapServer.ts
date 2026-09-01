/**
 * Server-side label bitmap renderer for the Brother PT-P710BT pipeline.
 *
 * Node twin of `src/lib/labelBitmap.ts`, which does the same composition in
 * the BROWSER via HTMLCanvasElement. This one composes with `sharp` so a
 * label can be rendered where there is no DOM — the CLI
 * (`scripts/print-label.ts`) and the print API (`src/app/api/labels/print`).
 *
 * WHAT IS SHARED, AND WHAT IS NOT. Everything that decides what the label
 * SAYS and how it is proportioned comes from `labelFormat.ts`, which BOTH
 * twins import: `composeWrappedLabelLines` (field selection, presets like
 * `vendorOverType`, per-field wrapping), `FONT_STACKS`, `LINE_LEADING`, and
 * `baseFontPx()` — the size-token-to-font-px derivation. Only the final act of
 * putting ink on pixels differs — canvas `fillText` there, SVG through sharp
 * here — because that step cannot run without a DOM.
 *
 * `baseFontPx()` and `LINE_LEADING` live in labelFormat.ts specifically because
 * they used to be duplicated per renderer, and the duplication drifted: this
 * file passed the raw `FONT_SIZE_DOTS` (a line-box HEIGHT) where the browser
 * divided it by the leading first, so the API printed ~21% larger type than
 * the app's own preview at the default format (GH #1195). Do not re-inline
 * either one. The padding/gap constants below are still per-renderer and must
 * be kept in lockstep with labelBitmap.ts by hand.
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
 *
 * SHARP IS LOADED LAZILY, AND THAT IS DELIBERATE (GH #1195). `sharp` resolves
 * a native binary from `@img/sharp-<platform>-<arch>` at require time and
 * THROWS if the matching package is absent — there is no JS fallback in a
 * packaged build. Three release legs are cross-builds that package the
 * runner's node_modules verbatim (`npmRebuild: false`), so they can ship the
 * wrong arch. With a top-level import that failure happens at MODULE LOAD, so
 * every request — including `dryRun` — dies as an opaque 500 before any
 * handler code runs. Loading inside the render call turns it into one
 * catchable, nameable error the route answers with 501.
 */

import type { OverlayOptions, default as SharpModule } from "sharp";
import QRCode from "qrcode";
import { PRINT_HEAD_DOTS } from "./labelEncoder";
import {
  composeWrappedLabelLines,
  baseFontPx as deriveBaseFontPx,
  DEFAULT_LABEL_FORMAT,
  FONT_STACKS,
  LINE_LEADING,
  type LabelFilament,
  type LabelFormat,
} from "./labelFormat";

/** Vertical padding above/below content inside the 128-dot print band. */
export const VERTICAL_PADDING_DOTS = 6;
/** Horizontal padding at each end of the printable area. */
export const HORIZONTAL_PADDING_DOTS = 14;
/** Gap between the QR block and the text band, in dots. */
export const QR_TEXT_GAP_DOTS = 12;
/** QR spec requires a 4-module quiet zone for reliable scanning. */
const QR_QUIET_ZONE_MODULES = 4;
/** Cross-axis budget shared by the QR and the stacked text lines. */
const BAND_DOTS = PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS;
/** Floor on auto-fit font size, matching the browser renderer. */
const MIN_FONT_PX = 8;
/**
 * Width of the oversize canvas the text block is rasterized onto before being
 * trimmed to its ink box. Without a DOM there is no measureText, so the
 * rasterizer decides the extent. Must stay comfortably wider than any label:
 * text that reaches this edge is CLIPPED, and a trim that removes nothing
 * means no ink was produced at all — both are refused below.
 */
const TEXT_MEASURE_CANVAS_DOTS = 4000;

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

/**
 * Coerce a thrown value to a message. Rejections are not guaranteed to be
 * Errors (a library can throw a string), and losing the underlying reason to
 * "[object Object]" would strip the only diagnostic an operator gets.
 */
export function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Thrown when the requested content cannot physically fit the tape. This is a
 * CALLER problem (too many fields/lines for 24mm), so the route answers 400 —
 * distinct from RendererUnavailableError, which is a build/platform problem.
 */
export class LabelDoesNotFitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabelDoesNotFitError";
  }
}

/**
 * Thrown for a format the server renderer does not implement. Distinct from
 * LabelDoesNotFitError (caller asked for too much) and from
 * RendererUnavailableError (this build cannot render at all): the request is
 * well-formed and the backend is fine, the feature simply is not here yet.
 */
export class RendererCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RendererCapabilityError";
  }
}

/** Thrown when the native image backend cannot be loaded on this build. */
export class RendererUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "Server-side label rendering is unavailable on this build: the native image " +
        "backend (sharp) could not be loaded for this platform/architecture. " +
        "Print from the app instead. " +
        `Underlying error: ${causeMessage(cause)}`,
    );
    this.name = "RendererUnavailableError";
  }
}

let sharpPromise: Promise<typeof SharpModule> | null = null;

/**
 * Resolve `sharp` once, converting a native-binary load failure into a typed
 * error. Cached on success only, so a transient failure can be retried.
 */
async function loadSharp(): Promise<typeof SharpModule> {
  if (!sharpPromise) {
    sharpPromise = import("sharp")
      .then((m) => m.default)
      .catch((err) => {
        sharpPromise = null;
        throw new RendererUnavailableError(err);
      });
  }
  return sharpPromise;
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
  sharp: typeof SharpModule,
  payload: string,
  ecc: "L" | "M" | "Q" | "H",
): Promise<{ png: Buffer; dots: number }> {
  // The encoder itself refuses a payload past QR version 40 capacity, and it
  // throws BEFORE probeWidth exists — so the dot-budget check below would never
  // run and the caller would get a generic 500 instead of the documented 400.
  // Same class of problem (asked for more than fits), so same typed error.
  let probe: Buffer;
  try {
    probe = await QRCode.toBuffer(payload, {
      errorCorrectionLevel: ecc,
      margin: QR_QUIET_ZONE_MODULES,
      scale: 1,
      color: { dark: "#000000", light: "#FFFFFF" },
    });
  } catch (err) {
    throw new LabelDoesNotFitError(
      `QR payload (${payload.length} chars) cannot be encoded: ${causeMessage(err)}`,
    );
  }
  const probeWidth = (await sharp(probe).metadata()).width!;
  if (probeWidth > BAND_DOTS) {
    throw new LabelDoesNotFitError(
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
  const sharp = await loadSharp();
  const format = opts.format ?? DEFAULT_LABEL_FORMAT;
  if (format.orientation === "vertical") {
    // The browser twin supports it; this one does not yet. Fail loudly
    // rather than silently printing a horizontal label the caller did not
    // ask for.
    throw new RendererCapabilityError(
      "Vertical text orientation is not supported by the server renderer yet — " +
        "print from the app, or use a horizontal format.",
    );
  }

  const lines = composeWrappedLabelLines(opts.filament, format);
  const qrEnabled = format.qr.enabled;
  if (!qrEnabled && lines.length === 0) {
    // Reachable with valid input: e.g. lines:["colorName"] on a filament whose
    // colorName is null, with the QR disabled. The request can never succeed
    // without changing the format or the data, so it is a 400 -- a 500 would
    // tell an automated caller to retry forever.
    throw new LabelDoesNotFitError(
      "Nothing to print: the format has no QR and no non-empty text fields.",
    );
  }

  /* --- QR --- */
  let qrPng: Buffer | null = null;
  let qrDots = 0;
  if (qrEnabled) {
    const tile = await renderQrTile(sharp, opts.qrPayload, opts.qrErrorCorrection ?? "M");
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
    const fontPx = fitFontPx(lines.length, deriveBaseFontPx(format.font.size));
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
    // GH #954 / #1195: check the COMPOSED block height, before rasterizing.
    // fitFontPx bottoms out at MIN_FONT_PX, so enough stacked lines exceed the
    // 128-dot print head (13 lines at 8px is 130) and the centering offset
    // below would go negative. Measuring the DECLARED height rather than the
    // trimmed one is deliberate and matches the browser twin, which uses its
    // canvas height: at this size the glyphs can rasterize to nothing at all,
    // so a trimmed measurement collapses to 1x1 and reports "fits" for a label
    // whose text is simply missing.
    if (blockHeight > PRINT_HEAD_DOTS) {
      throw new LabelDoesNotFitError(
        "Label text does not fit the tape at the minimum font size — reduce the " +
          "number of fields/lines or shorten the text.",
      );
    }

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${TEXT_MEASURE_CANVAS_DOTS}" ` +
      `height="${blockHeight}">${tspans}</svg>`;
    textPng = await sharp(Buffer.from(svg)).threshold(128).trim({ threshold: 250 }).png().toBuffer();
    const meta = await sharp(textPng).metadata();
    textWidth = meta.width!;
    textHeight = meta.height!;

    // Two failure modes the trim-based measurement cannot otherwise report,
    // both of which used to print a plausible-looking but wrong label:
    //
    // (a) NO INK. A name of only glyphless characters (a zero-width space is
    //     not stripped by String.trim — it lacks the White_Space property)
    //     rasterizes to nothing, so trim removes NOTHING and hands back the
    //     full measure canvas. That printed a ~59cm stretch of blank tape.
    // (b) CLIPPED. Text that actually reaches the canvas edge has been cut off
    //     silently, so the printed label is missing characters.
    //
    // Both present as "trimmed width == canvas width", so one check covers
    // them; the degenerate 1x1 case is kept as a belt-and-braces guard.
    if (textWidth >= TEXT_MEASURE_CANVAS_DOTS || textWidth <= 1 || textHeight <= 1) {
      throw new LabelDoesNotFitError(
        "Label text could not be rendered — it produced no printable output, or " +
          "is too long for the tape. Shorten the text or reduce the fields/lines.",
      );
    }
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

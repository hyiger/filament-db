/**
 * Brother PT-P710BT label-print spike.
 *
 * Renders a label bitmap (QR code + filament name) and emits the Brother
 * raster command byte stream to a sink. The sink is either a file (default
 * — for use with print-label-sim.ts) or a real printer via the OS print
 * system (`--printer`), which reuses the Electron app's transport
 * (electron/label-printer.ts → CUPS `lp -o raw` / Windows spooler; GH #588).
 *
 * USAGE
 *   # Default: render and write the byte stream to /tmp/label.bin, plus a
 *   # PNG preview to /tmp/label-preview.png
 *   npx tsx scripts/print-label.ts \
 *     --name "Prusament PLA Galaxy Black" \
 *     --qr "https://filament-db.local/filaments/507f1f77bcf86cd799439011"
 *
 *   # Different sink:
 *   npx tsx scripts/print-label.ts --name "ABS" --qr 2acc21072a \
 *     --out ./out/short.bin
 *
 *   # Print for real — pass a CUPS queue name or a usb:// device URI
 *   # (from `lpinfo -v`), or a Windows printer name:
 *   npx tsx scripts/print-label.ts --name "ABS" --qr 2acc21072a \
 *     --printer "usb://Brother/PT-P710BT?serial=000M5G671606"
 *
 * PROTOCOL REFERENCE
 *   Brother PT-E550W/P750W/P710BT Raster Command Reference (PDF):
 *   https://download.brother.com/welcome/docp100064/cv_pte550wp750wp710bt_eng_raster_102.pdf
 *
 * GEOMETRY
 *   Print head: 128 dots wide × 180 dpi. Per raster line = 16 bytes.
 *   On 24mm tape: 128 print dots span ~18mm of the 24mm tape width.
 *   The remaining ~3mm × 2 is the physical margin the printer enforces.
 *   The bitmap we generate is therefore 128 dots tall × N dots long,
 *   where N = label length in dots (180 dpi → 70 dots ≈ 1 cm).
 */

import { writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import QRCode from "qrcode";
import {
  encodeLabel,
  packGrayscaleBitmap,
  PRINT_HEAD_DOTS as ENCODER_PRINT_HEAD_DOTS,
  type TapeWidthMm,
} from "@/lib/labelEncoder";

/* ---------- CLI parsing ----------------------------------------------- */

interface Args {
  name: string;
  qr: string;
  out?: string;
  /** OS print target: a CUPS queue name or a `usb://…` device URI (macOS/
   *  Linux), or a Windows printer name. Routes through the same OS-print
   *  backend the Electron app uses (electron/label-printer.ts). */
  printer?: string;
  preview?: string;
  tapeWidthMm: number; // currently only 24 is supported end-to-end
  autoCut: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    tapeWidthMm: 24,
    autoCut: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--name": out.name = next(); break;
      case "--qr": out.qr = next(); break;
      case "--out": out.out = next(); break;
      // --device kept as a back-compat alias for --printer.
      case "--printer": case "--device": out.printer = next(); break;
      case "--preview": out.preview = next(); break;
      case "--tape": out.tapeWidthMm = parseInt(next(), 10); break;
      case "--no-cut": out.autoCut = false; break;
      case "-h": case "--help":
        console.log(
          "Usage: tsx scripts/print-label.ts --name <text> --qr <payload> [--out <file>|--printer <queue|usb://uri>] [--preview <png>]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (!out.name) throw new Error("--name is required");
  if (!out.qr) throw new Error("--qr is required");
  if (out.out && out.printer) throw new Error("Use --out OR --printer, not both");
  if (!out.out && !out.printer) out.out = "/tmp/label.bin";
  if (out.tapeWidthMm !== 24) {
    throw new Error(`Only 24mm tape supported in spike (got ${out.tapeWidthMm}mm)`);
  }
  return out as Args;
}

/* ---------- bitmap rendering ------------------------------------------ */

/** Re-exported from the encoder so this file's geometry constants stay
 *  in lockstep with what the wire format expects. */
const PRINT_HEAD_DOTS = ENCODER_PRINT_HEAD_DOTS;

/** Side padding inside the printable area, in dots. Keeps the QR /
 *  text off the literal edge of the 18mm printable strip. */
const VERTICAL_PADDING_DOTS = 6;

/** Horizontal padding at the start of the label. */
const HORIZONTAL_PADDING_DOTS = 14;

/** Render the label as a 1-bit raster: rows = raster lines (printer
 *  output direction), cols = print-head dots. Returns the row-major
 *  raw buffer plus dimensions.
 *
 *  The natural way to compose with sharp is the human-readable
 *  orientation: width = label-length-in-dots, height = 128 dots tall.
 *  We rotate 90° at the end so each output row corresponds to one
 *  raster line the printer will fire. */
async function renderLabelBitmap(args: Args): Promise<{
  raster: Buffer;
  rasterLines: number;
  cols: number; // == PRINT_HEAD_DOTS
}> {
  /* --- QR --- */
  // errorCorrectionLevel 'M' is the practical sweet spot for label use:
  // robust against tape scuffs, doesn't bloat short payloads. To match
  // the renderer's labelBitmap.ts behavior, probe at scale=1 (with the
  // spec-required 4-module quiet zone included) to find the total
  // pixel height and pick the largest fitting scale. Payloads too long
  // even at scale=1 throw rather than silently clipping or producing
  // an unscannable code. (Codex P2 rounds 4 + 5 on PR #487.)
  const QR_QUIET_ZONE_MODULES = 4;
  const MAX_QR_DOTS_SPIKE = PRINT_HEAD_DOTS - 12; // 6 padding each side
  const probePng = await QRCode.toBuffer(args.qr, {
    errorCorrectionLevel: "M",
    margin: QR_QUIET_ZONE_MODULES,
    scale: 1,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  const probeMeta = await sharp(probePng).metadata();
  const widthWithQuietZone = probeMeta.width!;
  if (widthWithQuietZone > MAX_QR_DOTS_SPIKE) {
    throw new Error(
      `QR payload (${args.qr.length} chars) needs ${widthWithQuietZone} dots ` +
        `including the required 4-module quiet zone — exceeds the ` +
        `${MAX_QR_DOTS_SPIKE}-dot budget for 24mm tape.`,
    );
  }
  const qrSize = Math.floor(MAX_QR_DOTS_SPIKE / widthWithQuietZone);
  const qrPng = await QRCode.toBuffer(args.qr, {
    errorCorrectionLevel: "M",
    margin: QR_QUIET_ZONE_MODULES,
    scale: qrSize,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  const qrMeta = await sharp(qrPng).metadata();
  const qrDots = qrMeta.width!; // QR is square

  /* --- text --- */
  // The text "band" occupies the remaining label width to the right of
  // the QR. We render it via SVG so we get crisp 1-bit output without
  // antialias artifacts surviving the threshold pass.
  const textHeight = Math.min(56, PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS);
  // Rough heuristic: 24px font in CSS ≈ 32 dots at 180 dpi.
  const fontPx = Math.floor(textHeight * 0.72);
  const escaped = escapeXml(args.name);
  // We don't know the final text-band width yet — we'll measure with
  // sharp by rendering it on an oversize canvas and trimming.
  const svgText = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${textHeight}">
      <text x="0" y="${fontPx}"
            font-family="Helvetica, Arial, sans-serif"
            font-weight="700"
            font-size="${fontPx}"
            fill="#000000">${escaped}</text>
    </svg>`;
  const textPng = await sharp(Buffer.from(svgText))
    .threshold(128)
    .trim({ threshold: 250 }) // strip empty space around the text
    .png()
    .toBuffer();
  const textMeta = await sharp(textPng).metadata();
  const textWidth = textMeta.width!;

  /* --- compose --- */
  // Gap between QR and text.
  const qrTextGap = 12;
  const labelWidthDots =
    HORIZONTAL_PADDING_DOTS + qrDots + qrTextGap + textWidth + HORIZONTAL_PADDING_DOTS;

  // Canvas: 128 dots tall, label-width wide. White background.
  // Sharp's `create` requires 3 or 4 channels (RGB / RGBA); we collapse
  // to grayscale at the threshold step below.
  const canvas = sharp({
    create: {
      width: labelWidthDots,
      height: PRINT_HEAD_DOTS,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });

  // Center QR vertically; center text vertically; both left-padded.
  const qrTop = Math.floor((PRINT_HEAD_DOTS - qrDots) / 2);
  const textTop = Math.floor((PRINT_HEAD_DOTS - textMeta.height!) / 2);

  const composed = await canvas
    .composite([
      { input: qrPng, top: qrTop, left: HORIZONTAL_PADDING_DOTS },
      {
        input: textPng,
        top: textTop,
        left: HORIZONTAL_PADDING_DOTS + qrDots + qrTextGap,
      },
    ])
    .toColorspace("b-w")
    .png()
    .toBuffer();

  // Rotate 90° clockwise so each output ROW is one raster line.
  // After rotation: width = 128 dots (one raster line wide), height = label length.
  //
  // Sharp's `.raw()` will give us 4-channel RGBA EVEN when the source is
  // grayscale, because the pipeline still carries an alpha channel by
  // default. `extractChannel(0)` collapses to exactly one byte per pixel
  // (one of the R/G/B channels, all equal after threshold) so our
  // downstream packing logic can rely on 1 byte = 1 dot.
  const rotated = await sharp(composed)
    .rotate(90)
    .threshold(128)
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rasterLines = rotated.info.height;
  const cols = rotated.info.width;
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

  // HARDWARE FIX (#587): emitting raster lines in the rotate-90-CW order
  // prints the label MIRRORED along its length — verified on a real
  // PT-P710BT, where the QR came out unscannable and the text read
  // backwards. The printer's physical feed direction is opposite our
  // raster-line order, so reverse the line order. (The QR/text content
  // within each line is untouched; only the order the lines feed changes,
  // which reflects the physical label along its length and un-mirrors it.)
  // Mirror of the same fix in src/lib/labelBitmap.ts.
  const raster = Buffer.alloc(rotated.data.length);
  for (let r = 0; r < rasterLines; r++) {
    rotated.data.copy(raster, (rasterLines - 1 - r) * cols, r * cols, (r + 1) * cols);
  }

  return { raster, rasterLines, cols };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;",
  }[c]!));
}

/* ---------- sinks ----------------------------------------------------- */

async function writeToFile(bytes: Buffer, path: string) {
  await fs.mkdir(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`wrote ${bytes.length} bytes → ${path}`);
}

async function writeToPrinter(bytes: Buffer, target: string) {
  // Route through the same OS-print backend the Electron app uses (GH #588)
  // — CUPS `lp -o raw` (macOS/Linux) or the Windows spooler — so the CLI and
  // the app share one transport. The target is a CUPS queue name, a `usb://…`
  // device URI, or a Windows printer name. Dynamic import keeps simulator-only
  // runs (`--out`) from loading the transport at all.
  const { printLabel } = await import("../electron/label-printer");
  await printLabel(target, new Uint8Array(bytes));
  console.log(`sent ${bytes.length} bytes → ${target}`);
}

/* ---------- main ------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { raster, rasterLines, cols } = await renderLabelBitmap(args);
  console.log(
    `rendered label: ${rasterLines} raster lines × ${cols} dots ` +
      `(≈ ${(rasterLines / 7.087).toFixed(1)}mm long)`,
  );

  // Pack the grayscale row-major bitmap into the encoder's 1-bit packed
  // format, then serialize per Brother's raster command set. Both helpers
  // live in src/lib/labelEncoder.ts so the dialog and the CLI share the
  // same source of truth.
  const packed = packGrayscaleBitmap(new Uint8Array(raster), rasterLines);
  const bytes = Buffer.from(
    encodeLabel({
      bitmap: packed,
      rasterLines,
      tapeWidthMm: args.tapeWidthMm as TapeWidthMm,
      autoCut: args.autoCut,
    }),
  );

  // Also write a PNG preview so the user can eyeball the bitmap without
  // running the simulator. Default location next to --out, or /tmp.
  const previewPath =
    args.preview ?? (args.out ? args.out.replace(/\.bin$/, "-preview.png") : "/tmp/label-preview.png");
  await sharp(raster, {
    raw: { width: cols, height: rasterLines, channels: 1 },
  })
    .threshold(128)
    .png()
    .toFile(previewPath);
  console.log(`preview PNG → ${previewPath}`);

  if (args.printer) {
    await writeToPrinter(bytes, args.printer);
  } else {
    await writeToFile(bytes, args.out!);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

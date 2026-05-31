/**
 * Brother PT-P710BT label-print spike.
 *
 * Renders a label bitmap (QR code + filament name) and emits the Brother
 * raster command byte stream to a sink. The sink is either a file (default
 * — for use with print-label-sim.ts) or a serial-port device path (when
 * the real printer is paired and you're ready to send it for real).
 *
 * The code path is identical for both sinks — only the destination
 * changes. So once the simulator round-trip looks right, the Tuesday
 * "plug in the real printer" step is just `--device /dev/tty.PT-P710BT-...`.
 *
 * USAGE
 *   # Default: render and write the byte stream to /tmp/label.bin, plus a
 *   # PNG preview to /tmp/label-preview.png
 *   npx tsx scripts/print-label-spike.ts \
 *     --name "Prusament PLA Galaxy Black" \
 *     --qr "https://filament-db.local/filaments/507f1f77bcf86cd799439011"
 *
 *   # Different sink:
 *   npx tsx scripts/print-label-spike.ts --name "ABS" --qr 2acc21072a \
 *     --out ./out/short.bin
 *
 *   # Tuesday — when the real printer arrives:
 *   npx tsx scripts/print-label-spike.ts --name "ABS" --qr 2acc21072a \
 *     --device /dev/tty.PT-P710BT-XXXX-Serialport
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

/* ---------- CLI parsing ----------------------------------------------- */

interface Args {
  name: string;
  qr: string;
  out?: string;
  device?: string;
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
      case "--device": out.device = next(); break;
      case "--preview": out.preview = next(); break;
      case "--tape": out.tapeWidthMm = parseInt(next(), 10); break;
      case "--no-cut": out.autoCut = false; break;
      case "-h": case "--help":
        console.log(
          "Usage: tsx scripts/print-label-spike.ts --name <text> --qr <payload> [--out <file>|--device <path>] [--preview <png>]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (!out.name) throw new Error("--name is required");
  if (!out.qr) throw new Error("--qr is required");
  if (out.out && out.device) throw new Error("Use --out OR --device, not both");
  if (!out.out && !out.device) out.out = "/tmp/label.bin";
  if (out.tapeWidthMm !== 24) {
    throw new Error(`Only 24mm tape supported in spike (got ${out.tapeWidthMm}mm)`);
  }
  return out as Args;
}

/* ---------- bitmap rendering ------------------------------------------ */

/** Brother print head height in dots. Same for 12mm and 24mm tape — the
 *  difference is how many of those dots are actually addressable on the
 *  narrower tape. 24mm uses the full 128. */
const PRINT_HEAD_DOTS = 128;

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
  // robust against tape scuffs, doesn't bloat short payloads. 'scale' is
  // module size in pixels; we pick by payload length so a tiny instanceId
  // produces a tiny QR and a long URL still fits the tape height.
  const qrSize = args.qr.length <= 16 ? 4 : 3;
  const qrPng = await QRCode.toBuffer(args.qr, {
    errorCorrectionLevel: "M",
    margin: 0,
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

  return { raster: rotated.data, rasterLines, cols };
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

/* ---------- bitmap → raster bytes ------------------------------------- */

/** Pack one raster line (128 dots, one byte = one pixel from sharp's raw
 *  grayscale buffer) into 16 bytes (1 bit per dot, MSB-first, black = 1). */
function packRasterLine(grayRow: Buffer): Buffer {
  if (grayRow.length !== PRINT_HEAD_DOTS) {
    throw new Error(`Raster row length ${grayRow.length} != ${PRINT_HEAD_DOTS}`);
  }
  const packed = Buffer.alloc(16);
  for (let dotIdx = 0; dotIdx < PRINT_HEAD_DOTS; dotIdx++) {
    const black = grayRow[dotIdx] < 128 ? 1 : 0;
    if (black) {
      const byteIdx = dotIdx >> 3;
      const bitInByte = 7 - (dotIdx & 7); // MSB first
      packed[byteIdx] |= 1 << bitInByte;
    }
  }
  return packed;
}

/* ---------- Brother raster command encoding --------------------------- */

/** Concatenate Buffers — small helper to keep the encoder readable. */
function concat(...parts: (Buffer | number[])[]): Buffer {
  return Buffer.concat(
    parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))),
  );
}

/** Build the complete byte stream for one label.
 *
 *  Sequence per Brother Raster Command Reference §2 — every byte is
 *  cited inline. The PT-P710BT supports both compressed (M=02 packbits)
 *  and uncompressed (M=00) modes; uncompressed is simpler and 128 dots
 *  per line is small enough that compression isn't worth the bug surface. */
function encodeRaster(opts: {
  raster: Buffer;
  rasterLines: number;
  tapeWidthMm: number;
  autoCut: boolean;
}): Buffer {
  const parts: (Buffer | number[])[] = [];

  // 1. Invalidate (clear any half-finished command in the printer's buffer).
  //    Reference impls use 100 bytes of 0x00; 64 is the documented minimum.
  parts.push(Buffer.alloc(100, 0x00));

  // 2. Initialize: ESC @
  parts.push([0x1b, 0x40]);

  // 3. Switch to raster mode: ESC i a <mode>. mode=01 = raster.
  parts.push([0x1b, 0x69, 0x61, 0x01]);

  // 4. Print info: ESC i z <flags> <media> <width-mm> <length-mm>
  //                       <n3-n6 raster line count, LE u32>
  //                       <starting-page> <00>
  //    flags = 0x84 = "validity flags for media type + width + line count"
  //    media = 0x01 = laminated tape (the only kind PT-P710BT takes)
  //    length-mm = 0x00 means "auto length from raster count"
  const linesLE = Buffer.alloc(4);
  linesLE.writeUInt32LE(opts.rasterLines, 0);
  parts.push(
    [
      0x1b, 0x69, 0x7a,
      0x84,                  // flags: validity (type|width|length)
      0x01,                  // media type: laminated
      opts.tapeWidthMm,      // width in mm (24 = 0x18)
      0x00,                  // length in mm (0 = auto)
    ],
    linesLE,
    [0x00, 0x00],            // page 0, reserved
  );

  // 5. Mode bits: ESC i M <mode>. 0x40 enables auto-cut at end of job.
  parts.push([0x1b, 0x69, 0x4d, opts.autoCut ? 0x40 : 0x00]);

  // 6. Expansion mode: ESC i K <flags>. 0x00 = no chain printing, no half-cut.
  parts.push([0x1b, 0x69, 0x4b, 0x00]);

  // 7. Margin (feed amount before print): ESC i d <n1 n2> (dots, LE).
  //    14 dots ≈ 2mm — the documented minimum for clean tape feed.
  parts.push([0x1b, 0x69, 0x64, 0x0e, 0x00]);

  // 8. Compression: M <mode>. 00 = uncompressed (our choice).
  parts.push([0x4d, 0x00]);

  // 9. Raster lines: G <n1 n2> <16 data bytes> per line.
  //    n1 n2 = LE byte count (always 16 for uncompressed full-width line).
  for (let lineIdx = 0; lineIdx < opts.rasterLines; lineIdx++) {
    const row = opts.raster.subarray(
      lineIdx * PRINT_HEAD_DOTS,
      (lineIdx + 1) * PRINT_HEAD_DOTS,
    );
    const packed = packRasterLine(Buffer.from(row));
    parts.push([0x47, 0x10, 0x00], packed);
  }

  // 10. Print + feed/cut: 1A = print with feed (and cut if autoCut bit set).
  //     0C = print without feed (for chain printing — not used here).
  parts.push([0x1a]);

  return concat(...parts);
}

/* ---------- sinks ----------------------------------------------------- */

async function writeToFile(bytes: Buffer, path: string) {
  await fs.mkdir(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`wrote ${bytes.length} bytes → ${path}`);
}

async function writeToDevice(bytes: Buffer, devicePath: string) {
  // We don't import `serialport` at the top of the file because it's not
  // installed in the spike's dependency set yet — only needed Tuesday.
  // Dynamic import gives a clear error if absent rather than blowing up
  // every simulator-only run.
  let SerialPortModule;
  try {
    SerialPortModule = await import("serialport");
  } catch {
    throw new Error(
      "`serialport` is not installed. Run `npm install --save-dev serialport` " +
        "before using --device.",
    );
  }
  const port = new SerialPortModule.SerialPort({
    path: devicePath,
    baudRate: 9600, // SPP/RFCOMM ignores baud rate but the API requires it
  });
  await new Promise<void>((resolve, reject) => {
    port.on("open", () => resolve());
    port.on("error", reject);
  });
  await new Promise<void>((resolve, reject) =>
    port.write(bytes, (err) => (err ? reject(err) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    port.drain((err) => (err ? reject(err) : resolve())),
  );
  await new Promise<void>((resolve) => port.close(() => resolve()));
  console.log(`wrote ${bytes.length} bytes → ${devicePath}`);
}

/* ---------- main ------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { raster, rasterLines, cols } = await renderLabelBitmap(args);
  console.log(
    `rendered label: ${rasterLines} raster lines × ${cols} dots ` +
      `(≈ ${(rasterLines / 7.087).toFixed(1)}mm long)`,
  );

  const bytes = encodeRaster({
    raster,
    rasterLines,
    tapeWidthMm: args.tapeWidthMm,
    autoCut: args.autoCut,
  });

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

  if (args.device) {
    await writeToDevice(bytes, args.device);
  } else {
    await writeToFile(bytes, args.out!);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

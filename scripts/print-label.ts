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
import {
  encodeLabel,
  packGrayscaleBitmap,
  type TapeWidthMm,
} from "@/lib/labelEncoder";
import { renderLabelRaster } from "@/lib/labelBitmapServer";

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

/* Lifted to src/lib/labelBitmapServer.ts (GH #1195) so the print API route
 * and this CLI share ONE server-side renderer. The implementation moved
 * verbatim — byte-for-byte identical output — and `renderLabelRaster` is
 * the same function this file used to define inline as
 * `renderLabelBitmap()`. Geometry constants live there too. */

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

  const { raster, rasterLines, cols } = await renderLabelRaster({
    filament: { name: args.name },
    qrPayload: args.qr,
  });
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

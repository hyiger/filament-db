/**
 * Brother PT-P710BT label-print simulator.
 *
 * Companion to print-label.ts. Reads a Brother raster command
 * byte stream, decodes every command, validates structure, reconstructs
 * the bitmap, and writes a preview PNG so you can verify what would
 * have come out of the printer.
 *
 * USAGE
 *   # Decode the file the spike just wrote, write decoded.png next to it
 *   npx tsx scripts/print-label-sim.ts --in /tmp/label.bin
 *
 *   # Custom output, verbose command trace
 *   npx tsx scripts/print-label-sim.ts --in /tmp/label.bin \
 *     --out /tmp/decoded.png --verbose
 *
 * WHAT GETS CHECKED
 *   - Invalidate prefix (≥ 64 × 0x00)
 *   - Initialize: 0x1B 0x40
 *   - Raster mode: 0x1B 0x69 0x61 0x01
 *   - Print info: 0x1B 0x69 0x7A + 10 bytes (tape width must = 24)
 *   - Mode bits / expansion / margin / compression
 *   - Raster lines: G + LE length + payload, total count matches print info
 *   - Terminator: 0x1A (print + cut) or 0x0C (print no cut)
 *
 *  Exits non-zero if any check fails — useful for CI down the road.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";

interface Args {
  in: string;
  out?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--in": out.in = next(); break;
      case "--out": out.out = next(); break;
      case "--verbose": case "-v": out.verbose = true; break;
      case "-h": case "--help":
        console.log("Usage: tsx scripts/print-label-sim.ts --in <file.bin> [--out <preview.png>] [--verbose]");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (!out.in) throw new Error("--in is required");
  return out as Args;
}

/* ---------- decoder --------------------------------------------------- */

const PRINT_HEAD_DOTS = 128;

interface DecodeResult {
  warnings: string[];
  printInfo: {
    tapeWidthMm: number;
    rasterLineCount: number;
    mediaType: number;
  };
  autoCut: boolean;
  compression: number;
  rasterLines: Buffer[]; // each = 128 dots wide, expanded to 1 byte / dot (grayscale)
  trailer: "cut" | "no-cut" | "unknown";
}

class StreamReader {
  constructor(public buf: Buffer, public pos = 0) {}
  remaining() { return this.buf.length - this.pos; }
  peek(n: number) { return this.buf.subarray(this.pos, this.pos + n); }
  read(n: number) {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u8() { return this.buf[this.pos++]; }
  u16le() {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u32le() {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  matches(seq: number[]) {
    if (this.remaining() < seq.length) return false;
    for (let i = 0; i < seq.length; i++) {
      if (this.buf[this.pos + i] !== seq[i]) return false;
    }
    return true;
  }
  expect(seq: number[], label: string) {
    if (!this.matches(seq)) {
      throw new Error(
        `Expected ${label} (${seq.map((b) => `0x${b.toString(16)}`).join(" ")}) ` +
          `at offset ${this.pos}, got ${this.peek(seq.length).toString("hex")}`,
      );
    }
    this.pos += seq.length;
  }
}

function trace(verbose: boolean, msg: string) {
  if (verbose) console.log(`  ${msg}`);
}

function decode(bytes: Buffer, verbose: boolean): DecodeResult {
  const warnings: string[] = [];
  const r = new StreamReader(bytes);

  // 1. Invalidate prefix — count leading 0x00 bytes.
  let zeros = 0;
  while (r.remaining() > 0 && r.buf[r.pos] === 0x00) {
    zeros++;
    r.pos++;
  }
  trace(verbose, `invalidate prefix: ${zeros} × 0x00`);
  if (zeros < 64) warnings.push(`invalidate prefix is only ${zeros} bytes, recommended ≥ 64`);

  // 2. Initialize: ESC @
  r.expect([0x1b, 0x40], "ESC @ (initialize)");
  trace(verbose, "initialize (ESC @)");

  // 3. Switch to raster mode: ESC i a 01
  r.expect([0x1b, 0x69, 0x61, 0x01], "ESC i a 01 (raster mode)");
  trace(verbose, "switch to raster mode");

  // 4. Print info: ESC i z + 10 bytes
  r.expect([0x1b, 0x69, 0x7a], "ESC i z (print info)");
  const flags = r.u8();
  const mediaType = r.u8();
  const tapeWidthMm = r.u8();
  const tapeLengthMm = r.u8();
  const rasterLineCount = r.u32le();
  const startingPage = r.u8();
  const reserved = r.u8();
  trace(
    verbose,
    `print info: flags=0x${flags.toString(16)} media=0x${mediaType.toString(16)} ` +
      `width=${tapeWidthMm}mm length=${tapeLengthMm}mm lines=${rasterLineCount} ` +
      `page=${startingPage} reserved=${reserved}`,
  );
  if (tapeWidthMm !== 24) warnings.push(`tape width is ${tapeWidthMm}mm, spike expects 24`);
  if (mediaType !== 0x01) warnings.push(`media type is 0x${mediaType.toString(16)}, expected 0x01 (laminated)`);

  // 5. Mode bits: ESC i M
  r.expect([0x1b, 0x69, 0x4d], "ESC i M (mode)");
  const modeBits = r.u8();
  const autoCut = (modeBits & 0x40) !== 0;
  trace(verbose, `mode bits: 0x${modeBits.toString(16)} (auto-cut ${autoCut ? "ON" : "OFF"})`);

  // 6. Expansion: ESC i K
  r.expect([0x1b, 0x69, 0x4b], "ESC i K (expansion)");
  const expansion = r.u8();
  trace(verbose, `expansion: 0x${expansion.toString(16)}`);

  // 7. Margin: ESC i d
  r.expect([0x1b, 0x69, 0x64], "ESC i d (margin)");
  const margin = r.u16le();
  trace(verbose, `margin: ${margin} dots`);

  // 8. Compression: M
  r.expect([0x4d], "M (compression mode)");
  const compression = r.u8();
  trace(verbose, `compression: 0x${compression.toString(16)} (${compression === 0 ? "uncompressed" : compression === 2 ? "packbits" : "unknown"})`);
  if (compression !== 0 && compression !== 2) {
    warnings.push(`unrecognized compression mode 0x${compression.toString(16)}`);
  }
  if (compression === 2) {
    warnings.push("packbits decoding not implemented in this simulator — bitmap will be wrong");
  }

  // 9. Raster lines: G + LE length + payload, repeated.
  const rasterLines: Buffer[] = [];
  while (r.remaining() > 0 && r.buf[r.pos] === 0x47) {
    r.pos++; // consume G
    const len = r.u16le();
    if (len > r.remaining()) {
      throw new Error(`Raster line ${rasterLines.length} claims ${len} bytes but only ${r.remaining()} remain`);
    }
    const payload = Buffer.from(r.read(len)); // copy out of the shared buf
    // Expand 1-bit-per-pixel MSB-first into 1-byte-per-pixel grayscale.
    const grayscale = Buffer.alloc(PRINT_HEAD_DOTS, 255);
    const dotsThisLine = Math.min(PRINT_HEAD_DOTS, len * 8);
    for (let dotIdx = 0; dotIdx < dotsThisLine; dotIdx++) {
      const byteIdx = dotIdx >> 3;
      const bitInByte = 7 - (dotIdx & 7);
      const bit = (payload[byteIdx] >> bitInByte) & 1;
      grayscale[dotIdx] = bit ? 0 : 255;
    }
    rasterLines.push(grayscale);
  }
  trace(verbose, `decoded ${rasterLines.length} raster lines`);
  if (rasterLines.length !== rasterLineCount) {
    warnings.push(
      `raster line count mismatch: header declared ${rasterLineCount}, payload contained ${rasterLines.length}`,
    );
  }

  // 10. Terminator.
  let trailer: "cut" | "no-cut" | "unknown" = "unknown";
  if (r.remaining() > 0) {
    const term = r.u8();
    if (term === 0x1a) {
      trailer = "cut";
      trace(verbose, "trailer: 0x1A (print + cut)");
    } else if (term === 0x0c) {
      trailer = "no-cut";
      trace(verbose, "trailer: 0x0C (print, no cut)");
    } else {
      warnings.push(`trailer byte 0x${term.toString(16)} not recognized (expected 0x1A or 0x0C)`);
    }
    if (r.remaining() > 0) {
      warnings.push(`${r.remaining()} unexpected trailing bytes after terminator`);
    }
  } else {
    warnings.push("no terminator byte — printer would never fire the page");
  }

  return {
    warnings,
    printInfo: { tapeWidthMm, rasterLineCount, mediaType },
    autoCut,
    compression,
    rasterLines,
    trailer,
  };
}

/* ---------- render preview ------------------------------------------- */

async function writePreview(rasterLines: Buffer[], outPath: string) {
  if (rasterLines.length === 0) {
    throw new Error("no raster lines decoded — refusing to write empty preview");
  }
  // Same orientation the printer prints in: each raster line is one
  // 128-dot-wide row in the output direction. To get a human-readable
  // preview (label running left to right) we rotate -90° (sharp accepts
  // 270° too).
  const concatenated = Buffer.concat(rasterLines);
  await fs.mkdir(dirname(outPath), { recursive: true });
  await sharp(concatenated, {
    raw: { width: PRINT_HEAD_DOTS, height: rasterLines.length, channels: 1 },
  })
    .rotate(-90)
    .png()
    .toFile(outPath);
}

/* ---------- main ------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bytes = readFileSync(args.in);
  console.log(`read ${bytes.length} bytes from ${args.in}`);

  const decoded = decode(bytes, args.verbose);

  console.log("");
  console.log("=== command stream summary ===");
  console.log(`  tape width: ${decoded.printInfo.tapeWidthMm}mm`);
  console.log(`  media type: 0x${decoded.printInfo.mediaType.toString(16).padStart(2, "0")}`);
  console.log(`  raster lines: ${decoded.rasterLines.length}`);
  console.log(`  label length: ≈ ${(decoded.rasterLines.length / 7.087).toFixed(1)}mm`);
  console.log(`  auto-cut: ${decoded.autoCut}`);
  console.log(`  compression: ${decoded.compression === 0 ? "none" : `0x${decoded.compression.toString(16)}`}`);
  console.log(`  trailer: ${decoded.trailer}`);

  const outPath = args.out ?? args.in.replace(/\.bin$/, "-decoded.png");
  await writePreview(decoded.rasterLines, outPath);
  console.log(`\nwrote preview → ${outPath}`);

  if (decoded.warnings.length > 0) {
    console.log("\n⚠ warnings:");
    for (const w of decoded.warnings) console.log(`  - ${w}`);
    process.exit(2);
  }
  console.log("\n✓ command stream looks valid");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

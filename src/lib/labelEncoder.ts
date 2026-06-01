/**
 * Brother PT-P710BT raster command encoder.
 *
 * Pure JavaScript / TypeScript, no Node or browser dependencies — usable
 * from both the Electron main process (over a serial port) and the
 * renderer (for download-fallback when not running in Electron) and
 * from the standalone CLI in `scripts/print-label.ts`.
 *
 * The encoder takes a row-major **1-bit-per-pixel** bitmap as a packed
 * Uint8Array — one bit per print dot, MSB-first across each row, exactly
 * 16 bytes (128 dots) per raster line — and wraps it in the byte stream
 * the printer expects. The caller is responsible for rendering the
 * bitmap; this module only handles serialization.
 *
 * PROTOCOL REFERENCE
 *   Brother PT-E550W/P750W/P710BT Software Developer's Manual,
 *   "Raster Command Reference" (cv_pte550wp750wp710bt_eng_raster_102.pdf).
 *
 * BITMAP CONTRACT
 *   - `bitmap` is row-major: row 0 is the first raster line printed.
 *   - Each row is exactly `BYTES_PER_RASTER_LINE` (= 16) bytes.
 *   - Bit 7 of byte 0 is the leftmost dot of the print head; bit 0 of
 *     byte 15 is the rightmost dot. Black = 1, white = 0.
 *   - `bitmap.length` must be `rasterLines * BYTES_PER_RASTER_LINE`.
 *
 * Callers rendering from a grayscale buffer should use the
 * `packGrayscaleRow` helper below, which handles the threshold + bit
 * packing.
 */

/** Brother PT-series print head: 128 dots × 180 dpi. The same for every
 *  TZe tape width; narrower tapes simply mask off dots at the edges. */
export const PRINT_HEAD_DOTS = 128;

/** 128 dots ÷ 8 bits/byte = 16 bytes per raster line (uncompressed). */
export const BYTES_PER_RASTER_LINE = PRINT_HEAD_DOTS / 8;

/** Tape widths the printer accepts (mm). Brother accepts 3.5 / 6 / 9 /
 *  12 / 18 / 24; the print info command's media-width byte takes the
 *  width in mm verbatim. */
export type TapeWidthMm = 3.5 | 6 | 9 | 12 | 18 | 24;

export interface EncodeOpts {
  /** Row-major packed 1-bit bitmap. See BITMAP CONTRACT above. */
  bitmap: Uint8Array;
  /** Number of raster lines in the bitmap. `bitmap.length` must equal
   *  `rasterLines * BYTES_PER_RASTER_LINE`. */
  rasterLines: number;
  /** Tape width in mm. Currently the project only exercises 24mm
   *  end-to-end, but the encoder accepts all six standard widths. */
  tapeWidthMm: TapeWidthMm;
  /** When true (default), emit mode bit 0x40 + terminator 0x1A so the
   *  printer fires the cutter at end of job. Set false for chain
   *  printing — caller is responsible for issuing a separate cut later. */
  autoCut?: boolean;
  /** Margin (feed) before the print, in dots. Brother's documented
   *  minimum is 14 dots (~2mm at 180 dpi). Default 14. */
  marginDots?: number;
}

/**
 * Encode a label's bitmap into the Brother raster byte stream.
 *
 * The byte sequence, per Brother Raster Command Reference §2:
 *
 *   1. Invalidate (100 × 0x00) — clears any half-finished command in
 *      the printer's input buffer.
 *   2. Initialize:     0x1B 0x40            (ESC @)
 *   3. Raster mode:    0x1B 0x69 0x61 0x01  (ESC i a 01)
 *   4. Print info:     0x1B 0x69 0x7A + 10-byte payload
 *                      (flags, media type, width-mm, length-mm,
 *                       raster-line count LE u32, page, reserved)
 *   5. Mode bits:      0x1B 0x69 0x4D <bits> — 0x40 = auto-cut
 *   6. Expansion:      0x1B 0x69 0x4B 0x00 — no chain / no half-cut
 *   7. Margin:         0x1B 0x69 0x64 <dots LE u16>
 *   8. Compression:    0x4D 0x00 — uncompressed (simpler than packbits;
 *                      128-dot lines are small enough that compression
 *                      saves little and adds bug surface).
 *   9. Per raster line: 0x47 0x10 0x00 + 16 data bytes
 *  10. Trailer:        0x1A (print + cut) or 0x0C (print, no cut).
 */
export function encodeLabel(opts: EncodeOpts): Uint8Array {
  const {
    bitmap,
    rasterLines,
    tapeWidthMm,
    autoCut = true,
    marginDots = 14,
  } = opts;

  if (rasterLines < 1) {
    throw new Error("rasterLines must be ≥ 1");
  }
  if (bitmap.length !== rasterLines * BYTES_PER_RASTER_LINE) {
    throw new Error(
      `bitmap length ${bitmap.length} does not match ` +
        `rasterLines (${rasterLines}) × BYTES_PER_RASTER_LINE (${BYTES_PER_RASTER_LINE}) = ` +
        `${rasterLines * BYTES_PER_RASTER_LINE}`,
    );
  }
  if (marginDots < 0 || marginDots > 0xffff) {
    throw new Error(`marginDots ${marginDots} out of range [0, 65535]`);
  }

  // Fixed-size header (everything before the raster lines) + per-line
  // overhead (3 bytes G + length per line) + terminator. Precomputing
  // the total saves a flurry of small allocations on long labels.
  const headerLen =
    100 +          // invalidate
    2 +            // ESC @
    4 +            // ESC i a 01
    3 + 10 +       // ESC i z + 10 bytes
    4 +            // ESC i M
    4 +            // ESC i K
    5 +            // ESC i d
    2;             // M 00
  const rasterLen = rasterLines * (3 + BYTES_PER_RASTER_LINE);
  const trailerLen = 1;
  const out = new Uint8Array(headerLen + rasterLen + trailerLen);
  let pos = 0;

  // 1. Invalidate — 100 bytes (well over Brother's documented 64-byte
  // minimum). new Uint8Array initialises to zero so we just skip.
  pos += 100;

  // 2. Initialize.
  out[pos++] = 0x1b;
  out[pos++] = 0x40;

  // 3. Switch to raster mode.
  out[pos++] = 0x1b;
  out[pos++] = 0x69;
  out[pos++] = 0x61;
  out[pos++] = 0x01;

  // 4. Print info.
  //    flags=0x84 marks media-type + media-width + raster-line-count as
  //    valid (the printer ignores the corresponding bytes when their
  //    flag bit is unset). media=0x01 = laminated tape (the only kind
  //    PT-P710BT cartridges come in). length=0 = "auto from line count".
  out[pos++] = 0x1b;
  out[pos++] = 0x69;
  out[pos++] = 0x7a;
  out[pos++] = 0x84;
  out[pos++] = 0x01;
  // Media-width byte is rounded — 3.5mm tape is encoded as 4 (matches
  // Brother's official P-touch Editor output and the robby-cornelissen
  // Python reference impl). All other widths are integers and round-trip
  // verbatim.
  out[pos++] = Math.round(tapeWidthMm);
  out[pos++] = 0x00;
  // raster line count, little-endian u32
  out[pos++] = rasterLines & 0xff;
  out[pos++] = (rasterLines >> 8) & 0xff;
  out[pos++] = (rasterLines >> 16) & 0xff;
  out[pos++] = (rasterLines >> 24) & 0xff;
  out[pos++] = 0x00; // starting page
  out[pos++] = 0x00; // reserved

  // 5. Mode bits — 0x40 enables auto-cut at end of job.
  out[pos++] = 0x1b;
  out[pos++] = 0x69;
  out[pos++] = 0x4d;
  out[pos++] = autoCut ? 0x40 : 0x00;

  // 6. Various-mode flags (ESC i K). Per the Brother Raster Command
  // Reference for PT-E550W/P750W/P710BT, bit 3 controls the chain-
  // printing behavior:
  //   bit 3 = 1  → no chain printing (feed + cut after the LAST label)
  //   bit 3 = 0  → chain printing    (printer holds the label after the
  //                                   job, expecting another to follow)
  //
  // We tie this to autoCut: a one-shot single-label print wants
  // no-chain (0x08) so the label feeds out + gets cut; a deliberate
  // chain print (autoCut=false, --no-cut on the CLI) wants chain mode
  // (0x00) so the printer holds the tape ready for the next job.
  // (Codex P1+P2 rounds 17+18 on PR #487.)
  out[pos++] = 0x1b;
  out[pos++] = 0x69;
  out[pos++] = 0x4b;
  out[pos++] = autoCut ? 0x08 : 0x00;

  // 7. Margin (leading feed before the printed area), in dots, LE u16.
  out[pos++] = 0x1b;
  out[pos++] = 0x69;
  out[pos++] = 0x64;
  out[pos++] = marginDots & 0xff;
  out[pos++] = (marginDots >> 8) & 0xff;

  // 8. Compression: 0x00 = uncompressed. (0x02 = packbits is also
  // supported by this printer but we don't use it.)
  out[pos++] = 0x4d;
  out[pos++] = 0x00;

  // 9. Raster lines. Each one is G + length-LE-u16 + 16 data bytes.
  for (let i = 0; i < rasterLines; i++) {
    out[pos++] = 0x47;
    out[pos++] = BYTES_PER_RASTER_LINE; // 0x10
    out[pos++] = 0x00;
    const srcOff = i * BYTES_PER_RASTER_LINE;
    out.set(
      bitmap.subarray(srcOff, srcOff + BYTES_PER_RASTER_LINE),
      pos,
    );
    pos += BYTES_PER_RASTER_LINE;
  }

  // 10. Trailer — 0x1A = print with feed (and cut, if autoCut bit was
  // set in mode bits); 0x0C = print without feed (for chain printing).
  out[pos++] = autoCut ? 0x1a : 0x0c;

  if (pos !== out.length) {
    // Should never happen; defensive check in case the header math drifts.
    throw new Error(
      `Internal error: wrote ${pos} bytes but allocated ${out.length}`,
    );
  }
  return out;
}

/**
 * Pack one row of a grayscale row-major buffer (1 byte / dot, 0 = black,
 * 255 = white) into 16 bytes of MSB-first 1-bit packed data. Black bits
 * (gray < 128) become 1s in the output; the bit position is
 * MSB-of-byte-0 = leftmost dot of the print head.
 *
 * Used by the renderer when converting an HTML-canvas-rendered grayscale
 * image to the printer's wire format, and by the CLI spike's sharp-based
 * pipeline. Pure function over the input row — no allocations outside
 * the returned Uint8Array.
 */
export function packGrayscaleRow(grayRow: Uint8Array): Uint8Array {
  if (grayRow.length !== PRINT_HEAD_DOTS) {
    throw new Error(
      `packGrayscaleRow: row length ${grayRow.length} ≠ ${PRINT_HEAD_DOTS}`,
    );
  }
  const out = new Uint8Array(BYTES_PER_RASTER_LINE);
  for (let dot = 0; dot < PRINT_HEAD_DOTS; dot++) {
    if (grayRow[dot] < 128) {
      const byteIdx = dot >> 3;
      const bitInByte = 7 - (dot & 7);
      out[byteIdx] |= 1 << bitInByte;
    }
  }
  return out;
}

/**
 * Convenience helper: pack a row-major grayscale buffer (1 byte per
 * pixel, `rasterLines` rows × `PRINT_HEAD_DOTS` cols) into the row-major
 * 1-bit bitmap the encoder expects. Used by the dialog when handing the
 * canvas pixels to the encoder.
 */
export function packGrayscaleBitmap(
  grayscale: Uint8Array,
  rasterLines: number,
): Uint8Array {
  if (grayscale.length !== rasterLines * PRINT_HEAD_DOTS) {
    throw new Error(
      `packGrayscaleBitmap: buffer length ${grayscale.length} ≠ ` +
        `rasterLines (${rasterLines}) × ${PRINT_HEAD_DOTS}`,
    );
  }
  const packed = new Uint8Array(rasterLines * BYTES_PER_RASTER_LINE);
  for (let row = 0; row < rasterLines; row++) {
    const srcOff = row * PRINT_HEAD_DOTS;
    const dstOff = row * BYTES_PER_RASTER_LINE;
    for (let dot = 0; dot < PRINT_HEAD_DOTS; dot++) {
      if (grayscale[srcOff + dot] < 128) {
        const byteIdx = dot >> 3;
        const bitInByte = 7 - (dot & 7);
        packed[dstOff + byteIdx] |= 1 << bitInByte;
      }
    }
  }
  return packed;
}

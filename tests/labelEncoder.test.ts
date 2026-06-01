import { describe, it, expect } from "vitest";
import {
  encodeLabel,
  packGrayscaleRow,
  packGrayscaleBitmap,
  PRINT_HEAD_DOTS,
  BYTES_PER_RASTER_LINE,
  type TapeWidthMm,
} from "@/lib/labelEncoder";

/**
 * Coverage for the Brother PT-P710BT raster command encoder.
 *
 * These tests pin both the wire format (so a regression in the byte
 * sequence is caught before a Tuesday print run wastes tape) and the
 * grayscale → 1-bit packing (so a bit-order flip turns a QR into noise
 * loudly rather than silently).
 */

function makeBitmap(rasterLines: number, fill: number = 0x00): Uint8Array {
  return new Uint8Array(rasterLines * BYTES_PER_RASTER_LINE).fill(fill);
}

describe("encodeLabel — wire format", () => {
  it("emits the exact fixed header for a 1-line 24mm autoCut label", () => {
    // Reference byte sequence per Brother Raster Command Reference §2.
    // Header is identical for every label of the same tape width + line
    // count + autoCut setting; only the raster lines differ.
    const bytes = encodeLabel({
      bitmap: makeBitmap(1),
      rasterLines: 1,
      tapeWidthMm: 24,
    });
    // Invalidate: 100 × 0x00
    for (let i = 0; i < 100; i++) expect(bytes[i]).toBe(0);
    // ESC @ (initialize)
    expect([bytes[100], bytes[101]]).toEqual([0x1b, 0x40]);
    // ESC i a 01 (raster mode)
    expect([bytes[102], bytes[103], bytes[104], bytes[105]]).toEqual([0x1b, 0x69, 0x61, 0x01]);
    // ESC i z <flags 0x84> <media 0x01> <width 24> <length 0> <lines LE u32> <page 0> <0>
    expect([bytes[106], bytes[107], bytes[108]]).toEqual([0x1b, 0x69, 0x7a]);
    expect(bytes[109]).toBe(0x84);
    expect(bytes[110]).toBe(0x01);
    expect(bytes[111]).toBe(24);
    expect(bytes[112]).toBe(0x00);
    // raster line count = 1, little-endian
    expect([bytes[113], bytes[114], bytes[115], bytes[116]]).toEqual([1, 0, 0, 0]);
    expect(bytes[117]).toBe(0x00); // page
    expect(bytes[118]).toBe(0x00); // reserved
    // ESC i M 0x40 (auto-cut)
    expect([bytes[119], bytes[120], bytes[121], bytes[122]]).toEqual([0x1b, 0x69, 0x4d, 0x40]);
    // ESC i K 0x08 — bit 3 set = no-chain mode (feed + cut after the
    // last label, which is what we want for a single-label print).
    // Codex P1 round 17 on PR #487 caught this: with 0x00 the printer
    // accepts the job but holds the label, breaking the one-click flow.
    expect([bytes[123], bytes[124], bytes[125], bytes[126]]).toEqual([0x1b, 0x69, 0x4b, 0x08]);
    // ESC i d 0x0E 0x00 (14 dots = 2mm margin)
    expect([bytes[127], bytes[128], bytes[129], bytes[130], bytes[131]]).toEqual([0x1b, 0x69, 0x64, 0x0e, 0x00]);
    // M 0x00 (uncompressed)
    expect([bytes[132], bytes[133]]).toEqual([0x4d, 0x00]);
    // G 0x10 0x00 + 16 data bytes + 0x1A trailer
    expect([bytes[134], bytes[135], bytes[136]]).toEqual([0x47, 0x10, 0x00]);
    // 16 data bytes (all zero from makeBitmap)
    for (let i = 0; i < 16; i++) expect(bytes[137 + i]).toBe(0);
    // trailer
    expect(bytes[153]).toBe(0x1a);
    expect(bytes.length).toBe(154);
  });

  it("encodes raster line count as little-endian u32 (handles large counts)", () => {
    // 4321 lines — fits two bytes; verifies LE byte order isn't flipped.
    const bytes = encodeLabel({
      bitmap: makeBitmap(4321),
      rasterLines: 4321,
      tapeWidthMm: 24,
    });
    // 4321 = 0x10E1 → LE bytes: 0xE1 0x10 0x00 0x00
    expect([bytes[113], bytes[114], bytes[115], bytes[116]]).toEqual([0xe1, 0x10, 0, 0]);
  });

  it("autoCut=false swaps mode bits 0x40 → 0x00, K flag 0x08 → 0x00, and trailer 0x1A → 0x0C", () => {
    // autoCut: false is chain-mode intent — caller will issue more
    // labels later. The ESC i K byte (offset 126) must mirror that
    // so the printer holds the tape instead of feeding + cutting it.
    // (Codex P2 round 18 on PR #487.)
    const bytes = encodeLabel({
      bitmap: makeBitmap(1),
      rasterLines: 1,
      tapeWidthMm: 24,
      autoCut: false,
    });
    expect(bytes[122]).toBe(0x00); // mode bits — auto-cut off
    expect(bytes[126]).toBe(0x00); // ESC i K — chain mode
    expect(bytes[bytes.length - 1]).toBe(0x0c); // trailer (print, no cut)
  });

  it("respects custom marginDots (LE u16)", () => {
    const bytes = encodeLabel({
      bitmap: makeBitmap(1),
      rasterLines: 1,
      tapeWidthMm: 24,
      marginDots: 350, // 0x015E
    });
    expect([bytes[130], bytes[131]]).toEqual([0x5e, 0x01]);
  });

  it("encodes tape width into the media-width byte (3.5 rounds to 4)", () => {
    // Brother's media-width byte is integer-valued. The 3.5mm cassette
    // is conventionally encoded as 4 (matches Brother's official P-touch
    // Editor output and the robby-cornelissen Python reference impl);
    // every other width round-trips verbatim.
    const expected: Array<[TapeWidthMm, number]> = [
      [3.5, 4],
      [6, 6],
      [9, 9],
      [12, 12],
      [18, 18],
      [24, 24],
    ];
    for (const [width, byte] of expected) {
      const bytes = encodeLabel({
        bitmap: makeBitmap(1),
        rasterLines: 1,
        tapeWidthMm: width,
      });
      expect(bytes[111]).toBe(byte);
    }
  });

  it("preserves raster line data bytes verbatim", () => {
    // Pattern: each line has a unique signature byte at offset 0.
    const rasterLines = 5;
    const bitmap = new Uint8Array(rasterLines * BYTES_PER_RASTER_LINE);
    for (let i = 0; i < rasterLines; i++) {
      bitmap[i * BYTES_PER_RASTER_LINE] = 0xa0 + i;
      bitmap[i * BYTES_PER_RASTER_LINE + 15] = 0xb0 + i;
    }
    const bytes = encodeLabel({ bitmap, rasterLines, tapeWidthMm: 24 });
    // First raster line starts at byte 134 (3 bytes G + len, then 16 data).
    // Each subsequent line is 19 bytes later.
    for (let i = 0; i < rasterLines; i++) {
      const lineStart = 134 + i * 19 + 3; // skip G + length
      expect(bytes[lineStart]).toBe(0xa0 + i);
      expect(bytes[lineStart + 15]).toBe(0xb0 + i);
    }
  });

  it("rejects bitmap length / rasterLines mismatch", () => {
    expect(() =>
      encodeLabel({
        bitmap: new Uint8Array(15), // not a multiple of 16
        rasterLines: 1,
        tapeWidthMm: 24,
      }),
    ).toThrow(/bitmap length/);
    expect(() =>
      encodeLabel({
        bitmap: new Uint8Array(32), // 2 lines worth
        rasterLines: 1, // but only 1 declared
        tapeWidthMm: 24,
      }),
    ).toThrow(/bitmap length/);
  });

  it("rejects rasterLines < 1", () => {
    expect(() =>
      encodeLabel({
        bitmap: new Uint8Array(0),
        rasterLines: 0,
        tapeWidthMm: 24,
      }),
    ).toThrow(/rasterLines/);
  });

  it("rejects marginDots out of u16 range", () => {
    expect(() =>
      encodeLabel({
        bitmap: makeBitmap(1),
        rasterLines: 1,
        tapeWidthMm: 24,
        marginDots: -1,
      }),
    ).toThrow(/marginDots/);
    expect(() =>
      encodeLabel({
        bitmap: makeBitmap(1),
        rasterLines: 1,
        tapeWidthMm: 24,
        marginDots: 65536,
      }),
    ).toThrow(/marginDots/);
  });

  it("output length math matches: header + lines×19 + trailer", () => {
    // The encoder pre-allocates a fixed-size Uint8Array. If header math
    // drifts, the internal invariant check throws; this test pins the
    // expected total externally so a refactor catches both shapes.
    const rasterLines = 100;
    const bytes = encodeLabel({
      bitmap: makeBitmap(rasterLines),
      rasterLines,
      tapeWidthMm: 24,
    });
    const headerLen = 100 + 2 + 4 + 13 + 4 + 4 + 5 + 2; // = 134
    expect(bytes.length).toBe(headerLen + rasterLines * 19 + 1);
  });
});

describe("packGrayscaleRow", () => {
  it("packs MSB-first with black = 1 (gray < 128)", () => {
    // First 8 dots black, next 120 white → first byte 0xFF, rest 0x00.
    const row = new Uint8Array(PRINT_HEAD_DOTS).fill(255);
    for (let i = 0; i < 8; i++) row[i] = 0;
    const packed = packGrayscaleRow(row);
    expect(packed[0]).toBe(0xff);
    for (let i = 1; i < BYTES_PER_RASTER_LINE; i++) expect(packed[i]).toBe(0);
  });

  it("MSB of byte 0 is the leftmost dot (dot 0)", () => {
    const row = new Uint8Array(PRINT_HEAD_DOTS).fill(255);
    row[0] = 0; // black at the very left
    const packed = packGrayscaleRow(row);
    expect(packed[0]).toBe(0x80); // bit 7 set, bit 0 clear
  });

  it("LSB of byte 15 is the rightmost dot (dot 127)", () => {
    const row = new Uint8Array(PRINT_HEAD_DOTS).fill(255);
    row[PRINT_HEAD_DOTS - 1] = 0; // black at the very right
    const packed = packGrayscaleRow(row);
    expect(packed[BYTES_PER_RASTER_LINE - 1]).toBe(0x01);
  });

  it("threshold is at 128 — exactly 128 stays white", () => {
    const row = new Uint8Array(PRINT_HEAD_DOTS).fill(128);
    const packed = packGrayscaleRow(row);
    for (const b of packed) expect(b).toBe(0);
  });

  it("threshold is at 128 — 127 flips to black", () => {
    const row = new Uint8Array(PRINT_HEAD_DOTS).fill(127);
    const packed = packGrayscaleRow(row);
    for (const b of packed) expect(b).toBe(0xff);
  });

  it("rejects wrong row length", () => {
    expect(() => packGrayscaleRow(new Uint8Array(127))).toThrow(/row length/);
    expect(() => packGrayscaleRow(new Uint8Array(129))).toThrow(/row length/);
  });
});

describe("packGrayscaleBitmap", () => {
  it("packs each row independently", () => {
    // Row 0 fully black, row 1 fully white.
    const buf = new Uint8Array(2 * PRINT_HEAD_DOTS).fill(255);
    for (let i = 0; i < PRINT_HEAD_DOTS; i++) buf[i] = 0;
    const packed = packGrayscaleBitmap(buf, 2);
    for (let i = 0; i < BYTES_PER_RASTER_LINE; i++) {
      expect(packed[i]).toBe(0xff); // row 0
      expect(packed[BYTES_PER_RASTER_LINE + i]).toBe(0x00); // row 1
    }
  });

  it("rejects buffer / rasterLines mismatch", () => {
    expect(() => packGrayscaleBitmap(new Uint8Array(PRINT_HEAD_DOTS - 1), 1)).toThrow(/buffer length/);
  });
});

describe("end-to-end round trip", () => {
  it("pack → encode → decoded raster lines match input", () => {
    // Render a recognisable pattern (vertical stripe at dot 42), encode,
    // then unpack a raster line from the encoded stream and confirm only
    // dot 42 is black. This mirrors what the simulator does in
    // scripts/print-label-sim.ts but at the unit-test level.
    const grayRow = new Uint8Array(PRINT_HEAD_DOTS).fill(255);
    grayRow[42] = 0;
    const packed = packGrayscaleRow(grayRow);
    const bitmap = new Uint8Array(BYTES_PER_RASTER_LINE);
    bitmap.set(packed);
    const bytes = encodeLabel({
      bitmap,
      rasterLines: 1,
      tapeWidthMm: 24,
    });
    // First raster line data starts at offset 137 (134 = G + len header).
    const linePayload = bytes.slice(137, 137 + BYTES_PER_RASTER_LINE);
    // Decode bit at dot 42: byte index 5 (42 >> 3), bit index 7 - (42 & 7) = 7 - 2 = 5.
    expect((linePayload[5] >> 5) & 1).toBe(1);
    // Every other bit should be 0.
    let blackBits = 0;
    for (let dot = 0; dot < PRINT_HEAD_DOTS; dot++) {
      const byteIdx = dot >> 3;
      const bitIdx = 7 - (dot & 7);
      if ((linePayload[byteIdx] >> bitIdx) & 1) blackBits++;
    }
    expect(blackBits).toBe(1);
  });
});

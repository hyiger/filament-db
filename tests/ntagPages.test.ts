import { describe, it, expect } from "vitest";
import {
  NTAG_CC_OFFSET,
  NTAG_TLV_OFFSET,
  NTAG_FIRST_DATA_PAGE,
  NTAG_MAX_PAGE,
  NTAG_MAX_NDEF_BYTES,
  ndefBytesFromCc,
  ntagBurstPages,
  isReadablePage,
} from "@/lib/ntagPages";

/**
 * GH #1028 — NTAG read page arithmetic.
 *
 * A Type-2 READ BINARY pseudo-APDU carries the start page in ONE byte:
 *
 *     Buffer.from([0xff, 0xb0, 0x00, startPage, 0x10])
 *
 * `Buffer.from(array)` applies `& 0xff` silently, so page 256 emits
 * `ffb0000010` — a read of pages 0-3 (UID / BCC / internal / static LOCK bytes
 * / CC). `assembleNtagImage` derived its extent from the TAG-CONTROLLED CC byte
 * and walked `page += 4` unbounded, so a CC byte >= 0x7f spliced that head back
 * into the TAIL of the NDEF image — silent corruption, not an error.
 *
 * The write side has had the equivalent bound since #927; the read side never
 * got its counterpart.
 */
describe("ntagPages — burst page bounds (GH #1028)", () => {
  it("never yields a page above the single-byte APDU maximum, for ANY CC value", () => {
    // The property that actually matters — exhaustive over every possible byte.
    for (let mlen = 0; mlen <= 0xff; mlen++) {
      const head = new Uint8Array(NTAG_TLV_OFFSET);
      head[NTAG_CC_OFFSET + 2] = mlen;
      for (const page of ntagBurstPages(ndefBytesFromCc(head))) {
        expect(Number.isInteger(page)).toBe(true);
        expect(page).toBeGreaterThanOrEqual(NTAG_FIRST_DATA_PAGE);
        expect(page).toBeLessThanOrEqual(NTAG_MAX_PAGE);
      }
    }
  });

  it("pins the boundary table for real chips and the former wrap point", () => {
    const rows = [0x12, 0x3e, 0x6d, 0x7e, 0x7f, 0x80, 0xff].map((mlen) => {
      const head = new Uint8Array(NTAG_TLV_OFFSET);
      head[NTAG_CC_OFFSET + 2] = mlen;
      const nd = ndefBytesFromCc(head);
      const pages = ntagBurstPages(nd);
      return {
        mlen: `0x${mlen.toString(16)}`,
        ndefBytes: nd,
        bursts: pages.length,
        finalPage: pages[pages.length - 1] ?? null,
      };
    });

    expect(rows).toEqual([
      // Real chips — unchanged by this fix.
      { mlen: "0x12", ndefBytes: 144, bursts: 9, finalPage: 36 },   // NTAG213
      { mlen: "0x3e", ndefBytes: 496, bursts: 31, finalPage: 124 }, // NTAG215
      { mlen: "0x6d", ndefBytes: 872, bursts: 55, finalPage: 220 }, // NTAG216
      // 0x7e was the last SAFE value pre-fix.
      { mlen: "0x7e", ndefBytes: 1008, bursts: 63, finalPage: 252 },
      // 0x7f was the FIRST value that wrapped to page 0 pre-fix (NOT 0x80 —
      // the issue's original table was off by one value).
      { mlen: "0x7f", ndefBytes: 1008, bursts: 63, finalPage: 252 },
      { mlen: "0x80", ndefBytes: 1008, bursts: 63, finalPage: 252 },
      { mlen: "0xff", ndefBytes: 1008, bursts: 63, finalPage: 252 },
    ]);
  });

  it("clamps the extent to what a 1-byte page address can actually reach", () => {
    // The old ceiling (1024) was arithmetically impossible: the data area
    // starts at page 4, so only (256-4)*4 = 1008 bytes are addressable.
    expect(NTAG_MAX_NDEF_BYTES).toBe(1008);
    expect(NTAG_TLV_OFFSET + NTAG_MAX_NDEF_BYTES).toBe(1024); // one full sector
    const head = new Uint8Array(NTAG_TLV_OFFSET);
    head[NTAG_CC_OFFSET + 2] = 0xff; // claims 2040 bytes
    expect(ndefBytesFromCc(head)).toBe(1008);
  });

  it("covers the whole declared extent for every real chip (no truncation)", () => {
    for (const [mlen, expected] of [
      [0x12, 144],
      [0x3e, 496],
      [0x6d, 872],
    ] as const) {
      const head = new Uint8Array(NTAG_TLV_OFFSET);
      head[NTAG_CC_OFFSET + 2] = mlen;
      const pages = ntagBurstPages(ndefBytesFromCc(head));
      // bursts * 16 bytes must reach or exceed the declared NDEF extent
      expect(pages.length * 16).toBeGreaterThanOrEqual(expected);
    }
  });
});

describe("ntagPages — ndefBytesFromCc treats the head as hostile", () => {
  it("returns 0 for a head too short to contain the CC", () => {
    // The write-verify caller does NOT length-check its head, so a truncated
    // burst used to yield `Buffer.alloc(16 + NaN)` → a raw RangeError.
    expect(ndefBytesFromCc(new Uint8Array(0))).toBe(0);
    expect(ndefBytesFromCc(new Uint8Array(NTAG_CC_OFFSET))).toBe(0);
    expect(ndefBytesFromCc(new Uint8Array(NTAG_CC_OFFSET + 2))).toBe(0);
  });

  it("returns 0 for a zero / absent CC size", () => {
    const head = new Uint8Array(NTAG_TLV_OFFSET); // all zeroes
    expect(ndefBytesFromCc(head)).toBe(0);
  });

  it("returns 0 for non-numeric or non-finite CC bytes", () => {
    expect(ndefBytesFromCc({ length: 16, [NTAG_CC_OFFSET + 2]: NaN } as never)).toBe(0);
    expect(ndefBytesFromCc({ length: 16, [NTAG_CC_OFFSET + 2]: -3 } as never)).toBe(0);
    expect(
      ndefBytesFromCc({ length: 16, [NTAG_CC_OFFSET + 2]: Infinity } as never),
    ).toBe(0);
  });

  it("yields no bursts at all when the extent is 0", () => {
    expect(ntagBurstPages(0)).toEqual([]);
    expect(ntagBurstPages(-100)).toEqual([]);
  });
});

describe("ntagPages — isReadablePage", () => {
  it("accepts the whole addressable range INCLUDING page 0", () => {
    // Page 0 is legal for a READ (the head burst) — unlike the write bound,
    // which starts at 3 because pages 0-2 hold the UID and static lock bytes.
    expect(isReadablePage(0)).toBe(true);
    expect(isReadablePage(4)).toBe(true);
    expect(isReadablePage(NTAG_MAX_PAGE)).toBe(true);
  });

  it("rejects the wrap point and everything past it", () => {
    expect(isReadablePage(256)).toBe(false); // the exact value that wrapped to 0
    expect(isReadablePage(512)).toBe(false);
    expect(isReadablePage(-1)).toBe(false);
  });

  it("rejects non-integers", () => {
    expect(isReadablePage(4.5)).toBe(false);
    expect(isReadablePage(NaN)).toBe(false);
    expect(isReadablePage(Infinity)).toBe(false);
  });

  it("demonstrates WHY the bound exists: Buffer.from silently masks to a byte", () => {
    // This is the actual defect mechanism, pinned so it can't be argued away.
    expect(Buffer.from([0xff, 0xb0, 0x00, 256, 0x10]).toString("hex")).toBe(
      "ffb0000010",
    );
    expect(Buffer.from([0xff, 0xb0, 0x00, 256, 0x10])[3]).toBe(0);
    // ...and that byte-3 of 0 is a read of pages 0-3, i.e. the head.
    expect(Buffer.from([0xff, 0xb0, 0x00, 0, 0x10]).toString("hex")).toBe(
      "ffb0000010",
    );
  });
});

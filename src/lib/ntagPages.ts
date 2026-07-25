/**
 * Pure page arithmetic for the NFC-Forum Type 2 (NTAG21x) read path (GH #1028).
 *
 * Extracted from `electron/nfc-service.ts`'s `assembleNtagImage` so the
 * arithmetic lives in coverage-gated, unit-testable code — mirroring what #973
 * did for the GET_VERSION parse (`src/lib/ntagVersion.ts`). `electron/` has no
 * test file at all, and this is the second page-arithmetic safety bug in that
 * module, so the numbers belong here rather than inline.
 *
 * THE BUG THIS ENCODES AGAINST
 *
 * A Type-2 READ BINARY pseudo-APDU carries the start page in a SINGLE byte:
 *
 *     Buffer.from([0xff, 0xb0, 0x00, startPage, 0x10])
 *
 * `Buffer.from(array)` applies `& 0xff` silently, so page 256 emits the wire
 * bytes `ffb0000010` — a read of pages 0-3 (UID, BCC, internal byte, static
 * LOCK bytes, CC). The assembler derived its read extent from the tag's own
 * Capability Container byte and walked `page += 4` with no upper bound, so a
 * tag whose CC byte 2 was >= 0x7f drove the final burst to page 256 and
 * spliced the head back into the TAIL of the NDEF image — silent corruption
 * rather than a clean error.
 *
 * The write side already had exactly this guard (`writeNtagPage`'s [3,255]
 * bound, added in #927); the read side never got its counterpart.
 *
 * THE OFF-BY-ONE IN THE OLD CEILING
 *
 * `NTAG_MAX_NDEF_BYTES` was 1024, commented as "a generous ceiling that bounds
 * the read loop". It does not bound it. One Type-2 sector is 256 pages x 4 =
 * 1024 bytes TOTAL, and the NDEF area starts at page 4, so the largest NDEF
 * extent addressable with a 1-byte page field is (256 - 4) x 4 = 1008 bytes.
 * The ceiling was off by exactly the 16-byte head — which is precisely why the
 * loop could run one burst past the addressable end.
 */

/** Byte offset of the Type-2 Capability Container within the pages-0-3 head. */
export const NTAG_CC_OFFSET = 12;

/** Byte offset where the NDEF TLV area begins (page 4). */
export const NTAG_TLV_OFFSET = 16;

/** First page of the NDEF/user data area. */
export const NTAG_FIRST_DATA_PAGE = 4;

/** Highest page addressable by the single-byte READ BINARY page field. */
export const NTAG_MAX_PAGE = 0xff;

/**
 * Largest NDEF extent reachable with a 1-byte page address:
 * `(256 - 4) pages x 4 bytes = 1008`.
 *
 * Replaces the old, unreachable 1024. Chosen over `NTAG216_MAX_NDEF_BYTES`
 * (872, the largest REAL chip) so the read path stays exactly as permissive as
 * it is today — this is a correctness fix, not a narrowing of which tags can be
 * read. The page bounds below are the structural guarantee; this constant just
 * stops the ceiling from being arithmetically impossible.
 */
export const NTAG_MAX_NDEF_BYTES = 1008;

/**
 * Read the CC-declared NDEF extent out of a pages-0-3 head, clamped to what is
 * actually addressable.
 *
 * `head` is tag-controlled, so every field is treated as hostile:
 *   - a head shorter than the CC offset yields 0 rather than `undefined`,
 *     which used to reach `Buffer.alloc(16 + NaN)` and throw a raw RangeError
 *     (the write-verify caller does not length-check its head first);
 *   - a non-integer / negative / NaN mlen yields 0;
 *   - an over-large mlen clamps to NTAG_MAX_NDEF_BYTES.
 */
export function ndefBytesFromCc(head: ArrayLike<number>): number {
  const idx = NTAG_CC_OFFSET + 2; // CC byte 2 = NDEF area size / 8
  if (head.length <= idx) return 0;
  const mlen = head[idx];
  if (typeof mlen !== "number" || !Number.isFinite(mlen) || mlen <= 0) return 0;
  return Math.min(Math.floor(mlen) * 8, NTAG_MAX_NDEF_BYTES);
}

/**
 * The exact sequence of start pages `assembleNtagImage` should burst-read for a
 * given NDEF extent — each burst covering 4 pages / 16 bytes from page 4.
 *
 * Never yields a page above `NTAG_MAX_PAGE`, which is the property that makes
 * the single-byte APDU field safe. Exported primarily so the boundary table can
 * be pinned by tests; the service consumes `page` via the same bound.
 */
export function ntagBurstPages(ndefBytes: number): number[] {
  const total = NTAG_TLV_OFFSET + Math.max(0, ndefBytes);
  const pages: number[] = [];
  let page = NTAG_FIRST_DATA_PAGE;
  let written = NTAG_TLV_OFFSET;
  while (written < total && page <= NTAG_MAX_PAGE) {
    pages.push(page);
    written += 16;
    page += 4;
  }
  return pages;
}

/**
 * True when `page` is a legal READ BINARY start page.
 *
 * Page 0 IS legal for a read (the head burst), unlike the write bound which
 * starts at 3 — writes must never touch pages 0-2 (UID / static lock bytes),
 * but reading them is exactly how detection works.
 */
export function isReadablePage(page: number): boolean {
  return Number.isInteger(page) && page >= 0 && page <= NTAG_MAX_PAGE;
}

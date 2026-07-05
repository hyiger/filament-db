/**
 * NTAG21x GET_VERSION storage-size parsing (GH #973), DB-free + pure so it's
 * unit-testable in CI (electron/ is excluded from the root tsconfig and never
 * exercised by tests).
 *
 * Background: a BLANK NTAG has no Capability Container to read its chip size
 * from, so to write a correctly-sized CC the desktop reader issues the NTAG21x
 * `GET_VERSION` command and maps the response's storage-size byte. #927 shipped
 * this with a HARD-CODED response offset (`data[6]`) that was never validated on
 * real hardware — the only hardware-proven NTAG writer (scripts/write-opentag3d-tag.ts)
 * side-steps GET_VERSION entirely and takes the size from a `--ntag` flag. On an
 * ACR1552U + real NTAG215 the fixed offset mis-reads the storage byte and the
 * 215 is classified as a 144-byte NTAG213 (#973), dropping the extended fields.
 *
 * This parser is OFFSET-TOLERANT: instead of hard-indexing byte 6 it SCANS the
 * response for the fixed NXP NTAG21x version signature and reads the storage
 * byte relative to it — so a reader that prepends framing bytes (or appends a
 * `90 00` status word) still parses. When the signature isn't present (the
 * command wasn't answered / an unrecognised reader response) it returns null,
 * and the caller must NOT guess — it falls back to an explicit user size choice.
 *
 * NXP NTAG21x GET_VERSION version data (8 bytes, datasheet §8.3.7):
 *   [0]=0x00 fixed header  [1]=0x04 vendor (NXP)  [2]=0x04 product (NTAG)
 *   [3]=0x02 subtype (50pF)  [4]=0x01 major  [5]=minor  [6]=storage size
 *   [7]=0x03 protocol (ISO/IEC 14443-3)
 * Storage-size byte → chip: 0x0F=NTAG213, 0x11=NTAG215, 0x13=NTAG216.
 */

/** The three NTAG21x chip types this app writes. */
export type NtagSizeName = "NTAG213" | "NTAG215" | "NTAG216";

/** Storage-size byte → NDEF-usable bytes (CC byte-2 × 8), NXP datasheet §8.3.7. */
export const NTAG_STORAGE_SIZE_TO_NDEF_BYTES: Record<number, number> = {
  0x0f: 144, // NTAG213
  0x11: 496, // NTAG215
  0x13: 872, // NTAG216
};

/** NDEF-usable bytes for a user-declared / known NTAG type. */
export const NTAG_NAME_TO_NDEF_BYTES: Record<NtagSizeName, number> = {
  NTAG213: 144,
  NTAG215: 496,
  NTAG216: 872,
};

/** Type guard for a user/IPC-supplied NTAG size string. */
export function isNtagSizeName(v: unknown): v is NtagSizeName {
  return v === "NTAG213" || v === "NTAG215" || v === "NTAG216";
}

/** Largest real NTAG (NTAG216) NDEF capacity — the hard write ceiling. */
export const NTAG216_MAX_NDEF_BYTES = 872;
/** NTAG213 extent — the conservative capacity safe to write on ANY NTAG (its
 *  lock/config pages sit above its 144-byte user area). */
export const NTAG213_NDEF_BYTES = 144;

/** Outcome of {@link resolveNtagWriteSize}. */
export type NtagWriteSizeDecision =
  | { ok: true; ndefBytes: number; needsFormat: boolean }
  | { ok: false; error: "size_unknown" };

/**
 * Decide the NDEF byte capacity to write + whether to (re)write the tag's
 * Capability Container, from the page-3 CC state, the GET_VERSION result (null
 * when the reader can't answer it — e.g. the ACR1552U rejects GET_VERSION with
 * SW 0x6900, GH #973), and an optional user-declared size.
 *
 * Pure + unit-tested on purpose: the electron write path isn't exercised by CI,
 * and this is the safety-critical decision — a size larger than the physical
 * chip would drive a write into a smaller NTAG's lock/config pages (a permanent
 * brick the page-address bound can't catch). The caller pairs this with a
 * page-read probe of the resulting top page to prove the chip is physically big
 * enough before any write.
 *
 * Rules:
 *  - Formatted (CC 0xE1) + GET_VERSION confirmed → GET_VERSION is authoritative
 *    for the chip's TRUE size, so use it directly (not min(CC, verSize)) and
 *    REWRITE the CC when it disagrees. This corrects a wrong CC in BOTH
 *    directions: an inflated CC (a real 213 claiming 215) shrinks to the real
 *    size, and an under-sized CC (a real 215 stamped 144 by a prior bad write)
 *    grows back so its Extended image isn't wrongly rejected as TAG_TOO_SMALL.
 *    The caller's page-read probe guards against a mis-reported (too-large) size.
 *  - Formatted + GET_VERSION unavailable + user size → the USER SIZE is
 *    authoritative and the CC is REWRITTEN to it (needsFormat=true) — this
 *    corrects a tag an earlier failed write mis-sized on a GET_VERSION-dead
 *    reader (e.g. a real 215 stamped with a 144-byte CC stuck at NTAG213).
 *  - Formatted + neither → conservative min(CC, 144), no reformat (legacy).
 *  - Blank (CC 0x00) + a size (GET_VERSION or user) → that size, reformat.
 *  - Blank + neither → { ok:false, size_unknown } — never guess.
 */
export function resolveNtagWriteSize(opts: {
  ccMagic: number;
  ccSizeByte: number;
  verSize: number | null;
  hintBytes: number | null;
}): NtagWriteSizeDecision {
  const { ccMagic, ccSizeByte, verSize, hintBytes } = opts;
  // Clamp the CC size byte to [0, 872] and treat a non-finite value as 0 — in
  // production it's always a Uint8Array byte (0–255), but this keeps the bound
  // total (no NaN can leak into ndefBytes).
  const safeCcByte = Number.isFinite(ccSizeByte) ? Math.trunc(ccSizeByte) : 0;
  const ccBytes = Math.min(Math.max(0, safeCcByte * 8), NTAG216_MAX_NDEF_BYTES);
  if (ccMagic === 0xe1) {
    // GET_VERSION is authoritative for the true chip size: use it directly and
    // rewrite the CC when it disagrees (fixes an under-sized OR inflated CC).
    if (verSize != null) return { ok: true, ndefBytes: verSize, needsFormat: ccBytes !== verSize };
    if (hintBytes != null) return { ok: true, ndefBytes: hintBytes, needsFormat: true };
    return { ok: true, ndefBytes: Math.min(ccBytes, NTAG213_NDEF_BYTES), needsFormat: false };
  }
  const resolved = verSize ?? hintBytes;
  if (resolved == null) return { ok: false, error: "size_unknown" };
  return { ok: true, ndefBytes: resolved, needsFormat: true };
}

/**
 * The full 8-byte NXP NTAG21x GET_VERSION version block:
 *   [0]=0x00 header  [1]=0x04 vendor(NXP)  [2]=0x04 product(NTAG)
 *   [3]=0x02 subtype(50pF)  [4]=0x01 major  [5]=minor  [6]=storage  [7]=0x03 protocol
 * We anchor on the WHOLE block, not just the 4-byte vendor/product/subtype/major
 * run: a bare 4-byte signature is only 32 bits wide and could appear by chance in
 * reader framing/length/CRC bytes, and if such a false hit happened to carry a
 * valid storage byte at +5 it would return a WRONG size (a real 215 mis-read as a
 * 213 — the #973 failure, just relocated) with no picker. Requiring the leading
 * 0x00 header AND the trailing 0x03 protocol byte around the signature collapses
 * the accidental-match space by ~2^16 while staying offset-tolerant.
 */
const VENDOR_OFFSET = 1; // vendor byte's index within the 8-byte block
const STORAGE_OFFSET = 6; // storage byte's index within the block
const PROTOCOL_OFFSET = 7;

/**
 * Parse the NDEF-usable byte capacity from a raw NTAG GET_VERSION response.
 * Offset-tolerant: scans for the full 8-byte NXP NTAG21x version block anywhere
 * in the buffer (so leading reader-framing bytes and a trailing `90 00` SW are
 * both tolerated). Returns null when no recognised block is present — the caller
 * must then refuse to guess (write is gated on an explicit user size instead).
 */
export function parseNtagNdefBytesFromGetVersion(resp: ArrayLike<number>): number | null {
  const b: number[] = [];
  for (let i = 0; i < resp.length; i++) b.push(resp[i] & 0xff);

  // Drop a trailing PC/SC status word so it can't be mistaken for block bytes.
  let end = b.length;
  if (end >= 2 && b[end - 2] === 0x90 && b[end - 1] === 0x00) end -= 2;

  // Slide an 8-byte window; `start` is the block's 0x00 header index.
  for (let start = 0; start + PROTOCOL_OFFSET < end; start++) {
    if (
      b[start] === 0x00 && // header
      b[start + VENDOR_OFFSET] === 0x04 && // vendor: NXP
      b[start + VENDOR_OFFSET + 1] === 0x04 && // product: NTAG
      b[start + VENDOR_OFFSET + 2] === 0x02 && // subtype: 50pF (covers 213/215/216 + F variants)
      b[start + VENDOR_OFFSET + 3] === 0x01 && // major version
      b[start + PROTOCOL_OFFSET] === 0x03 // protocol: ISO/IEC 14443-3
    ) {
      const bytes = NTAG_STORAGE_SIZE_TO_NDEF_BYTES[b[start + STORAGE_OFFSET]];
      if (bytes != null) return bytes;
    }
  }
  return null;
}

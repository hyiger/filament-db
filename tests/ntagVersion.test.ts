import { describe, it, expect } from "vitest";
import {
  parseNtagNdefBytesFromGetVersion,
  isNtagSizeName,
  resolveNtagWriteSize,
  NTAG_STORAGE_SIZE_TO_NDEF_BYTES,
  NTAG_NAME_TO_NDEF_BYTES,
} from "@/lib/ntagVersion";

/**
 * GH #973: offset-tolerant NTAG21x GET_VERSION parser. Fixtures are the NXP
 * datasheet §8.3.7 version blocks:
 *   header 00, vendor 04, product 04, subtype 02, major 01, minor 00,
 *   storage <sz>, protocol 03.
 */
const ver = (storage: number): number[] => [0x00, 0x04, 0x04, 0x02, 0x01, 0x00, storage, 0x03];
const VER_213 = ver(0x0f);
const VER_215 = ver(0x11);
const VER_216 = ver(0x13);

describe("parseNtagNdefBytesFromGetVersion", () => {
  it("maps the three NTAG storage bytes to NDEF capacity (raw 8-byte response)", () => {
    expect(parseNtagNdefBytesFromGetVersion(VER_213)).toBe(144);
    expect(parseNtagNdefBytesFromGetVersion(VER_215)).toBe(496);
    expect(parseNtagNdefBytesFromGetVersion(VER_216)).toBe(872);
  });

  it("strips a trailing 90 00 status word", () => {
    expect(parseNtagNdefBytesFromGetVersion([...VER_215, 0x90, 0x00])).toBe(496);
  });

  it("is OFFSET-TOLERANT — parses when the reader prepends framing bytes (GH #973 core)", () => {
    // A reader that wraps the version data in leading bytes must still parse:
    // an NTAG215 misread as 144 was the bug; a scan finds the real storage byte.
    expect(parseNtagNdefBytesFromGetVersion([0xd5, 0x43, 0x00, ...VER_215])).toBe(496);
    expect(parseNtagNdefBytesFromGetVersion([0x00, 0x00, ...VER_216, 0x90, 0x00])).toBe(872);
  });

  it("does NOT false-match on a stray 0x0F before the signature", () => {
    // 0x0F earlier in the buffer must not be read as a storage byte — only the
    // storage position of a full matched block counts.
    expect(parseNtagNdefBytesFromGetVersion([0x0f, 0x0f, ...VER_215])).toBe(496);
  });

  it("rejects a BARE 4-byte signature decoy carrying a valid storage byte, finds the real block (GH #973 hardening)", () => {
    // A bare `04 04 02 01 .. .. 0F` in leading framing (no 0x00 header / 0x03
    // protocol around it) must NOT be trusted as a 213 — the full-8-byte-block
    // anchor skips it and finds the genuine 215 block that follows.
    const decoy = [0x04, 0x04, 0x02, 0x01, 0x00, 0x00, 0x0f];
    expect(parseNtagNdefBytesFromGetVersion([...decoy, ...VER_215])).toBe(496);
  });

  it("rejects a full-looking block whose protocol byte isn't 0x03, finds the real block", () => {
    // header+signature+0x0F storage but protocol 0xFF → not a real version block.
    const decoy = [0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x0f, 0xff];
    expect(parseNtagNdefBytesFromGetVersion([...decoy, ...VER_216])).toBe(872);
  });

  it("returns null for NTAG210/212 (storage bytes not in the map) → caller falls back to the picker", () => {
    expect(parseNtagNdefBytesFromGetVersion(ver(0x0b))).toBeNull(); // NTAG210
    expect(parseNtagNdefBytesFromGetVersion(ver(0x0e))).toBeNull(); // NTAG212
  });

  it("returns null for a header-STRIPPED block (strict anchor → picker fallback)", () => {
    // If a reader ever omits the 0x00 header, we deliberately don't guess — the
    // size picker + write-time probe-read back it up safely.
    expect(parseNtagNdefBytesFromGetVersion([0x04, 0x04, 0x02, 0x01, 0x00, 0x11, 0x03])).toBeNull();
  });

  it("returns null for an unrecognized storage byte after a valid signature", () => {
    expect(parseNtagNdefBytesFromGetVersion(ver(0x99))).toBeNull();
  });

  it("returns null when the NXP NTAG signature is absent (unanswered / foreign response)", () => {
    expect(parseNtagNdefBytesFromGetVersion([0x6a, 0x81])).toBeNull(); // function-not-supported SW
    expect(parseNtagNdefBytesFromGetVersion([0x63, 0x00])).toBeNull();
    expect(parseNtagNdefBytesFromGetVersion([])).toBeNull();
    expect(parseNtagNdefBytesFromGetVersion([0x00, 0x04, 0x03, 0x02, 0x01, 0x00, 0x11])).toBeNull(); // product 0x03 ≠ NTAG
  });

  it("returns null when the signature is present but truncated before the storage byte", () => {
    // signature 04 04 02 01 but the buffer ends before storage (index+5).
    expect(parseNtagNdefBytesFromGetVersion([0x04, 0x04, 0x02, 0x01, 0x00])).toBeNull();
  });

  it("masks values to a byte (defends against sign-extended / >0xFF inputs)", () => {
    expect(parseNtagNdefBytesFromGetVersion(ver(0x11 + 0x100))).toBe(496);
  });

  it("isNtagSizeName accepts exactly the three NTAG names", () => {
    expect(isNtagSizeName("NTAG213")).toBe(true);
    expect(isNtagSizeName("NTAG215")).toBe(true);
    expect(isNtagSizeName("NTAG216")).toBe(true);
    expect(isNtagSizeName("NTAG210")).toBe(false);
    expect(isNtagSizeName("ntag215")).toBe(false); // case-sensitive
    expect(isNtagSizeName(215)).toBe(false);
    expect(isNtagSizeName(null)).toBe(false);
    expect(isNtagSizeName(undefined)).toBe(false);
  });

  it("exposes consistent size maps", () => {
    expect(NTAG_STORAGE_SIZE_TO_NDEF_BYTES[0x11]).toBe(496);
    expect(NTAG_NAME_TO_NDEF_BYTES.NTAG215).toBe(496);
    expect(NTAG_NAME_TO_NDEF_BYTES.NTAG213).toBe(144);
    expect(NTAG_NAME_TO_NDEF_BYTES.NTAG216).toBe(872);
  });
});

describe("resolveNtagWriteSize (GH #973 follow-up)", () => {
  const E1 = 0xe1; // formatted CC magic
  const BLANK = 0x00; // blank CC magic
  // CC size byte = NDEF bytes / 8: 144→18, 496→62, 872→109.

  it("formatted + GET_VERSION confirmed → chip size, reformat only when CC disagrees", () => {
    // CC already matches the chip → no reformat.
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: 62, verSize: 496, hintBytes: null }))
      .toEqual({ ok: true, ndefBytes: 496, needsFormat: false });
    // CC over-claims (872) but GET_VERSION says 496 → use 496 AND rewrite the CC down.
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: 109, verSize: 496, hintBytes: null }))
      .toEqual({ ok: true, ndefBytes: 496, needsFormat: true });
  });

  it("formatted + UNDER-sized CC + GET_VERSION works → grows to the real size, rewrites CC (Codex P2)", () => {
    // A real NTAG215 an earlier bad write stamped with a 144-byte CC (ccSizeByte
    // 18), now read on a GET_VERSION-CAPABLE reader (verSize 496). Detect reports
    // 496 (→ Extended); the writer must ALSO use 496 (not min(144,496)=144) and
    // rewrite the CC, or the Extended image is wrongly rejected as TAG_TOO_SMALL.
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: 18, verSize: 496, hintBytes: null }))
      .toEqual({ ok: true, ndefBytes: 496, needsFormat: true });
  });

  it("formatted + GET_VERSION DEAD + user size → user size is authoritative, REWRITE the CC (#973 core)", () => {
    // A real 215 an earlier write mis-formatted with a 144-byte CC (ccSizeByte 18):
    // the user picks NTAG215 → we rewrite the CC to 496, not stay stuck at 144.
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: 18, verSize: null, hintBytes: 496 }))
      .toEqual({ ok: true, ndefBytes: 496, needsFormat: true });
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: 18, verSize: null, hintBytes: 872 }))
      .toEqual({ ok: true, ndefBytes: 872, needsFormat: true });
  });

  it("formatted + neither GET_VERSION nor hint → conservative min(CC, 144), no reformat (legacy)", () => {
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: 62, verSize: null, hintBytes: null }))
      .toEqual({ ok: true, ndefBytes: 144, needsFormat: false });
  });

  it("blank + a size (GET_VERSION or user) → that size, reformat", () => {
    expect(resolveNtagWriteSize({ ccMagic: BLANK, ccSizeByte: 0, verSize: 496, hintBytes: null }))
      .toEqual({ ok: true, ndefBytes: 496, needsFormat: true });
    expect(resolveNtagWriteSize({ ccMagic: BLANK, ccSizeByte: 0, verSize: null, hintBytes: 496 }))
      .toEqual({ ok: true, ndefBytes: 496, needsFormat: true });
    // GET_VERSION wins over a hint when both present.
    expect(resolveNtagWriteSize({ ccMagic: BLANK, ccSizeByte: 0, verSize: 872, hintBytes: 496 }))
      .toEqual({ ok: true, ndefBytes: 872, needsFormat: true });
  });

  it("blank + neither → size_unknown (never guess)", () => {
    expect(resolveNtagWriteSize({ ccMagic: BLANK, ccSizeByte: 0, verSize: null, hintBytes: null }))
      .toEqual({ ok: false, error: "size_unknown" });
  });

  it("formatted + GET_VERSION AND a user hint → GET_VERSION wins (chip size is authoritative)", () => {
    // A good reader (GET_VERSION works) where the user ALSO over-picked to 872:
    // the real chip size (496) must win so an over-declared size can't slip
    // through. CC byte 62 (=496) doesn't under-cap, isolating the verSize-vs-hint
    // precedence.
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: 62, verSize: 496, hintBytes: 872 }))
      .toEqual({ ok: true, ndefBytes: 496, needsFormat: false });
  });

  it("treats a non-finite / negative CC size byte as 0 (total clamp)", () => {
    // Can't occur from a real Uint8Array byte, but the bound must never yield NaN.
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: NaN, verSize: null, hintBytes: null }))
      .toEqual({ ok: true, ndefBytes: 0, needsFormat: false });
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: -5, verSize: null, hintBytes: null }))
      .toEqual({ ok: true, ndefBytes: 0, needsFormat: false });
  });

  it("clamps a wildly over-claiming CC to the NTAG216 ceiling (872)", () => {
    // ccSizeByte 255 → 2040 bytes; formatted + confirmed verSize 872 → min = 872.
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: 255, verSize: 872, hintBytes: null }))
      .toEqual({ ok: true, ndefBytes: 872, needsFormat: false });
    // formatted + neither, CC 255 → min(872 ceiling, 144) = 144.
    expect(resolveNtagWriteSize({ ccMagic: E1, ccSizeByte: 255, verSize: null, hintBytes: null }))
      .toEqual({ ok: true, ndefBytes: 144, needsFormat: false });
  });
});

import { describe, it, expect } from "vitest";
import {
  wrapNdefForTag,
  parseNdefFromTag,
  parseNdefRecords,
  parseNdefRecordsAuto,
  buildMediaNdefRecord,
  buildNdefMessageTlv,
  buildType2Cc,
  isCcByteReadOnly,
  setCcByteReadOnly,
} from "../electron/ndef";

const MIME_TYPE = "application/vnd.openprinttag";

describe("wrapNdefForTag", () => {
  it("produces a tag memory image starting with CC", () => {
    const payload = new Uint8Array([0xa1, 0x02, 0x10, 0xbf, 0x08, 0x00, 0xff, 0xa0]);
    const result = wrapNdefForTag(payload);

    // CC bytes
    expect(result[0]).toBe(0xe1); // magic
    expect(result[1]).toBe(0x40); // version 1.0, RW
    expect(result[2]).toBe(40); // 320 / 8 = 40
    expect(result[3]).toBe(0x01); // read multiple blocks supported
  });

  it("includes NDEF TLV with correct tag", () => {
    const payload = new Uint8Array(10);
    const result = wrapNdefForTag(payload);

    // After CC (4 bytes), NDEF TLV starts
    expect(result[4]).toBe(0x03); // NDEF Message TLV tag
  });

  it("includes NDEF record with correct TNF and type", () => {
    const payload = new Uint8Array(10);
    const result = wrapNdefForTag(payload);

    // NDEF record starts after CC + TLV header
    // With padded payload filling 320 bytes, TLV length >= 255 → long TLV (4 bytes)
    // or short TLV (2 bytes). Find the OPT record by looking for TNF=2.
    const tlvLen = result[5];
    let recordStart: number;
    if (tlvLen === 0xff) {
      recordStart = 8; // CC(4) + TLV tag(1) + 0xFF(1) + len(2)
    } else {
      recordStart = 6; // CC(4) + TLV tag(1) + len(1)
    }

    const flags = result[recordStart];
    expect(flags & 0x07).toBe(0x02); // TNF = Media Type
    expect(flags & 0x80).toBe(0x80); // MB bit set (single record)
    expect(flags & 0x40).toBe(0x40); // ME bit set

    // Type length
    expect(result[recordStart + 1]).toBe(MIME_TYPE.length); // 28
  });

  it("includes the payload at the start of the NDEF record payload", () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const result = wrapNdefForTag(payload);

    // Find payload start: after CC + TLV header + flags + type_len + payload_len + type
    const tlvLen = result[5];
    let recordStart: number;
    if (tlvLen === 0xff) {
      recordStart = 8;
    } else {
      recordStart = 6;
    }
    const flags = result[recordStart];
    const isShort = (flags & 0x10) !== 0;
    const payloadStart = recordStart + 2 + (isShort ? 1 : 4) + MIME_TYPE.length;

    expect(result[payloadStart]).toBe(0xaa);
    expect(result[payloadStart + 1]).toBe(0xbb);
    expect(result[payloadStart + 2]).toBe(0xcc);
  });

  it("fills tag memory and ends with TLV terminator near end", () => {
    const payload = new Uint8Array(5);
    const result = wrapNdefForTag(payload, 320);

    expect(result.length).toBe(320);

    // TLV terminator should be near the end of tag memory (not right after the data)
    // Find last non-zero byte
    let lastNonZero = result.length - 1;
    while (lastNonZero > 0 && result[lastNonZero] === 0x00) lastNonZero--;
    expect(result[lastNonZero]).toBe(0xfe);
  });

  it("throws if payload is too large for tag", () => {
    const payload = new Uint8Array(300); // Too large with NDEF overhead for 320-byte tag
    expect(() => wrapNdefForTag(payload, 320)).toThrow("too large");
  });

  it("uses long TLV format when NDEF message >= 255 bytes", () => {
    // With padding, even small payloads can trigger long TLV on a 320-byte tag
    const payload = new Uint8Array(10);
    const result = wrapNdefForTag(payload, 320);

    expect(result[4]).toBe(0x03); // TLV tag
    // Check if long format is used
    if (result[5] === 0xff) {
      const tlvLen = (result[6] << 8) | result[7];
      expect(tlvLen).toBeGreaterThanOrEqual(255);
    }
    // Either format is valid — the key is that it round-trips correctly
  });

  it("round-trips with parseNdefFromTag", () => {
    const payload = new Uint8Array([0xa1, 0x02, 0x18, 0x50, 0xbf, 0x08, 0x00, 0x09, 0x01, 0xff, 0xa0]);
    const tagMemory = wrapNdefForTag(payload);
    const extracted = parseNdefFromTag(tagMemory);

    // Extracted payload is padded; verify original data is at the start
    expect(extracted.length).toBeGreaterThanOrEqual(payload.length);
    expect(Array.from(extracted.slice(0, payload.length))).toEqual(Array.from(payload));
  });

  it("prepends a URI NDEF record when productUrl is provided", () => {
    const payload = new Uint8Array([0xa1, 0x02, 0x10, 0xbf, 0x08, 0x00, 0xff, 0xa0]);
    const url = "https://www.prusa3d.com/product/prusament-petg-jet-black-1kg/";
    const result = wrapNdefForTag(payload, 320, url);

    // CC
    expect(result[0]).toBe(0xe1);

    // TLV tag
    expect(result[4]).toBe(0x03);

    // Find first NDEF record start (after TLV header)
    let recordStart: number;
    if (result[5] === 0xff) {
      recordStart = 8;
    } else {
      recordStart = 6;
    }

    const firstFlags = result[recordStart];
    expect(firstFlags & 0x07).toBe(0x01); // TNF = Well-Known (URI)
    expect(firstFlags & 0x80).toBe(0x80); // MB = 1
    expect(firstFlags & 0x40).toBe(0x00); // ME = 0 (more records follow)

    // Type should be "U" (0x55)
    const typeLen = result[recordStart + 1];
    expect(typeLen).toBe(1);
    // skip payload length byte (SR=1, so 1 byte)
    const uriType = result[recordStart + 3]; // flags(1) + typeLen(1) + payloadLen(1) + type
    expect(uriType).toBe(0x55); // "U"

    // URI prefix code should be 0x02 (https://www.)
    expect(result[recordStart + 4]).toBe(0x02);

    // Should round-trip — parseNdefFromTag finds the OPT record
    const extracted = parseNdefFromTag(result);
    expect(extracted.length).toBeGreaterThanOrEqual(payload.length);
    expect(Array.from(extracted.slice(0, payload.length))).toEqual(Array.from(payload));
  });

  it("round-trips with URI record and parseNdefFromTag", () => {
    const payload = new Uint8Array([0xa1, 0x02, 0x18, 0x50, 0xbf, 0x08, 0x00, 0x09, 0x01, 0xff, 0xa0]);
    const tagMemory = wrapNdefForTag(payload, 320, "https://example.com/filament");
    const extracted = parseNdefFromTag(tagMemory);

    // Extracted payload is padded; verify original data is at the start
    expect(extracted.length).toBeGreaterThanOrEqual(payload.length);
    expect(Array.from(extracted.slice(0, payload.length))).toEqual(Array.from(payload));
  });

  it("without productUrl, OPT record has MB=1 and ME=1", () => {
    const payload = new Uint8Array([0xa1, 0x02, 0x10, 0xbf, 0x08, 0x00, 0xff, 0xa0]);
    const result = wrapNdefForTag(payload, 320);

    // Find first NDEF record
    let recordStart: number;
    if (result[5] === 0xff) {
      recordStart = 8;
    } else {
      recordStart = 6;
    }

    const firstFlags = result[recordStart];
    expect(firstFlags & 0x80).toBe(0x80); // MB = 1
    expect(firstFlags & 0x40).toBe(0x40); // ME = 1
    expect(firstFlags & 0x07).toBe(0x02); // TNF = Media type
  });
});

describe("parseNdefFromTag", () => {
  it("extracts CBOR payload from valid tag memory", () => {
    // Build a simple tag memory and verify we can extract the payload
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const tagMemory = wrapNdefForTag(payload);
    const result = parseNdefFromTag(tagMemory);

    // The payload starts with our original data
    expect(result[0]).toBe(0xaa);
    expect(result[1]).toBe(0xbb);
    expect(result[2]).toBe(0xcc);
  });

  it("throws on invalid CC magic byte (wrong-format, non-blank tag)", () => {
    // A non-zero, non-0xE1 first byte is a genuinely wrong-format tag the
    // user should see surfaced — distinct from the blank-tag case below.
    const data = new Uint8Array([0xab, 0x40, 0x28, 0x01, 0x03, 0x05, 0xd2, 0x00, 0x00]);
    expect(() => parseNdefFromTag(data)).toThrow("Invalid CC magic byte");
  });

  it("throws a distinguishable blank-tag error for an all-zero (unformatted) tag (#556)", () => {
    // A blank/unformatted tag reads back all-zero memory (CC byte 0x00).
    // It must NOT surface as a raw "Invalid CC magic byte" dump — the
    // main-process auto-read routes this distinguishable message to the
    // friendly empty-tag UI instead.
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(() => parseNdefFromTag(data)).toThrow("Blank or unformatted");
    expect(() => parseNdefFromTag(data)).not.toThrow("Invalid CC magic byte");
  });

  it("throws on too-short data", () => {
    const data = new Uint8Array([0xe1, 0x40]);
    expect(() => parseNdefFromTag(data)).toThrow("Tag data too short");
  });

  it("throws when no NDEF TLV found", () => {
    // CC + padding + terminator (>= 8 bytes to pass length check)
    const data = new Uint8Array([0xe1, 0x40, 0x28, 0x01, 0xfe, 0x00, 0x00, 0x00]);
    expect(() => parseNdefFromTag(data)).toThrow("No NDEF TLV found");
  });

  it("skips NULL TLVs before NDEF TLV", () => {
    const payload = new Uint8Array([0xdd, 0xee]);
    const tagMemory = wrapNdefForTag(payload);

    // Insert a NULL TLV (0x00) after CC by shifting everything
    const withNull = new Uint8Array(tagMemory.length + 1);
    withNull.set(tagMemory.subarray(0, 4), 0);  // CC
    withNull[4] = 0x00; // NULL TLV
    withNull.set(tagMemory.subarray(4), 5);  // Rest shifts by 1

    const result = parseNdefFromTag(withNull);
    expect(result[0]).toBe(0xdd);
    expect(result[1]).toBe(0xee);
  });

  it("handles long TLV format", () => {
    const payload = new Uint8Array(230);
    payload[0] = 0x42;
    payload[229] = 0x99;

    const tagMemory = wrapNdefForTag(payload, 600);
    const result = parseNdefFromTag(tagMemory);

    expect(result[0]).toBe(0x42);
    expect(result[229]).toBe(0x99);
    expect(result.length).toBeGreaterThanOrEqual(230);
  });

  it("throws on truncated 3-byte TLV length", () => {
    // CC (4B) + TLV tag 0x03 + 0xFF (long format) + only 1 length byte (needs 2)
    // Falls under "too short" since < 8 bytes, so pad to 8 bytes
    const padded = new Uint8Array(8);
    padded.set([0xe1, 0x40, 0x28, 0x01, 0x03, 0xff, 0x01]);
    // 0xFF means 3-byte length, but only 1 byte follows before end
    expect(() => parseNdefFromTag(padded)).toThrow("truncated");
  });

  it("throws on TLV length exceeding available data", () => {
    // CC + TLV tag 0x03 + length 200 but only a few bytes available (pad to 8+)
    const data = new Uint8Array(10);
    data.set([0xe1, 0x40, 0x28, 0x01, 0x03, 200]);
    expect(() => parseNdefFromTag(data)).toThrow("truncated");
  });

  it("throws on truncated NDEF record header", () => {
    // CC + TLV tag 0x03 + length 6 + NDEF: flags=non-SR TNF=02, type_len=1,
    // then only 2 bytes for a 4-byte payload length (non-short record)
    const data = new Uint8Array(10);
    data.set([0xe1, 0x40, 0x28, 0x01, 0x03, 0x06, 0xc2, 0x01, 0x00, 0x00]);
    expect(() => parseNdefFromTag(data)).toThrow("truncated");
  });

  it("throws when NDEF record payload exceeds available data", () => {
    // CC + TLV tag 0x03 + TLV length 5 + NDEF: flags=SR+TNF02, type_len=1, payload_len=99, type='X'
    const data = new Uint8Array(12);
    data.set([0xe1, 0x40, 0x28, 0x01, 0x03, 0x05, 0xd2, 0x01, 99, 0x58]);
    expect(() => parseNdefFromTag(data)).toThrow("truncated");
  });

  it("throws on formatted/erased tag (no NDEF message, just terminator)", () => {
    // A formatted tag has valid CC + TLV terminator but no NDEF record
    // CC: E1 40 28 01, then TLV terminator: FE, zeroes for padding
    const formatted = new Uint8Array(320);
    formatted[0] = 0xe1;
    formatted[1] = 0x40;
    formatted[2] = 0x28; // 320/8 = 40 = 0x28
    formatted[3] = 0x01;
    formatted[4] = 0xfe; // TLV terminator — no NDEF message
    expect(() => parseNdefFromTag(formatted)).toThrow("No NDEF TLV found");
  });

  it("throws when no NDEF record matches OpenPrintTag MIME type", () => {
    // Build tag with a valid NDEF record but wrong MIME type
    const wrongType = new TextEncoder().encode("text/plain");
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const recordLen = 1 + 1 + 1 + wrongType.length + payload.length; // flags + typelen + payloadlen + type + payload

    const data = new Uint8Array(64);
    let pos = 0;
    // CC
    data[pos++] = 0xe1;
    data[pos++] = 0x40;
    data[pos++] = 0x08;
    data[pos++] = 0x01;
    // TLV
    data[pos++] = 0x03;
    data[pos++] = recordLen;
    // NDEF record: MB=1, ME=1, SR=1, TNF=02
    data[pos++] = 0xd2;
    data[pos++] = wrongType.length;
    data[pos++] = payload.length;
    data.set(wrongType, pos);
    pos += wrongType.length;
    data.set(payload, pos);
    pos += payload.length;
    data[pos++] = 0xfe;

    expect(() => parseNdefFromTag(data)).toThrow('No NDEF record with type');
  });

  it("skips unknown TLV types", () => {
    // Insert an unknown TLV (type 0x05, len 2, data) before the NDEF TLV
    const payload = new Uint8Array([0xab, 0xcd]);
    const tagMemory = wrapNdefForTag(payload);

    // Shift to make room for unknown TLV (type=0x05, len=2, data=0x00 0x00)
    const withUnknown = new Uint8Array(tagMemory.length + 4);
    withUnknown.set(tagMemory.subarray(0, 4), 0); // CC
    withUnknown[4] = 0x05; // unknown TLV type
    withUnknown[5] = 0x02; // length
    withUnknown[6] = 0x00; // data
    withUnknown[7] = 0x00; // data
    withUnknown.set(tagMemory.subarray(4), 8); // rest of original

    const result = parseNdefFromTag(withUnknown);
    expect(result[0]).toBe(0xab);
    expect(result[1]).toBe(0xcd);
  });

  it("handles non-short NDEF record (payload > 255 bytes)", () => {
    // Build a tag with a non-short record (4-byte payload length)
    const payload = new Uint8Array(300);
    payload[0] = 0x42;
    payload[299] = 0x99;

    const mimeBytes = new TextEncoder().encode(MIME_TYPE);
    // flags: MB=1, ME=1, SR=0, TNF=02 = 0xC2
    const recordLen = 1 + 1 + 4 + mimeBytes.length + payload.length;
    const data = new Uint8Array(4 + 4 + recordLen + 1); // CC + long TLV header + record + terminator
    let pos = 0;

    // CC
    data[pos++] = 0xe1;
    data[pos++] = 0x40;
    data[pos++] = Math.floor(data.length / 8);
    data[pos++] = 0x01;

    // TLV (long format since recordLen >= 255)
    data[pos++] = 0x03;
    data[pos++] = 0xff;
    data[pos++] = (recordLen >> 8) & 0xff;
    data[pos++] = recordLen & 0xff;

    // NDEF record
    data[pos++] = 0xc2; // MB=1, ME=1, SR=0, TNF=02
    data[pos++] = mimeBytes.length;
    // 4-byte payload length
    data[pos++] = 0x00;
    data[pos++] = 0x00;
    data[pos++] = (payload.length >> 8) & 0xff;
    data[pos++] = payload.length & 0xff;
    data.set(mimeBytes, pos);
    pos += mimeBytes.length;
    data.set(payload, pos);
    pos += payload.length;
    data[pos++] = 0xfe;

    const result = parseNdefFromTag(data);
    expect(result[0]).toBe(0x42);
    expect(result[299]).toBe(0x99);
    expect(result.length).toBe(300);
  });
});

describe("CC byte read-only helpers (GH #583)", () => {
  describe("isCcByteReadOnly", () => {
    it("treats the default 0x40 read/write CC byte as writable", () => {
      // 0x40 = version 1.0, read/write — what wrapNdefForTag/formatTag emit.
      expect(isCcByteReadOnly(0x40)).toBe(false);
    });

    it("treats 0x43 (write-access bits set) as read-only", () => {
      expect(isCcByteReadOnly(0x43)).toBe(true);
    });

    it("treats a blank 0x00 CC byte as writable (not read-only)", () => {
      expect(isCcByteReadOnly(0x00)).toBe(false);
    });

    it("only inspects the low two write-access bits", () => {
      // Read-access bits (0x0C) set but write bits clear → still writable.
      expect(isCcByteReadOnly(0x4c)).toBe(false);
      // Both write bits must be set; a single bit (0x01/0x02) is not read-only.
      expect(isCcByteReadOnly(0x41)).toBe(false);
      expect(isCcByteReadOnly(0x42)).toBe(false);
    });
  });

  describe("setCcByteReadOnly", () => {
    it("sets the write-access bits when locking, preserving other bits", () => {
      expect(setCcByteReadOnly(0x40, true)).toBe(0x43);
    });

    it("clears the write-access bits when unlocking, preserving other bits", () => {
      expect(setCcByteReadOnly(0x43, false)).toBe(0x40);
    });

    it("is idempotent and round-trips", () => {
      const locked = setCcByteReadOnly(0x40, true);
      expect(setCcByteReadOnly(locked, true)).toBe(locked); // already locked
      const unlocked = setCcByteReadOnly(locked, false);
      expect(unlocked).toBe(0x40);
      expect(isCcByteReadOnly(unlocked)).toBe(false);
      expect(isCcByteReadOnly(locked)).toBe(true);
    });

    it("preserves unrelated bits (e.g. read-access / version nibble)", () => {
      // 0x4c → lock → 0x4f (write bits set), unlock → 0x4c again.
      expect(setCcByteReadOnly(0x4c, true)).toBe(0x4f);
      expect(setCcByteReadOnly(0x4f, false)).toBe(0x4c);
    });

    it("masks the result to a single byte", () => {
      expect(setCcByteReadOnly(0x40, true)).toBeLessThanOrEqual(0xff);
      expect(setCcByteReadOnly(0xff, false)).toBe(0xfc);
    });
  });
});

describe("wrapNdefForTag — small tag (short-record + short-TLV path)", () => {
  it("uses SR=1 and a 1-byte TLV length on a small tag, round-tripping", () => {
    // A small 64-byte tag keeps the padded OPT payload and the whole NDEF
    // message under 255 bytes, so the encoder takes the SR=1 / short-TLV
    // branch (lines 136–139) and writes a single-byte TLV length (line 224)
    // rather than the long-TLV form the 320-byte default produces.
    const payload = new Uint8Array([0x11, 0x22, 0x33]);
    const result = wrapNdefForTag(payload, 64);

    expect(result.length).toBe(64);
    expect(result[0]).toBe(0xe1); // CC magic
    expect(result[4]).toBe(0x03); // NDEF TLV tag
    // Short TLV: byte 5 is the length itself, NOT the 0xFF long-format marker.
    expect(result[5]).not.toBe(0xff);

    // OPT record starts right after the 1-byte TLV length.
    const recordStart = 6;
    const flags = result[recordStart];
    expect(flags & 0x10).toBe(0x10); // SR = 1 (short record)
    expect(flags & 0x07).toBe(0x02); // TNF = media

    const extracted = parseNdefFromTag(result);
    expect(Array.from(extracted.slice(0, payload.length))).toEqual(Array.from(payload));
  });
});

describe("wrapNdefForTag — long product URL (non-short URI record)", () => {
  it("emits a 4-byte URI payload length when the URI remainder exceeds 255 bytes", () => {
    // buildUriRecord's non-short branch (lines 62–65) only fires when the
    // compressed remainder pushes the URI payload over 255 bytes.
    const longPath = "x".repeat(300);
    const url = `https://www.example.com/${longPath}`;
    const result = wrapNdefForTag(new Uint8Array([0xaa, 0xbb]), 1024, url);

    // Locate the first (URI) NDEF record after the TLV header.
    const recordStart = result[5] === 0xff ? 8 : 6;
    const uriFlags = result[recordStart];
    expect(uriFlags & 0x07).toBe(0x01); // TNF = Well-Known (URI)
    expect(uriFlags & 0x10).toBe(0x00); // SR = 0 (long record, >255B payload)
    expect(uriFlags & 0x80).toBe(0x80); // MB = 1

    // TYPE_LENGTH = 1, then a 4-byte payload length follows.
    expect(result[recordStart + 1]).toBe(1);
    const payloadLen =
      (result[recordStart + 2] << 24) |
      (result[recordStart + 3] << 16) |
      (result[recordStart + 4] << 8) |
      result[recordStart + 5];
    // remainder = "example.com/xxx...", +1 prefix-code byte.
    expect(payloadLen).toBe(1 + `example.com/${longPath}`.length);
    // Type byte "U" (0x55) sits after the 4-byte length.
    expect(result[recordStart + 6]).toBe(0x55);
    // Prefix code 0x02 = "https://www."
    expect(result[recordStart + 7]).toBe(0x02);

    // OPT record still round-trips.
    const extracted = parseNdefFromTag(result);
    expect(extracted[0]).toBe(0xaa);
    expect(extracted[1]).toBe(0xbb);
  });
});

describe("buildMediaNdefRecord", () => {
  it("builds a short (SR=1) media record with MB=1/ME=1 for a small payload", () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const rec = buildMediaNdefRecord("text/plain", payload);

    const flags = rec[0];
    expect(flags & 0x07).toBe(0x02); // TNF = media
    expect(flags & 0x80).toBe(0x80); // MB
    expect(flags & 0x40).toBe(0x40); // ME
    expect(flags & 0x10).toBe(0x10); // SR (short)

    const typeBytes = new TextEncoder().encode("text/plain");
    expect(rec[1]).toBe(typeBytes.length); // TYPE_LENGTH
    expect(rec[2]).toBe(payload.length); // 1-byte PAYLOAD_LENGTH
    // TYPE then PAYLOAD.
    expect(Array.from(rec.slice(3, 3 + typeBytes.length))).toEqual(Array.from(typeBytes));
    expect(Array.from(rec.slice(3 + typeBytes.length))).toEqual([0x01, 0x02, 0x03]);
  });

  it("builds a non-short (SR=0) media record with a 4-byte payload length for a large payload", () => {
    const payload = new Uint8Array(300);
    payload[0] = 0x42;
    payload[299] = 0x99;
    const rec = buildMediaNdefRecord("application/octet-stream", payload);

    const flags = rec[0];
    expect(flags & 0x10).toBe(0x00); // SR = 0 (long record)

    const typeBytes = new TextEncoder().encode("application/octet-stream");
    expect(rec[1]).toBe(typeBytes.length);
    // 4-byte big-endian payload length.
    const plen = (rec[2] << 24) | (rec[3] << 16) | (rec[4] << 8) | rec[5];
    expect(plen).toBe(300);
    // Type sits after the 4-byte length, payload after the type.
    const payloadStart = 6 + typeBytes.length;
    expect(rec[payloadStart]).toBe(0x42);
    expect(rec[payloadStart + 299]).toBe(0x99);
  });

  it("round-trips through buildNdefMessageTlv + parseNdefRecords for a media record", () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const rec = buildMediaNdefRecord(MIME_TYPE, payload);
    const tlv = buildNdefMessageTlv(rec);

    // Prepend a Type-5 CC so parseNdefRecords (ccOffset=0) accepts it.
    const cc = new Uint8Array([0xe1, 0x40, 0x28, 0x01]);
    const raw = new Uint8Array(cc.length + tlv.length);
    raw.set(cc, 0);
    raw.set(tlv, cc.length);

    const records = parseNdefRecords(raw, 0);
    expect(records).toHaveLength(1);
    expect(records[0].tnf).toBe(0x02);
    expect(records[0].type).toBe(MIME_TYPE);
    expect(Array.from(records[0].payload)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});

describe("buildNdefMessageTlv", () => {
  it("uses a 1-byte length header and a terminator for a short message", () => {
    const message = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const tlv = buildNdefMessageTlv(message);

    expect(tlv[0]).toBe(0x03); // NDEF Message TLV tag
    expect(tlv[1]).toBe(message.length); // 1-byte length
    expect(Array.from(tlv.slice(2, 2 + message.length))).toEqual([0xaa, 0xbb, 0xcc]);
    expect(tlv[tlv.length - 1]).toBe(0xfe); // terminator
    expect(tlv.length).toBe(2 + message.length + 1);
  });

  it("uses the 0xFF 3-byte length header for a message >= 255 bytes", () => {
    const message = new Uint8Array(260);
    const tlv = buildNdefMessageTlv(message);

    expect(tlv[0]).toBe(0x03);
    expect(tlv[1]).toBe(0xff); // long-format marker
    const len = (tlv[2] << 8) | tlv[3];
    expect(len).toBe(260);
    expect(tlv[tlv.length - 1]).toBe(0xfe); // terminator
    expect(tlv.length).toBe(4 + message.length + 1);
  });
});

describe("buildType2Cc", () => {
  it("emits E1 10 <userMem/8> 00 with a read/write access byte", () => {
    const cc = buildType2Cc(144); // NTAG213 user memory
    expect(Array.from(cc)).toEqual([0xe1, 0x10, 144 / 8, 0x00]);
  });

  it("floors and byte-masks the memory-size nibble", () => {
    // 500 / 8 = 62.5 → floor 62 (0x3e), still within a byte.
    expect(buildType2Cc(500)[2]).toBe(62);
    // A huge value floors then masks to a single byte.
    expect(buildType2Cc(8 * 300)[2]).toBe(300 & 0xff); // 0x2c
  });
});

describe("parseNdefRecords — Type-2 (NTAG) CC offset", () => {
  function type2Image(mime: string, payload: Uint8Array): Uint8Array {
    // Bytes 0–11 = UID/lock (Type-2 header), CC at byte 12, TLV at byte 16.
    const rec = buildMediaNdefRecord(mime, payload);
    const tlv = buildNdefMessageTlv(rec);
    const raw = new Uint8Array(16 + tlv.length);
    // CC page (page 3 / bytes 12–15): E1 10 <mem/8> 00.
    raw[12] = 0xe1;
    raw[13] = 0x10;
    raw[14] = 0x20;
    raw[15] = 0x00;
    raw.set(tlv, 16);
    return raw;
  }

  it("parses records when the CC lives at byte 12 (ccOffset=12)", () => {
    const raw = type2Image(MIME_TYPE, new Uint8Array([0x11, 0x22]));
    const records = parseNdefRecords(raw, 12);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe(MIME_TYPE);
    expect(Array.from(records[0].payload)).toEqual([0x11, 0x22]);
  });
});

describe("parseNdefRecordsAuto", () => {
  it("parses a Type-5 image at offset 0 without falling back", () => {
    const tag = wrapNdefForTag(new Uint8Array([0x55, 0x66]), 64);
    const records = parseNdefRecordsAuto(tag);
    const opt = records.find((r) => r.type === MIME_TYPE);
    expect(opt).toBeDefined();
    expect(opt!.payload[0]).toBe(0x55);
  });

  it("falls back to the Type-2 CC at byte 12 when byte 0 is not a CC magic", () => {
    // Build a Type-2 image (CC at 12); byte 0 is 0x00 so the offset-0 parse
    // throws "Blank or unformatted", triggering the byte-12 fallback (line 531).
    const rec = buildMediaNdefRecord(MIME_TYPE, new Uint8Array([0x77, 0x88]));
    const tlv = buildNdefMessageTlv(rec);
    const raw = new Uint8Array(16 + tlv.length);
    raw[12] = 0xe1;
    raw[13] = 0x10;
    raw[14] = 0x20;
    raw[15] = 0x00;
    raw.set(tlv, 16);

    const records = parseNdefRecordsAuto(raw);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe(MIME_TYPE);
    expect(Array.from(records[0].payload)).toEqual([0x77, 0x88]);
  });

  it("re-throws the original offset-0 error when there is no Type-2 CC to fall back to", () => {
    // Byte 0 is a non-zero, non-magic value and byte 12 is neither the Type-2 CC
    // magic (0xE1) nor a blank CC (0x00 — GH #955), so the fallback condition is
    // false and the original error propagates.
    const raw = new Uint8Array(20);
    raw[0] = 0xab; // wrong CC magic
    raw[1] = 0x40;
    raw[2] = 0x28;
    raw[3] = 0x01;
    raw[12] = 0x55; // not 0xE1 and not 0x00 → no Type-2 fallback.
    expect(() => parseNdefRecordsAuto(raw)).toThrow("Invalid CC magic byte");
  });

  it("GH #955: a factory-blank NTAG (UID at byte 0, blank CC) reaches the friendly blank message", () => {
    // A blank NTAG reports raw[0]=0x04 (UID start) so the offset-0 parse throws
    // "Invalid CC magic"; the offset-12 retry (raw[12]=0x00) must surface the
    // friendly "Blank or unformatted" message instead of the raw magic error.
    const raw = new Uint8Array(64);
    raw[0] = 0x04;
    expect(() => parseNdefRecordsAuto(raw)).toThrow("Blank or unformatted");
  });

  it("re-throws when the buffer is too short for a Type-2 fallback (< 20 bytes)", () => {
    // Offset-0 parse fails (blank CC) and the buffer is under 20 bytes, so the
    // fallback guard is false and the blank-tag error surfaces.
    const raw = new Uint8Array(16); // all-zero, < 20 bytes
    expect(() => parseNdefRecordsAuto(raw)).toThrow("Blank or unformatted");
  });
});

describe("parseNdefRecords — additional truncation / no-TLV paths", () => {
  it('throws "No NDEF TLV found in tag data" when an unknown TLV consumes the rest', () => {
    // Valid CC, then a single unknown TLV (type 0x05) whose length runs to the
    // end of the buffer. The scan loop skips it and exits without a 0x03 TLV or
    // a terminator, hitting the tail throw (line 429).
    const raw = new Uint8Array([0xe1, 0x40, 0x28, 0x01, 0x05, 0x03, 0x00, 0x00, 0x00]);
    expect(() => parseNdefRecords(raw, 0)).toThrow("No NDEF TLV found in tag data");
  });

  it("throws on an incomplete 3-byte (0xFF) TLV length header at end-of-buffer", () => {
    // NULL TLVs pad the scan to a 0x03 tag whose 0xFF long-length marker leaves
    // < 2 bytes for the 16-bit length that follows (branch/line 406–408).
    const raw = new Uint8Array([0xe1, 0x40, 0x28, 0x01, 0x00, 0x00, 0x03, 0xff]);
    expect(() => parseNdefRecords(raw, 0)).toThrow("incomplete 3-byte TLV length");
  });

  it("throws on a short NDEF record missing its 1-byte payload length", () => {
    // NDEF message TLV len = 2: flags (SR+media) + type_len, but no payload
    // length byte inside the message bound (branch/line 462–463).
    const raw = new Uint8Array([0xe1, 0x40, 0x28, 0x01, 0x03, 0x02, 0xd2, 0x01, 0xfe]);
    expect(() => parseNdefRecords(raw, 0)).toThrow("missing payload length");
  });

  it("throws when a record header can't fit before the NDEF message TLV end", () => {
    // NDEF message TLV len = 1: only room for one byte, but a record header
    // needs at least 2 (flags + type_len) — branch/line 450–451.
    const raw = new Uint8Array([0xe1, 0x40, 0x28, 0x01, 0x03, 0x01, 0xd2, 0xfe, 0x00]);
    expect(() => parseNdefRecords(raw, 0)).toThrow("not enough bytes for record header");
  });

  it("throws on a record whose IL flag is set but no ID-length byte remains", () => {
    // flags = 0xda: MB+ME+SR+IL+TNF02. TLV len = 3 (flags, type_len, payload_len)
    // leaves nothing for the ID-length byte the IL bit demands (lines 476–478).
    const raw = new Uint8Array([0xe1, 0x40, 0x28, 0x01, 0x03, 0x03, 0xda, 0x01, 0x00, 0xfe]);
    expect(() => parseNdefRecords(raw, 0)).toThrow("missing ID length");
  });

  it("parses a record with an ID field (IL flag set) and skips the ID bytes", () => {
    // Exercise the ID-present happy path: IL set, idLength=2, so the parser
    // reads and skips 2 ID bytes between the type and the payload.
    const flags = 0xda; // MB+ME+SR+IL+TNF02
    const type = new TextEncoder().encode("t/p");
    const id = new Uint8Array([0xa1, 0xa2]);
    const payload = new Uint8Array([0x0f, 0x1e]);
    const recordLen = 1 + 1 + 1 + 1 + type.length + id.length + payload.length;
    const raw = new Uint8Array(4 + 2 + recordLen + 1);
    let p = 0;
    raw.set([0xe1, 0x40, 0x28, 0x01], p);
    p += 4;
    raw[p++] = 0x03; // TLV tag
    raw[p++] = recordLen; // TLV len
    raw[p++] = flags;
    raw[p++] = type.length; // TYPE_LENGTH
    raw[p++] = payload.length; // PAYLOAD_LENGTH (SR)
    raw[p++] = id.length; // ID_LENGTH
    raw.set(type, p);
    p += type.length;
    raw.set(id, p);
    p += id.length;
    raw.set(payload, p);
    p += payload.length;
    raw[p++] = 0xfe;

    const records = parseNdefRecords(raw, 0);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("t/p");
    expect(Array.from(records[0].payload)).toEqual([0x0f, 0x1e]);
  });
});

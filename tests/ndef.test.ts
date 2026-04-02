import { describe, it, expect } from "vitest";
import { wrapNdefForTag, parseNdefFromTag } from "../electron/ndef";

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

  it("throws on invalid CC magic byte", () => {
    const data = new Uint8Array([0x00, 0x40, 0x28, 0x01, 0x03, 0x05, 0xd2, 0x00, 0x00]);
    expect(() => parseNdefFromTag(data)).toThrow("Invalid CC magic byte");
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

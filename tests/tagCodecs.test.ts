import { describe, it, expect } from "vitest";
import {
  parseNdefRecords,
  buildMediaNdefRecord,
  buildNdefMessageTlv,
  buildType2Cc,
  type NdefRecord,
} from "../src/lib/ndef";
import {
  selectCodec,
  decodeFromNdefRecords,
  OPENPRINTTAG_MIME,
} from "../src/lib/tagCodecs";
import { encodeOpenTag3D, OPENTAG3D_MIME } from "../src/lib/opentag3d";

const OT3D_PAYLOAD = encodeOpenTag3D({
  material_base: "PETG",
  manufacturer: "3D-Fuel",
  color_name: "Emerald",
  color_1: { r: 0, g: 200, b: 100, a: 255 },
  print_temp: 240,
  bed_temp: 80,
  target_diameter: 1.75,
});

/** Assemble a Type-5 (SLIX2) tag image: CC at byte 0, then the NDEF TLV. */
function type5Image(mime: string, payload: Uint8Array, totalSize = 320): Uint8Array {
  const cc = new Uint8Array([0xe1, 0x40, Math.floor(totalSize / 8), 0x01]);
  const tlv = buildNdefMessageTlv(buildMediaNdefRecord(mime, payload));
  const img = new Uint8Array(totalSize);
  img.set(cc, 0);
  img.set(tlv, cc.length);
  return img;
}

/** Assemble a Type-2 (NTAG) tag image: 12 header bytes, CC at byte 12, TLV at byte 16. */
function type2Image(mime: string, payload: Uint8Array, userMem = 504): Uint8Array {
  const header = new Uint8Array(12); // UID / internal / lock bytes (don't care)
  const cc = buildType2Cc(userMem);
  const tlv = buildNdefMessageTlv(buildMediaNdefRecord(mime, payload));
  const img = new Uint8Array(16 + tlv.length + 8);
  img.set(header, 0);
  img.set(cc, 12);
  img.set(tlv, 16);
  return img;
}

describe("tag codec selection", () => {
  it("prefers OpenPrintTag when both records coexist on one tag", () => {
    const records: NdefRecord[] = [
      { tnf: 0x02, type: OPENTAG3D_MIME, payload: OT3D_PAYLOAD },
      { tnf: 0x02, type: OPENPRINTTAG_MIME, payload: new Uint8Array([0xa0]) },
    ];
    expect(selectCodec(records)?.codec.id).toBe("openprinttag");
  });

  it("selects OpenTag3D when only its record is present", () => {
    const records: NdefRecord[] = [{ tnf: 0x02, type: OPENTAG3D_MIME, payload: OT3D_PAYLOAD }];
    expect(selectCodec(records)?.codec.id).toBe("opentag3d");
  });

  it("returns null for an unrecognized record set (clean unknown-tag signal)", () => {
    const records: NdefRecord[] = [
      { tnf: 0x01, type: "U", payload: new Uint8Array([0x04]) }, // a URI record
      { tnf: 0x02, type: "text/plain", payload: new Uint8Array([0x41]) },
    ];
    expect(selectCodec(records)).toBeNull();
    expect(decodeFromNdefRecords(records)).toBeNull();
  });

  it("decodes an OpenTag3D record set to the shared shape", () => {
    const records: NdefRecord[] = [{ tnf: 0x02, type: OPENTAG3D_MIME, payload: OT3D_PAYLOAD }];
    const decoded = decodeFromNdefRecords(records);
    expect(decoded?.tagSource).toBe("opentag3d");
    expect(decoded?.materialType).toBe("PETG");
    expect(decoded?.brandName).toBe("3D-Fuel");
    expect(decoded?.nozzleTemp).toBe(240);
  });
});

describe("end-to-end: build image → parse NDEF → registry decode", () => {
  it("Type-5 (SLIX2) image with an OpenTag3D record", () => {
    const img = type5Image(OPENTAG3D_MIME, OT3D_PAYLOAD);
    const records = parseNdefRecords(img, 0);
    const decoded = decodeFromNdefRecords(records);
    expect(decoded?.tagSource).toBe("opentag3d");
    expect(decoded?.colorName).toBe("Emerald");
    expect(decoded?.color).toBe("#00C864");
  });

  it("Type-2 (NTAG) image — CC at byte 12, TLV at byte 16 — with an OpenTag3D record", () => {
    const img = type2Image(OPENTAG3D_MIME, OT3D_PAYLOAD);
    const records = parseNdefRecords(img, 12);
    expect(records.some((r) => r.type === OPENTAG3D_MIME)).toBe(true);
    const decoded = decodeFromNdefRecords(records);
    expect(decoded?.tagSource).toBe("opentag3d");
    expect(decoded?.materialType).toBe("PETG");
    expect(decoded?.bedTemp).toBe(80);
  });

  it("a blank Type-2 image throws the friendly blank-tag error", () => {
    const blank = new Uint8Array(40); // all-zero → CC byte at 12 is 0x00
    expect(() => parseNdefRecords(blank, 12)).toThrow(/blank or unformatted/i);
  });
});

describe("Type-2 capability container", () => {
  it("encodes E1 10 <userMem/8> 00", () => {
    expect([...buildType2Cc(504)]).toEqual([0xe1, 0x10, 63, 0x00]);
    expect([...buildType2Cc(144)]).toEqual([0xe1, 0x10, 18, 0x00]);
  });
});

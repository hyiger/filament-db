import { describe, it, expect } from "vitest";
import { filamentToOpenTag3DFields, wrapOpenTag3DType2 } from "../src/lib/opentag3d-encode";
import { encodeOpenTag3D } from "../src/lib/opentag3d";
import { decodeOpenTag3DTag } from "../src/lib/opentag3d-decode";
import {
  buildType2Cc,
  isType2CcReadOnly,
  setType2CcReadOnly,
  parseNdefRecords,
} from "../src/lib/ndef";
import { decodeFromNdefRecords } from "../src/lib/tagCodecs";

describe("filamentToOpenTag3DFields → encode → decode round-trip", () => {
  const filament = {
    type: "PETG", // ≤5 bytes so material_base round-trips
    vendor: "Polar Filament",
    colorName: "Sky Blue",
    color: "#1E90FF",
    diameter: 1.75,
    netFilamentWeight: 1000,
    density: 1.27,
    temperatures: { nozzle: 240, bed: 80, nozzleRangeMin: 230, nozzleRangeMax: 250 },
    dryingTemperature: 65,
    dryingTime: 480, // minutes
    maxVolumetricSpeed: 15,
    spoolWeight: 105,
  };

  it("round-trips the core fields through a decode", () => {
    const { fields, notices } = filamentToOpenTag3DFields(filament, { spoolInstanceId: "abc1234567" });
    expect(notices).toEqual([]);
    const decoded = decodeOpenTag3DTag(encodeOpenTag3D(fields));
    expect(decoded.tagSource).toBe("opentag3d");
    expect(decoded.materialType).toBe("PETG");
    expect(decoded.brandName).toBe("Polar Filament");
    expect(decoded.colorName).toBe("Sky Blue");
    expect(decoded.color).toBe("#1E90FF");
    expect(decoded.diameter as number).toBeCloseTo(1.75, 5);
    expect(decoded.density as number).toBeCloseTo(1.27, 5);
    expect(decoded.weightGrams).toBe(1000);
    expect(decoded.emptySpoolWeight).toBe(105);
    expect(decoded.dryingTemperature).toBe(65);
    expect(decoded.dryingTime).toBe(480); // 480min → 8h on tag → ×60 back
    expect(decoded.maxVolumetricSpeed).toBe(15);
    // range present → nozzleTemp = max, min surfaced; recommended (240) rides aux
    expect(decoded.nozzleTemp).toBe(250);
    expect(decoded.nozzleTempMin).toBe(230);
    expect(decoded.bedTemp).toBe(80);
    expect(decoded.aux?.opentag3d_serial).toBe("abc1234567");
  });

  it("an un-ranged filament round-trips its single nozzle temp", () => {
    const { fields } = filamentToOpenTag3DFields({
      type: "PLA",
      temperatures: { nozzle: 210, bed: 60 },
    });
    const decoded = decodeOpenTag3DTag(encodeOpenTag3D(fields));
    expect(decoded.nozzleTemp).toBe(210); // print_temp → recommended → nozzleTemp
    expect(decoded.bedTemp).toBe(60);
  });

  it("coextruded (null primary + secondaries) leaves no primary, keeps secondaries", () => {
    const { fields } = filamentToOpenTag3DFields({
      type: "PLA",
      color: null,
      secondaryColors: ["#112233", "#445566"],
    });
    expect(fields.color_1).toBeUndefined(); // transparent-black sentinel → no primary
    const decoded = decodeOpenTag3DTag(encodeOpenTag3D(fields));
    expect(decoded.color).toBeUndefined();
    expect(decoded.secondaryColors).toEqual(["#112233", "#445566"]);
  });

  it("flags a material type longer than the 5-byte slot", () => {
    const { fields, notices } = filamentToOpenTag3DFields({ type: "PC-ABS" });
    expect(notices.some((n) => /Material type/.test(n))).toBe(true);
    expect(fields.material_base).toBe("PC-ABS"); // value kept; encoder truncates
  });

  it("writes only 3 secondary slots and flags the overflow", () => {
    const { fields, notices } = filamentToOpenTag3DFields({
      type: "PLA",
      secondaryColors: ["#111111", "#222222", "#333333", "#444444", "#555555"],
    });
    expect(fields.color_2).toBeDefined();
    expect(fields.color_4).toBeDefined();
    expect("color_5" in fields).toBe(false);
    expect(notices.some((n) => /secondary-color slots/.test(n))).toBe(true);
  });

  it("maps remaining (scale) weight to measured_filament_weight", () => {
    const { fields } = filamentToOpenTag3DFields(
      { type: "PLA", netFilamentWeight: 1000 },
      { actualWeightGrams: 742 },
    );
    const decoded = decodeOpenTag3DTag(encodeOpenTag3D(fields));
    expect(decoded.weightGrams).toBe(1000); // nominal
    expect(decoded.actualWeightGrams).toBe(742); // remaining
  });

  it("#927: Core image fits an NTAG213 (144B) where the Extended image does not", () => {
    const { fields } = filamentToOpenTag3DFields(filament);
    const NTAG213 = 144, NTAG215 = 496;
    const ext = wrapOpenTag3DType2(fields, { includeExtended: true });
    const core = wrapOpenTag3DType2(fields, { includeExtended: false });
    expect(ext.tlv.length).toBeGreaterThan(NTAG213); // overflows 213 → must fall back
    expect(core.tlv.length).toBeLessThanOrEqual(NTAG213); // Core fits 213
    expect(ext.tlv.length).toBeLessThanOrEqual(NTAG215); // Extended fits 215/216
  });

  it("wrapOpenTag3DType2 produces an NDEF TLV that decodes via the registry", () => {
    const { fields } = filamentToOpenTag3DFields(filament);
    const { tlv } = wrapOpenTag3DType2(fields);
    // Lay the TLV out from byte 16 (page 4) like an NTAG image, CC at byte 12.
    const image = new Uint8Array(16 + tlv.length);
    image.set([0xe1, 0x10, 0x3e, 0x00], 12); // a valid Type-2 CC
    image.set(tlv, 16);
    const decoded = decodeFromNdefRecords(parseNdefRecords(image, 12));
    expect(decoded?.tagSource).toBe("opentag3d");
    expect(decoded?.materialType).toBe("PETG");
  });
});

describe("Type-2 CC read-only helpers (NTAG, reversible)", () => {
  it("isType2CcReadOnly reads the low nibble of byte 3", () => {
    expect(isType2CcReadOnly(0x00)).toBe(false);
    expect(isType2CcReadOnly(0x0f)).toBe(true);
    expect(isType2CcReadOnly(0xff)).toBe(true);
    expect(isType2CcReadOnly(0xf0)).toBe(false); // read nibble set, write nibble clear
  });

  it("setType2CcReadOnly flips only the write nibble, preserving the read nibble", () => {
    expect(setType2CcReadOnly(0x00, true)).toBe(0x0f);
    expect(setType2CcReadOnly(0x0f, false)).toBe(0x00);
    expect(setType2CcReadOnly(0xf0, true)).toBe(0xff); // read nibble preserved
    expect(setType2CcReadOnly(0xff, false)).toBe(0xf0);
  });

  it("round-trips read-only ⇄ read/write (reversible)", () => {
    const ro = setType2CcReadOnly(0x00, true);
    expect(isType2CcReadOnly(ro)).toBe(true);
    const rw = setType2CcReadOnly(ro, false);
    expect(isType2CcReadOnly(rw)).toBe(false);
  });

  it("buildType2Cc encodes size + the read-only flag", () => {
    expect([...buildType2Cc(496)]).toEqual([0xe1, 0x10, 62, 0x00]); // NTAG215, r/w
    expect([...buildType2Cc(496, true)]).toEqual([0xe1, 0x10, 62, 0x0f]); // read-only
  });
});

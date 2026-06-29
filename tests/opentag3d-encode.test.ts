import { describe, it, expect } from "vitest";
import { filamentToOpenTag3DFields, wrapOpenTag3DType2, splitMaterialType } from "../src/lib/opentag3d-encode";
import { encodeOpenTag3D } from "../src/lib/opentag3d";
import { decodeOpenTag3DTag } from "../src/lib/opentag3d-decode";
import { parseNdefRecords } from "../src/lib/ndef";
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
    expect(decoded.spoolUid).toBe("abc1234567"); // #927: serial → spoolUid for scan matching
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

  it("splits a combined material type into base + modifier (PA12-CF → PA12 / CF)", () => {
    const { fields, notices } = filamentToOpenTag3DFields({ type: "PA12-CF" });
    expect(fields.material_base).toBe("PA12");
    expect(fields.material_mod).toBe("CF");
    expect(notices).toEqual([]); // both fit their 5-byte slots → no truncation
    const decoded = decodeOpenTag3DTag(encodeOpenTag3D(fields));
    expect(decoded.materialType).toBe("PA12"); // base
    expect(decoded.materialName).toContain("CF"); // modifier rejoined into the name
  });

  it("flags a no-separator material type longer than the 5-byte base slot", () => {
    // No "-"/space to split on → the whole thing is the base, which truncates.
    const { fields, notices } = filamentToOpenTag3DFields({ type: "NYLON12" });
    expect(fields.material_base).toBe("NYLON12"); // value kept; encoder truncates to 5B
    expect(notices.some((n) => /Material type/.test(n))).toBe(true);
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

  it("#927: omits an over-length spool ID rather than writing a truncated (mis-matching) serial", () => {
    const longId = "x".repeat(40); // > 16-byte serial slot
    const { fields, notices } = filamentToOpenTag3DFields(
      { type: "PLA" },
      { spoolInstanceId: longId },
    );
    expect("serial" in fields).toBe(false); // omitted, NOT truncated
    expect(notices.some((n) => /Spool ID/.test(n))).toBe(true);
    const decoded = decodeOpenTag3DTag(encodeOpenTag3D(fields));
    expect(decoded.spoolUid).toBeUndefined(); // no false/truncated match value

    // A normal-length id still writes + round-trips.
    const ok = filamentToOpenTag3DFields({ type: "PLA" }, { spoolInstanceId: "abc1234567" });
    expect(ok.fields.serial).toBe("abc1234567");
    expect(decodeOpenTag3DTag(encodeOpenTag3D(ok.fields)).spoolUid).toBe("abc1234567");
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

describe("splitMaterialType", () => {
  it("splits on the first separator into base + modifier", () => {
    expect(splitMaterialType("PA12-CF")).toEqual({ base: "PA12", mod: "CF" });
    expect(splitMaterialType("PC-ABS")).toEqual({ base: "PC", mod: "ABS" });
    expect(splitMaterialType("TPU 95A")).toEqual({ base: "TPU", mod: "95A" });
    expect(splitMaterialType("PA6-GF25")).toEqual({ base: "PA6", mod: "GF25" });
  });
  it("returns base-only when there's no separator", () => {
    expect(splitMaterialType("PLA")).toEqual({ base: "PLA", mod: "" });
    expect(splitMaterialType("NYLON12")).toEqual({ base: "NYLON12", mod: "" });
  });
  it("handles null/empty", () => {
    expect(splitMaterialType(null)).toEqual({ base: "", mod: "" });
    expect(splitMaterialType("  ")).toEqual({ base: "", mod: "" });
  });
});

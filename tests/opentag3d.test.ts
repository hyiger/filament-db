import { describe, it, expect } from "vitest";
import {
  encodeOpenTag3D,
  decodeOpenTag3D,
  ot3dField,
  OPENTAG3D_CORE_SIZE,
  OPENTAG3D_TOTAL_SIZE,
  OPENTAG3D_FIELDS,
  rgbaToHex,
  hexToRgba,
  isTransparentBlack,
  type Ot3dDecoded,
  type Ot3dValue,
} from "../src/lib/opentag3d";
import { decodeOpenTag3DTag, ot3dToDecodedTag } from "../src/lib/opentag3d-decode";

// A rich, controlled field set. Values are in REAL units (the encoder applies
// the spec scaling). NOTE the spec's own `examples` mix raw and real values, so
// we use controlled reals and assert both the on-wire raw bytes and the decoded
// reals rather than trusting the examples to be one or the other.
const FULL: Record<string, Ot3dValue> = {
  tag_version: 1.0,
  material_base: "PLA",
  material_mod: "Silk",
  manufacturer: "Polar Filament", // multi-word → exercises the NUL terminator
  color_name: "Electric Watermelon",
  color_1: { r: 255, g: 166, b: 77, a: 255 },
  color_2: { r: 0, g: 0, b: 255, a: 255 },
  target_diameter: 1.75,
  target_weight: 1000,
  print_temp: 210,
  bed_temp: 60,
  density: 1.24,
  td: 11.8,
  online_data_url: "pfil.us?i=8078-RQSR",
  serial: "1234-ABCD",
  mfg_date: { year: 2024, month: 1, day: 23 },
  mfg_time: { hour: 10, minute: 30, second: 45 },
  spool_core_diameter: 100,
  mfi_temp: 210,
  mfi_load: 2160, // grams (raw 216 × scaling 10 = the 2.16 kg ASTM test load)
  mfi_value: 6.3, // g/10min, tenths (raw 63 × scaling 0.1) — see the spec-bug note
  measured_tolerance: 20,
  empty_spool_weight: 105,
  measured_filament_weight: 1002,
  measured_filament_length: 336,
  max_dry_temp: 55,
  dry_time: 8,
  min_print_temp: 190,
  max_print_temp: 225,
  min_bed_temp: 40,
  max_bed_temp: 60,
  min_vso: 20,
  max_vso: 120,
  target_vso: 80,
};

describe("opentag3d encode — spec offsets & scaling", () => {
  const buf = encodeOpenTag3D(FULL);

  it("emits the full Core+Extended image (0x00–0xBA)", () => {
    expect(buf.length).toBe(OPENTAG3D_TOTAL_SIZE);
    expect(OPENTAG3D_TOTAL_SIZE).toBe(0xbb);
  });

  it("writes tag_version 1.000 as 0x03E8 at offset 0", () => {
    expect([buf[0x00], buf[0x01]]).toEqual([0x03, 0xe8]);
  });

  it("writes material strings at their absolute offsets, NUL-padded", () => {
    expect([...buf.subarray(0x02, 0x07)]).toEqual([0x50, 0x4c, 0x41, 0x00, 0x00]); // "PLA"
    expect(new TextDecoder().decode(buf.subarray(0x1b, 0x1b + 16)).replace(/\0+$/, "")).toBe(
      "Polar Filament",
    );
  });

  it("applies integer scaling on the wire (real → raw)", () => {
    expect(buf[0x60]).toBe(42); // print_temp 210°C ÷5
    expect(buf[0x61]).toBe(12); // bed_temp 60°C ÷5
    expect([buf[0x5c], buf[0x5d]]).toEqual([0x06, 0xd6]); // target_diameter 1.750 → 1750
    expect([buf[0x62], buf[0x63]]).toEqual([0x04, 0xd8]); // density 1.240 → 1240
    expect([buf[0x64], buf[0x65]]).toEqual([0x00, 0x76]); // td 11.8 → 118
    expect(buf[0xa9]).toBe(216); // mfi_load 2160 g ÷10
  });

  it("writes color_1 as 4 sRGB bytes at 0x4B", () => {
    expect([...buf.subarray(0x4b, 0x4f)]).toEqual([255, 166, 77, 255]);
  });

  it("leaves reserved gaps (0x0C–0x1A, 0x4F, 0x66–0x6F) zero", () => {
    for (let i = 0x0c; i <= 0x1a; i++) expect(buf[i]).toBe(0);
    expect(buf[0x4f]).toBe(0);
    for (let i = 0x66; i <= 0x6f; i++) expect(buf[i]).toBe(0);
  });
});

describe("opentag3d decode — golden reals", () => {
  const decoded = decodeOpenTag3D(encodeOpenTag3D(FULL));

  it("reports version 1.000 and not a newer minor", () => {
    expect(decoded.version).toBe("1.000");
    expect(decoded.versionNewerMinor).toBe(false);
    expect(decoded.hasExtended).toBe(true);
  });

  it("decodes strings including multi-word names", () => {
    expect(decoded.fields.material_base).toBe("PLA");
    expect(decoded.fields.material_mod).toBe("Silk");
    expect(decoded.fields.manufacturer).toBe("Polar Filament");
    expect(decoded.fields.color_name).toBe("Electric Watermelon");
  });

  it("decodes scaled integers back to real units", () => {
    expect(decoded.fields.print_temp).toBe(210);
    expect(decoded.fields.bed_temp).toBe(60);
    expect(decoded.fields.target_diameter as number).toBeCloseTo(1.75, 6);
    expect(decoded.fields.density as number).toBeCloseTo(1.24, 6);
    expect(decoded.fields.td as number).toBeCloseTo(11.8, 6);
    expect(decoded.fields.mfi_load).toBe(2160);
  });

  it("decodes color quads and date/time", () => {
    expect(decoded.fields.color_1).toEqual({ r: 255, g: 166, b: 77, a: 255 });
    expect(decoded.fields.mfg_date).toEqual({ year: 2024, month: 1, day: 23 });
    expect(decoded.fields.mfg_time).toEqual({ hour: 10, minute: 30, second: 45 });
  });
});

describe("opentag3d round-trip", () => {
  it("decode(encode(x)) preserves every supplied field", () => {
    const d = decodeOpenTag3D(encodeOpenTag3D(FULL));
    expect(d.fields.material_base).toBe("PLA");
    expect(d.fields.online_data_url).toBe("pfil.us?i=8078-RQSR");
    expect(d.fields.serial).toBe("1234-ABCD");
    expect(d.fields.spool_core_diameter).toBe(100);
    expect(d.fields.target_vso).toBe(80);
    expect(d.fields.measured_filament_length).toBe(336);
  });
});

describe("opentag3d field-presence semantics", () => {
  it("omits transparent-black secondary colors but keeps a transparent-black primary", () => {
    const buf = encodeOpenTag3D({
      color_1: { r: 0, g: 0, b: 0, a: 0 },
      color_2: { r: 0, g: 0, b: 0, a: 0 },
      color_3: { r: 10, g: 20, b: 30, a: 255 },
    });
    const d = decodeOpenTag3D(buf);
    expect(d.fields.color_1).toBeDefined(); // primary kept even if transparent
    expect(d.fields.color_2).toBeUndefined(); // unused slot dropped
    expect(d.fields.color_3).toEqual({ r: 10, g: 20, b: 30, a: 255 });
  });

  it("omits empty string fields", () => {
    const d = decodeOpenTag3D(encodeOpenTag3D({ material_base: "PLA" }));
    expect(d.fields.manufacturer).toBeUndefined();
    expect(d.fields.color_name).toBeUndefined();
  });
});

describe("opentag3d Core-only image", () => {
  it("encodes to 112 bytes and decodes with no Extended fields", () => {
    const buf = encodeOpenTag3D(FULL, { includeExtended: false });
    expect(buf.length).toBe(OPENTAG3D_CORE_SIZE);
    const d = decodeOpenTag3D(buf);
    expect(d.hasExtended).toBe(false);
    expect(d.fields.material_base).toBe("PLA"); // core present
    expect(d.fields.serial).toBeUndefined(); // extended absent
    expect(d.fields.target_vso).toBeUndefined();
  });
});

describe("opentag3d version policy", () => {
  it("refuses a newer MAJOR version", () => {
    const buf = encodeOpenTag3D({ tag_version: 2.0, material_base: "PLA" });
    expect(() => decodeOpenTag3D(buf)).toThrow(/major version/i);
  });

  it("parses a newer MINOR version with a warning flag", () => {
    const d = decodeOpenTag3D(encodeOpenTag3D({ tag_version: 1.001, material_base: "PLA" }));
    expect(d.version).toBe("1.001");
    expect(d.versionNewerMinor).toBe(true);
    expect(d.fields.material_base).toBe("PLA");
  });

  it("throws on a too-short payload", () => {
    expect(() => decodeOpenTag3D(new Uint8Array([0x03]))).toThrow(/too short/i);
  });

  it("rejects a truncated Core payload that still carries the version bytes (Codex P2)", () => {
    // 50 bytes: has a valid version (0x03E8 = 1.000) but is shorter than the
    // 112-byte Core map → must be rejected, not decoded with missing identity.
    const truncated = new Uint8Array(50);
    truncated[0] = 0x03;
    truncated[1] = 0xe8;
    expect(truncated.length).toBeLessThan(OPENTAG3D_CORE_SIZE);
    expect(() => decodeOpenTag3D(truncated)).toThrow(/too short/i);
  });
});

describe("color helpers", () => {
  it("rgbaToHex drops alpha", () => {
    expect(rgbaToHex({ r: 255, g: 166, b: 77, a: 128 })).toBe("#FFA64D");
  });
  it("hexToRgba round-trips #RRGGBB and expands #RGB", () => {
    expect(hexToRgba("#FFA64D")).toEqual({ r: 255, g: 166, b: 77, a: 255 });
    expect(hexToRgba("#abc", 128)).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 128 });
  });
  it("isTransparentBlack only for [0,0,0,0]", () => {
    expect(isTransparentBlack({ r: 0, g: 0, b: 0, a: 0 })).toBe(true);
    expect(isTransparentBlack({ r: 0, g: 0, b: 0, a: 255 })).toBe(false);
  });
});

describe("ot3dToDecodedTag mapping → DecodedOpenPrintTag", () => {
  const tag = decodeOpenTag3DTag(encodeOpenTag3D(FULL));

  it("stamps the opentag3d source and identity fields", () => {
    expect(tag.tagSource).toBe("opentag3d");
    // GH #952: base+mod rejoin into the typed field (was a bare "PLA").
    expect(tag.materialType).toBe("PLA-Silk");
    // color folded into the name so colors don't collide on the unique name key
    expect(tag.materialName).toBe("PLA Silk Electric Watermelon");
    expect(tag.brandName).toBe("Polar Filament");
    expect(tag.colorName).toBe("Electric Watermelon");
  });

  it("maps colors to hex", () => {
    expect(tag.color).toBe("#FFA64D");
    expect(tag.secondaryColors).toEqual(["#0000FF"]);
  });

  it("#895: a transparent-black primary maps to NO color, not phantom #000000", () => {
    const coex = decodeOpenTag3DTag(
      encodeOpenTag3D({
        material_base: "PLA",
        color_name: "Coextruded",
        color_1: { r: 0, g: 0, b: 0, a: 0 }, // spec "unused color" sentinel
        color_2: { r: 17, g: 34, b: 51, a: 255 },
      }),
    );
    expect(coex.color).toBeUndefined(); // NOT "#000000"
    expect(coex.secondaryColors).toEqual(["#112233"]);

    // Regression: a real OPAQUE-black primary (a=255) still maps to #000000.
    const black = decodeOpenTag3DTag(
      encodeOpenTag3D({ material_base: "PLA", color_name: "Black", color_1: { r: 0, g: 0, b: 0, a: 255 } }),
    );
    expect(black.color).toBe("#000000");
  });

  it("gives two colors of the same material DISTINCT default names (Codex P2)", () => {
    const red = decodeOpenTag3DTag(
      encodeOpenTag3D({ material_base: "PLA", color_name: "Red", color_1: { r: 255, g: 0, b: 0, a: 255 } }),
    );
    const blue = decodeOpenTag3DTag(
      encodeOpenTag3D({ material_base: "PLA", color_name: "Blue", color_1: { r: 0, g: 0, b: 255, a: 255 } }),
    );
    expect(red.materialName).toBe("PLA Red");
    expect(blue.materialName).toBe("PLA Blue");
    expect(red.materialName).not.toBe(blue.materialName); // no unique-name collision
    expect(red.materialType).toBe("PLA"); // type stays the bare base
  });

  it("maps temps/weights/drying onto first-class homes", () => {
    expect(tag.nozzleTemp).toBe(225); // range MAX = max_print_temp, not the recommended 210
    expect(tag.bedTemp).toBe(60); // max_bed_temp (== recommended here)
    expect(tag.nozzleTempMin).toBe(190);
    expect(tag.bedTempMin).toBe(40);
    expect(tag.diameter as number).toBeCloseTo(1.75, 6);
    expect(tag.density as number).toBeCloseTo(1.24, 6);
    expect(tag.weightGrams).toBe(1000);
    expect(tag.emptySpoolWeight).toBe(105);
    expect(tag.actualWeightGrams).toBe(1002);
    expect(tag.dryingTemperature).toBe(55);
    expect(tag.dryingTime).toBe(480); // 8 hours → 480 minutes
    expect(tag.maxVolumetricSpeed).toBe(120); // max_vso (slicer upper limit), not target_vso 80
    expect(tag.filamentLength).toBe(336);
    // td is NOT mapped onto transmissionDistance (different semantics) — aux only.
    expect(tag.transmissionDistance).toBeUndefined();
  });

  it("formats the manufacture timestamp", () => {
    expect(tag.productionDate).toBe("2024-01-23 10:30:45 UTC");
  });

  it("parks no-home fields in aux without losing data", () => {
    expect(tag.aux?.opentag3d_serial).toBe("1234-ABCD");
    expect(tag.aux?.opentag3d_online_data_url).toBe("pfil.us?i=8078-RQSR");
    expect(tag.aux?.opentag3d_spool_core_diameter_mm).toBe(100);
    expect(tag.aux?.opentag3d_mfi_temp_c).toBe(210);
    expect(tag.aux?.opentag3d_mfi_load_g).toBe(2160);
    expect(tag.aux?.opentag3d_mfi_value as number).toBeCloseTo(6.3, 6); // tenths, not 630
    expect(tag.aux?.opentag3d_material_modifier).toBe("Silk");
    // max_print_temp (225) is now the first-class nozzleTemp range max; the Core
    // recommended (210) — distinct from the max — is preserved in aux.
    expect(tag.aux?.opentag3d_max_print_temp_c).toBeUndefined();
    expect(tag.aux?.opentag3d_recommended_print_temp_c).toBe(210);
    expect(tag.aux?.opentag3d_min_volumetric_speed).toBe(20);
    expect(tag.aux?.opentag3d_max_volumetric_speed).toBe(120);
    expect(tag.aux?.opentag3d_target_volumetric_speed).toBe(80);
    expect(tag.aux?.opentag3d_td_mm as number).toBeCloseTo(11.8, 6);
  });
});

describe("ot3dField lookup", () => {
  it("returns the field definition for a known id", () => {
    const f = ot3dField("color_1");
    expect(f.id).toBe("color_1");
    expect(f.start).toBe(0x4b);
    expect(f.type).toBe("rgba");
  });

  it("throws on an unknown field id (programmer error)", () => {
    expect(() => ot3dField("not_a_real_field")).toThrow(/Unknown OpenTag3D field id/);
  });
});

describe("hexToRgba invalid input", () => {
  it("throws on a malformed hex string", () => {
    expect(() => hexToRgba("nothex")).toThrow(/Invalid hex color/);
    expect(() => hexToRgba("#12")).toThrow(/Invalid hex color/); // wrong length
  });
});

describe("ot3dToDecodedTag branch coverage", () => {
  it("surfaces a distinct recommended bed temp in aux when it differs from the max (line 143/144)", () => {
    // FULL has max_bed_temp == recommended bed_temp (both 60), so line 144 never
    // fires there. Here the recommended (55) differs from the Extended max (60).
    const tag = decodeOpenTag3DTag(
      encodeOpenTag3D({
        material_base: "PLA",
        bed_temp: 55, // Core recommended
        max_bed_temp: 60, // Extended max
      }),
    );
    expect(tag.bedTemp).toBe(60); // range MAX = max_bed_temp
    expect(tag.aux?.opentag3d_recommended_bed_temp_c).toBe(55);
  });

  it("does NOT surface a recommended bed temp when it equals the max", () => {
    const tag = decodeOpenTag3DTag(
      encodeOpenTag3D({ material_base: "PLA", bed_temp: 60, max_bed_temp: 60 }),
    );
    expect(tag.aux?.opentag3d_recommended_bed_temp_c).toBeUndefined();
  });

  it("stamps the tag version in aux when the tag declares a newer minor (line 156)", () => {
    const tag = decodeOpenTag3DTag(
      encodeOpenTag3D({ tag_version: 1.001, material_base: "PLA" }),
    );
    expect(tag.aux?.opentag3d_version).toBe("1.001");
  });

  it("does NOT stamp a version in aux on the current minor", () => {
    const tag = decodeOpenTag3DTag(encodeOpenTag3D({ material_base: "PLA", serial: "X1" }));
    expect(tag.aux?.opentag3d_version).toBeUndefined();
  });

  it("leaves materialName undefined when base/mod/colorName are all absent (line 74 fallback)", () => {
    // No material_base, material_mod, or color_name → the filter+join yields ""
    // and the `|| undefined` fallback kicks in.
    const tag = decodeOpenTag3DTag(encodeOpenTag3D({ manufacturer: "Acme", target_weight: 1000 }));
    expect(tag.materialName).toBeUndefined();
    expect(tag.materialType).toBeUndefined();
  });

  it("formats a production date without a time when mfg_time is absent (line 101 false side)", () => {
    // The decoder always emits a `time` object when the field is covered, so map
    // a hand-built decode with mfg_date present but mfg_time omitted to hit the
    // no-time branch of the timestamp formatter.
    const decoded: Ot3dDecoded = {
      version: "1.000",
      versionRaw: 1000,
      versionNewerMinor: false,
      hasExtended: true,
      fields: {
        material_base: "PLA",
        mfg_date: { year: 2025, month: 12, day: 5 },
      },
    };
    const tag = ot3dToDecodedTag(decoded);
    expect(tag.productionDate).toBe("2025-12-05");
  });

  it("ignores a non-number density (num() rejects non-numeric values — line 39 false side)", () => {
    // Hand-built decode with a non-number in a numeric slot exercises num()'s
    // `typeof v === "number"` false branch → the field is dropped, not coerced.
    const decoded: Ot3dDecoded = {
      version: "1.000",
      versionRaw: 1000,
      versionNewerMinor: false,
      hasExtended: false,
      fields: {
        material_base: "PLA",
        // A non-number in a numeric slot drives num()'s `typeof v === "number"`
        // false branch (fields is loosely typed, so this needs no ts-ignore).
        density: "not-a-number",
      },
    };
    const tag = ot3dToDecodedTag(decoded);
    expect(tag.density).toBeUndefined();
  });
});

describe("field table integrity", () => {
  it("has unique, non-overlapping, in-range fields", () => {
    const ids = new Set<string>();
    let prevEnd = -1;
    for (const f of [...OPENTAG3D_FIELDS].sort((a, b) => a.start - b.start)) {
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      expect(f.start).toBeGreaterThan(prevEnd - 1); // no overlap with the previous field's bytes
      expect(f.start).toBeGreaterThanOrEqual(prevEnd); // strictly after prior end
      prevEnd = f.start + f.length;
    }
    expect(prevEnd).toBe(OPENTAG3D_TOTAL_SIZE); // last field ends at 0xBB
  });
});

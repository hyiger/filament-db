/**
 * OpenPrintTag CBOR encoder
 *
 * Generates binary payloads that conform to the OpenPrintTag NFC specification.
 * Reference: https://specs.openprinttag.org/#/nfc_data_format
 * Source of truth: https://github.com/OpenPrintTag/openprinttag-specification
 *
 * The payload consists of two CBOR maps:
 *   1. Meta map  – contains region offsets (aux_region_offset)
 *   2. Main map  – an indefinite map with all filament fields
 *
 * Key differences from a naive implementation:
 *   - `number` fields (density, filament_diameter) are CBOR floats, NOT scaled integers.
 *     The spec says: "number types can be encoded as either unsigned integers (type 0),
 *     signed integers (type 1), half floats or floats." The reference Python encoder
 *     uses CompactFloat which prefers half-precision (float16) when lossless.
 *   - `int` fields (temperatures) are plain CBOR unsigned integers.
 *   - material_type enum keys come from data/material_type_enum.yaml in the spec repo.
 */

// ── CBOR key assignments (from data/main_fields.yaml) ────────────────
export const OPT_KEY = {
  // Meta section (data/meta_fields.yaml)
  MAIN_REGION_OFFSET: 0,
  MAIN_REGION_SIZE: 1,
  AUX_REGION_OFFSET: 2,
  AUX_REGION_SIZE: 3,

  // Main section – universal
  MATERIAL_CLASS: 8,
  MATERIAL_TYPE: 9,
  MATERIAL_NAME: 10,
  BRAND_NAME: 11,
  NOMINAL_NETTO_FULL_WEIGHT: 16,
  ACTUAL_NETTO_FULL_WEIGHT: 17,
  EMPTY_CONTAINER_WEIGHT: 18,
  PRIMARY_COLOR: 19,
  DENSITY: 29,

  // Main section – FFF-specific
  FILAMENT_DIAMETER: 30,
  MIN_PRINT_TEMPERATURE: 34,
  MAX_PRINT_TEMPERATURE: 35,
  PREHEAT_TEMPERATURE: 36,
  MIN_BED_TEMPERATURE: 37,
  MAX_BED_TEMPERATURE: 38,
  MIN_CHAMBER_TEMPERATURE: 39,
  MAX_CHAMBER_TEMPERATURE: 40,
  CHAMBER_TEMPERATURE: 41,
  DRYING_TEMPERATURE: 57,
  DRYING_TIME: 58,

  // Additional
  MATERIAL_ABBREVIATION: 52,
  COUNTRY_OF_ORIGIN: 55,
} as const;

// Material class enum (data/material_class_enum.yaml)
export const MATERIAL_CLASS = { FFF: 0, SLA: 1 } as const;

// Material type enum (data/material_type_enum.yaml) – COMPLETE list from spec
export const MATERIAL_TYPE: Record<string, number> = {
  PLA: 0,
  PETG: 1,
  TPU: 2,
  ABS: 3,
  ASA: 4,
  PC: 5,
  PCTG: 6,
  PP: 7,
  PA6: 8,
  PA11: 9,
  PA12: 10,
  PA66: 11,
  CPE: 12,
  TPE: 13,
  HIPS: 14,
  PHA: 15,
  PET: 16,
  PEI: 17,
  PBT: 18,
  PVB: 19,
  PVA: 20,
  PEKK: 21,
  PEEK: 22,
  BVOH: 23,
  TPC: 24,
  PPS: 25,
  PPSU: 26,
  PVC: 27,
  PEBA: 28,
  PVDF: 29,
  PPA: 30,
  PCL: 31,
  PES: 32,
  PMMA: 33,
  POM: 34,
  PPE: 35,
  PS: 36,
  PSU: 37,
  TPI: 38,
  SBS: 39,
  OBC: 40,
  EVA: 41,
} as const;

// ── Low-level CBOR helpers ──────────────────────────────────────────

/** Encode a CBOR unsigned integer (major type 0) and push bytes to `buf`. */
export function encodeCBORUint(buf: number[], value: number): void {
  if (value < 0) throw new RangeError("CBOR unsigned int must be >= 0");
  if (value < 24) {
    buf.push(value);
  } else if (value < 256) {
    buf.push(0x18, value);
  } else if (value < 65536) {
    buf.push(0x19, value >> 8, value & 0xff);
  } else {
    buf.push(
      0x1a,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
  }
}

/**
 * Encode a CBOR half-precision float (float16, major type 7, additional 25).
 *
 * IEEE 754 half-precision: 1 sign + 5 exponent + 10 mantissa = 16 bits.
 * Only 2 bytes on the wire (+ 1 byte CBOR header = 3 bytes total).
 */
export function encodeCBORFloat16(buf: number[], value: number): void {
  // Use DataView to extract float32 bits (platform-endian safe)
  const ab = new ArrayBuffer(4);
  const dv = new DataView(ab);
  dv.setFloat32(0, value); // big-endian by default in DataView
  const bits32 = dv.getUint32(0);

  const sign = (bits32 >>> 31) & 0x1;
  const exp32 = (bits32 >>> 23) & 0xff;
  const frac32 = bits32 & 0x7fffff;

  let f16bits: number;

  if (exp32 === 0xff) {
    // Inf / NaN
    f16bits = (sign << 15) | 0x7c00 | (frac32 ? 0x0200 : 0);
  } else if (exp32 === 0) {
    // Zero or subnormal f32 → zero in f16
    f16bits = sign << 15;
  } else {
    const newExp = exp32 - 127 + 15;
    if (newExp >= 31) {
      // Overflow → Inf
      f16bits = (sign << 15) | 0x7c00;
    } else if (newExp <= 0) {
      // Underflow → subnormal or zero
      if (newExp < -10) {
        f16bits = sign << 15;
      } else {
        const mant = frac32 | 0x800000;
        const shift = 14 - newExp; // 1-based exponent for subnormal
        f16bits = (sign << 15) | (mant >> shift);
      }
    } else {
      f16bits = (sign << 15) | (newExp << 10) | (frac32 >> 13);
    }
  }

  // CBOR: major type 7, additional value 25 = half float
  buf.push(0xf9, (f16bits >> 8) & 0xff, f16bits & 0xff);
}

/**
 * Encode a CBOR single-precision float (float32, major type 7, additional 26).
 */
export function encodeCBORFloat32(buf: number[], value: number): void {
  const ab = new ArrayBuffer(4);
  const dv = new DataView(ab);
  dv.setFloat32(0, value);
  buf.push(0xfa, dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
}

/**
 * Encode a number in the most compact CBOR representation, matching the
 * reference Python encoder's CompactFloat behaviour:
 *   1. If the value is an integer, encode as CBOR uint.
 *   2. If it round-trips through float16 within 0.001, use half float.
 *   3. If it round-trips through float32 within 0.001, use single float.
 *   4. Otherwise use float32 (double is overkill for filament data).
 */
export function encodeCBORCompactNumber(buf: number[], value: number): void {
  if (Number.isInteger(value) && value >= 0) {
    encodeCBORUint(buf, value);
    return;
  }

  // Try float16
  const f16Buf: number[] = [];
  encodeCBORFloat16(f16Buf, value);
  // Decode the float16 back to check round-trip
  const f16Decoded = decodeCBORFloat16((f16Buf[1] << 8) | f16Buf[2]);
  if (Math.abs(value - f16Decoded) < 0.001) {
    buf.push(...f16Buf);
    return;
  }

  // Fall back to float32
  encodeCBORFloat32(buf, value);
}

/** Decode a 16-bit half float to a JS number. */
export function decodeCBORFloat16(bits: number): number {
  const sign = (bits >>> 15) & 1;
  const exp = (bits >>> 10) & 0x1f;
  const frac = bits & 0x3ff;

  let val: number;
  if (exp === 0) {
    val = frac * Math.pow(2, -24); // subnormal
  } else if (exp === 31) {
    val = frac === 0 ? Infinity : NaN;
  } else {
    val = (1 + frac / 1024) * Math.pow(2, exp - 15);
  }
  return sign ? -val : val;
}

/** Encode a CBOR text string (major type 3) and push bytes to `buf`. */
export function encodeCBORText(buf: number[], text: string): void {
  const utf8 = new TextEncoder().encode(text);
  const len = utf8.length;
  if (len < 24) {
    buf.push(0x60 + len);
  } else if (len < 256) {
    buf.push(0x78, len);
  } else if (len < 65536) {
    buf.push(0x79, len >> 8, len & 0xff);
  } else {
    throw new RangeError("Text string too long for OpenPrintTag");
  }
  buf.push(...utf8);
}

/** Encode a CBOR byte string (major type 2) and push bytes to `buf`. */
export function encodeCBORBytes(buf: number[], bytes: number[]): void {
  const len = bytes.length;
  if (len < 24) {
    buf.push(0x40 + len);
  } else if (len < 256) {
    buf.push(0x58, len);
  } else {
    throw new RangeError("Byte string too long for OpenPrintTag");
  }
  buf.push(...bytes);
}

/** Write a CBOR map key (unsigned int). */
export function encodeCBORKey(buf: number[], key: number): void {
  encodeCBORUint(buf, key);
}

// ── Colour helpers ──────────────────────────────────────────────────

/**
 * Parse a hex colour string (#RRGGBB or #RRGGBBAA) into bytes.
 * Returns null if the string cannot be parsed.
 */
export function parseHexColor(hex: string): number[] | null {
  const m = hex.match(/^#?([0-9a-f]{6,8})$/i);
  if (!m) return null;
  const h = m[1];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Spec says 3 or 4 bytes; omit alpha if fully opaque or not specified
  if (h.length === 8) {
    const a = parseInt(h.slice(6, 8), 16);
    return [r, g, b, a];
  }
  return [r, g, b];
}

// ── Material type mapping ───────────────────────────────────────────

/**
 * Maps filament type strings (as stored in our DB) to the OpenPrintTag
 * material_type enum. Handles common aliases and composite names.
 */
const MATERIAL_TYPE_MAP: Record<string, number> = {
  // Direct matches from the spec enum
  PLA: MATERIAL_TYPE.PLA,
  PETG: MATERIAL_TYPE.PETG,
  TPU: MATERIAL_TYPE.TPU,
  ABS: MATERIAL_TYPE.ABS,
  ASA: MATERIAL_TYPE.ASA,
  PC: MATERIAL_TYPE.PC,
  PCTG: MATERIAL_TYPE.PCTG,
  PP: MATERIAL_TYPE.PP,
  PA6: MATERIAL_TYPE.PA6,
  PA11: MATERIAL_TYPE.PA11,
  PA12: MATERIAL_TYPE.PA12,
  PA66: MATERIAL_TYPE.PA66,
  CPE: MATERIAL_TYPE.CPE,
  TPE: MATERIAL_TYPE.TPE,
  HIPS: MATERIAL_TYPE.HIPS,
  PHA: MATERIAL_TYPE.PHA,
  PET: MATERIAL_TYPE.PET,
  PEI: MATERIAL_TYPE.PEI,
  PBT: MATERIAL_TYPE.PBT,
  PVB: MATERIAL_TYPE.PVB,
  PVA: MATERIAL_TYPE.PVA,
  PEKK: MATERIAL_TYPE.PEKK,
  PEEK: MATERIAL_TYPE.PEEK,
  BVOH: MATERIAL_TYPE.BVOH,
  TPC: MATERIAL_TYPE.TPC,
  PPS: MATERIAL_TYPE.PPS,
  PPSU: MATERIAL_TYPE.PPSU,
  PVC: MATERIAL_TYPE.PVC,
  PEBA: MATERIAL_TYPE.PEBA,
  PVDF: MATERIAL_TYPE.PVDF,
  PPA: MATERIAL_TYPE.PPA,
  PCL: MATERIAL_TYPE.PCL,
  PES: MATERIAL_TYPE.PES,
  PMMA: MATERIAL_TYPE.PMMA,
  POM: MATERIAL_TYPE.POM,
  PPE: MATERIAL_TYPE.PPE,
  PS: MATERIAL_TYPE.PS,
  PSU: MATERIAL_TYPE.PSU,
  TPI: MATERIAL_TYPE.TPI,
  SBS: MATERIAL_TYPE.SBS,
  OBC: MATERIAL_TYPE.OBC,
  EVA: MATERIAL_TYPE.EVA,

  // Common aliases / composites
  "PLA+": MATERIAL_TYPE.PLA,
  "PLA-CF": MATERIAL_TYPE.PLA,
  "PETG-CF": MATERIAL_TYPE.PETG,
  "PET-GF": MATERIAL_TYPE.PET,
  "ABS-CF": MATERIAL_TYPE.ABS,
  "ASA-CF": MATERIAL_TYPE.ASA,
  "PC-CF": MATERIAL_TYPE.PC,
  PA: MATERIAL_TYPE.PA6,
  NYLON: MATERIAL_TYPE.PA6,
  "PA-CF": MATERIAL_TYPE.PA6,
  "NYLON-CF": MATERIAL_TYPE.PA6,
  FLEX: MATERIAL_TYPE.TPU,
  IGLIDUR: MATERIAL_TYPE.POM,
};

/** Map a filament type string to the OpenPrintTag material_type enum value.
 *  Returns undefined if no match (field will be omitted per spec: "can be left unspecified").
 */
export function resolveMaterialType(type: string): number | undefined {
  const key = type.toUpperCase().replace(/\s+/g, "");
  return MATERIAL_TYPE_MAP[key];
}

/** Derive a short material abbreviation from a filament type string. */
export function deriveMaterialAbbreviation(type: string): string {
  const upper = type.toUpperCase().replace(/\s+/g, "");
  // Return as-is if already short enough (max 7 chars per spec)
  if (upper.length <= 7) return upper;
  // Otherwise take the first 7 characters
  return upper.slice(0, 7);
}

// ── Input interface ─────────────────────────────────────────────────

export interface OpenPrintTagInput {
  materialName: string;        // e.g. "PLA Prusa Galaxy Black"
  brandName: string;           // e.g. "Prusament"
  materialType: string;        // e.g. "PLA", "PETG", "PCTG"
  color?: string;              // hex colour #RRGGBB or #RRGGBBAA
  density?: number | null;     // g/cm³ (encoded as CBOR float)
  diameter?: number;           // mm (encoded as CBOR float), default 1.75
  nozzleTemp?: number | null;  // °C – used as max print temp
  nozzleTempFirstLayer?: number | null;
  bedTemp?: number | null;     // °C – used as max bed temp
  bedTempFirstLayer?: number | null;
  chamberTemp?: number | null; // °C
  weightGrams?: number | null; // nominal net weight in grams
  countryOfOrigin?: string;    // ISO 3166-1 alpha-2, default "US"
}

// ── Main encoder ────────────────────────────────────────────────────

/**
 * Generate an OpenPrintTag CBOR binary payload from filament data.
 *
 * The output is a `Uint8Array` containing two consecutive CBOR maps:
 *   1. Meta map: `{2: <aux_region_offset>}` — points past the main map
 *   2. Main map: indefinite-length map with all filament fields
 */
export function generateOpenPrintTagBinary(
  input: OpenPrintTagInput,
): Uint8Array {
  // Build the main map first so we can measure its size
  const main = buildMainMap(input);

  // Meta map: definite map with 1 pair {2: <aux_region_offset>}
  // We need to calculate the meta size first, which depends on the total size encoding.
  // Meta = 0xA1 (1 byte) + key 2 (1 byte) + uint(total_size) (1-3 bytes)
  // For payloads < 24 bytes total: meta = 3 bytes (0xA1, 0x02, <val>)
  // For payloads < 256 bytes total: meta = 4 bytes (0xA1, 0x02, 0x18, <val>)
  // For payloads < 65536 bytes total: meta = 5 bytes (0xA1, 0x02, 0x19, hi, lo)
  // Our main maps are typically ~100-200 bytes, so total < 256 → 4 bytes meta.
  // But we need to handle the edge case where it could be 3 bytes.

  // Try with 4-byte meta first (most common case)
  let metaSize = 4;
  let totalSize = metaSize + main.length;

  if (totalSize < 24) {
    metaSize = 3; // 0xA1 + 0x02 + <val < 24>
    totalSize = metaSize + main.length;
  } else if (totalSize >= 256) {
    metaSize = 5; // 0xA1 + 0x02 + 0x19 + hi + lo
    totalSize = metaSize + main.length;
  }

  const buf: number[] = [];
  buf.push(0xa1); // definite map with 1 pair
  encodeCBORKey(buf, OPT_KEY.AUX_REGION_OFFSET);
  encodeCBORUint(buf, totalSize);

  // Main map (already built)
  buf.push(...main);

  return new Uint8Array(buf);
}

/** Build the indefinite-length CBOR main map. */
function buildMainMap(input: OpenPrintTagInput): number[] {
  const buf: number[] = [];

  buf.push(0xbf); // indefinite map start

  // material_class = FFF (0)
  encodeCBORKey(buf, OPT_KEY.MATERIAL_CLASS);
  encodeCBORUint(buf, MATERIAL_CLASS.FFF);

  // material_type – only include if we have a mapping
  const materialTypeVal = resolveMaterialType(input.materialType);
  if (materialTypeVal !== undefined) {
    encodeCBORKey(buf, OPT_KEY.MATERIAL_TYPE);
    encodeCBORUint(buf, materialTypeVal);
  }

  // material_name (max 31 chars)
  encodeCBORKey(buf, OPT_KEY.MATERIAL_NAME);
  encodeCBORText(buf, input.materialName.slice(0, 31));

  // brand_name (max 31 chars)
  encodeCBORKey(buf, OPT_KEY.BRAND_NAME);
  encodeCBORText(buf, input.brandName.slice(0, 31));

  // nominal_netto_full_weight (grams, integer – type: number but grams are always whole)
  if (input.weightGrams != null && input.weightGrams > 0) {
    encodeCBORKey(buf, OPT_KEY.NOMINAL_NETTO_FULL_WEIGHT);
    encodeCBORCompactNumber(buf, input.weightGrams);
    // Set actual = nominal as starting point
    encodeCBORKey(buf, OPT_KEY.ACTUAL_NETTO_FULL_WEIGHT);
    encodeCBORCompactNumber(buf, input.weightGrams);
  }

  // primary_color (RGBA byte string)
  if (input.color) {
    const rgba = parseHexColor(input.color);
    if (rgba) {
      encodeCBORKey(buf, OPT_KEY.PRIMARY_COLOR);
      encodeCBORBytes(buf, rgba);
    }
  }

  // density – type: number, unit: g/cm³ – encode as compact float (e.g. 1.24)
  if (input.density != null && input.density > 0) {
    encodeCBORKey(buf, OPT_KEY.DENSITY);
    encodeCBORCompactNumber(buf, input.density);
  }

  // filament_diameter – type: number, unit: mm – encode as compact float (e.g. 1.75)
  const diameter = input.diameter ?? 1.75;
  if (diameter !== 1.75) {
    // Spec says: "If not present, 1.75 mm is assumed." So omit if default.
    encodeCBORKey(buf, OPT_KEY.FILAMENT_DIAMETER);
    encodeCBORCompactNumber(buf, diameter);
  }

  // Temperatures – all type: int, unit: °C
  if (input.nozzleTemp != null) {
    // Use nozzle temp as max, derive min as temp - 20
    const maxTemp = input.nozzleTemp;
    const minTemp = Math.max(
      0,
      (input.nozzleTempFirstLayer ?? maxTemp) - 20,
    );
    const preheatTemp = Math.max(0, minTemp - 20);

    encodeCBORKey(buf, OPT_KEY.MIN_PRINT_TEMPERATURE);
    encodeCBORUint(buf, minTemp);
    encodeCBORKey(buf, OPT_KEY.MAX_PRINT_TEMPERATURE);
    encodeCBORUint(buf, maxTemp);
    encodeCBORKey(buf, OPT_KEY.PREHEAT_TEMPERATURE);
    encodeCBORUint(buf, preheatTemp);
  }

  if (input.bedTemp != null) {
    const maxBed = input.bedTemp;
    const minBed = input.bedTempFirstLayer ?? Math.max(0, maxBed - 10);

    encodeCBORKey(buf, OPT_KEY.MIN_BED_TEMPERATURE);
    encodeCBORUint(buf, Math.min(minBed, maxBed));
    encodeCBORKey(buf, OPT_KEY.MAX_BED_TEMPERATURE);
    encodeCBORUint(buf, Math.max(minBed, maxBed));
  }

  if (input.chamberTemp != null && input.chamberTemp > 0) {
    encodeCBORKey(buf, OPT_KEY.CHAMBER_TEMPERATURE);
    encodeCBORUint(buf, input.chamberTemp);
  }

  // material_abbreviation (max 7 chars)
  encodeCBORKey(buf, OPT_KEY.MATERIAL_ABBREVIATION);
  encodeCBORText(buf, deriveMaterialAbbreviation(input.materialType));

  // country_of_origin (ISO 3166-1 alpha-2)
  encodeCBORKey(buf, OPT_KEY.COUNTRY_OF_ORIGIN);
  encodeCBORText(buf, (input.countryOfOrigin ?? "US").slice(0, 2));

  buf.push(0xff); // indefinite map end

  return buf;
}

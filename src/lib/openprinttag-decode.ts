/**
 * OpenPrintTag CBOR decoder
 *
 * Decodes binary payloads conforming to the OpenPrintTag NFC specification.
 * This is the inverse of generateOpenPrintTagBinary() in openprinttag.ts.
 *
 * The payload consists of two consecutive CBOR maps:
 *   1. Meta map — definite map with region offsets
 *   2. Main map — indefinite map with filament fields
 */

import { OPT_KEY, MATERIAL_TYPE, decodeCBORFloat16 } from "./openprinttag";

// Reverse lookup: CBOR key number → field name
// Meta and main maps share key numbers 0-3 with different meanings,
// so we build separate lookup tables.
const META_KEYS = new Set(["MAIN_REGION_OFFSET", "MAIN_REGION_SIZE", "AUX_REGION_OFFSET", "AUX_REGION_SIZE"]);
const META_KEY_TO_NAME: Record<number, string> = {};
const MAIN_KEY_TO_NAME: Record<number, string> = {};
for (const [name, key] of Object.entries(OPT_KEY)) {
  if (META_KEYS.has(name)) {
    META_KEY_TO_NAME[key] = name;
  } else {
    MAIN_KEY_TO_NAME[key] = name;
  }
}

// Reverse lookup: material type number → abbreviation
const MATERIAL_TYPE_TO_NAME: Record<number, string> = {};
for (const [name, key] of Object.entries(MATERIAL_TYPE)) {
  MATERIAL_TYPE_TO_NAME[key as number] = name;
}

/** Decoded OpenPrintTag data from a tag. */
export interface DecodedOpenPrintTag {
  meta: Record<string, number>;
  main: Record<string, unknown>;
  // Convenience fields mapped to our filament model
  materialName?: string;
  brandName?: string;
  materialType?: string;
  materialTypeRaw?: number;
  color?: string;
  density?: number;
  diameter?: number;
  nozzleTemp?: number;
  nozzleTempMin?: number;
  preheatTemp?: number;
  bedTemp?: number;
  bedTempMin?: number;
  chamberTemp?: number;
  weightGrams?: number;
  actualWeightGrams?: number;
  emptySpoolWeight?: number;
  materialAbbreviation?: string;
  countryOfOrigin?: string;
  spoolUid?: string;
  dryingTemperature?: number;
  dryingTime?: number;
  transmissionDistance?: number;
  tags?: number[];
}

// ── CBOR decoding primitives ────────────────────────────────────────

/** Read a CBOR item from data at offset. Returns [value, newOffset]. */
function decodeCBORItem(
  data: Uint8Array,
  offset: number,
): [unknown, number] {
  if (offset >= data.length) {
    throw new Error(`CBOR decode: unexpected end of data at offset ${offset}`);
  }

  const initial = data[offset++];
  const majorType = (initial >> 5) & 0x07;
  const additional = initial & 0x1f;

  // Read the argument (length/value)
  let argument: number;
  if (additional < 24) {
    argument = additional;
  } else if (additional === 24) {
    if (offset >= data.length) throw new Error("CBOR decode: unexpected end of data reading 1-byte argument");
    argument = data[offset++];
  } else if (additional === 25) {
    if (offset + 2 > data.length) throw new Error("CBOR decode: unexpected end of data reading 2-byte argument");
    argument = (data[offset] << 8) | data[offset + 1];
    offset += 2;
  } else if (additional === 26) {
    if (offset + 4 > data.length) throw new Error("CBOR decode: unexpected end of data reading 4-byte argument");
    argument =
      ((data[offset] << 24) >>> 0) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3];
    offset += 4;
  } else if (additional === 27) {
    if (offset + 8 > data.length) throw new Error("CBOR decode: unexpected end of data reading 8-byte argument");
    // 64-bit - read as two 32-bit values
    const hi =
      ((data[offset] << 24) >>> 0) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3];
    offset += 4;
    const lo =
      ((data[offset] << 24) >>> 0) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3];
    offset += 4;
    argument = hi * 0x100000000 + lo;
  } else if (additional === 31) {
    // Indefinite length — handled per major type below
    argument = -1;
  } else {
    throw new Error(`CBOR decode: reserved additional value ${additional}`);
  }

  switch (majorType) {
    case 0: // Unsigned integer
      return [argument, offset];

    case 1: // Negative integer
      return [-(argument + 1), offset];

    case 2: {
      // Byte string
      if (argument < 0) throw new Error("CBOR: indefinite byte strings not supported");
      if (offset + argument > data.length) throw new Error(`CBOR decode: byte string length ${argument} exceeds available data`);
      const bytes = data.slice(offset, offset + argument);
      offset += argument;
      return [bytes, offset];
    }

    case 3: {
      // Text string
      if (argument < 0) throw new Error("CBOR: indefinite text strings not supported");
      if (offset + argument > data.length) throw new Error(`CBOR decode: text string length ${argument} exceeds available data`);
      const textBytes = data.slice(offset, offset + argument);
      offset += argument;
      const text = new TextDecoder().decode(textBytes);
      return [text, offset];
    }

    case 4: {
      // Array
      const arr: unknown[] = [];
      if (argument < 0) {
        // Indefinite array
        while (offset < data.length && data[offset] !== 0xff) {
          const [item, newOffset] = decodeCBORItem(data, offset);
          arr.push(item);
          offset = newOffset;
        }
        if (offset >= data.length) throw new Error("CBOR decode: missing break byte for indefinite array");
        offset++; // skip break byte
      } else {
        for (let i = 0; i < argument; i++) {
          const [item, newOffset] = decodeCBORItem(data, offset);
          arr.push(item);
          offset = newOffset;
        }
      }
      return [arr, offset];
    }

    case 5: {
      // Map
      const map: Record<string, unknown> = {};
      if (argument < 0) {
        // Indefinite map
        while (offset < data.length && data[offset] !== 0xff) {
          const [key, keyOffset] = decodeCBORItem(data, offset);
          const [value, valOffset] = decodeCBORItem(data, keyOffset);
          map[String(key)] = value;
          offset = valOffset;
        }
        if (offset >= data.length) throw new Error("CBOR decode: missing break byte for indefinite map");
        offset++; // skip break byte
      } else {
        for (let i = 0; i < argument; i++) {
          const [key, keyOffset] = decodeCBORItem(data, offset);
          const [value, valOffset] = decodeCBORItem(data, keyOffset);
          map[String(key)] = value;
          offset = valOffset;
        }
      }
      return [map, offset];
    }

    case 6: {
      // Tagged value — skip tag, decode inner
      const [value, newOffset] = decodeCBORItem(data, offset);
      return [value, newOffset];
    }

    case 7: {
      // Simple values and floats
      if (additional === 20) return [false, offset];
      if (additional === 21) return [true, offset];
      if (additional === 22) return [null, offset];
      if (additional === 23) return [undefined, offset];

      if (additional === 25) {
        // Float16 — argument was already read as 2 bytes
        const f16bits = argument;
        return [decodeCBORFloat16(f16bits), offset];
      }

      if (additional === 26) {
        // Float32 — argument was read as 4 bytes uint, reinterpret
        const ab = new ArrayBuffer(4);
        const dv = new DataView(ab);
        dv.setUint32(0, argument);
        return [dv.getFloat32(0), offset];
      }

      if (additional === 27) {
        // Float64
        const ab = new ArrayBuffer(8);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _dv = new DataView(ab);
        // argument is already the 64-bit value but JS loses precision
        // Re-read from the original data
        const f64Offset = offset - 8;
        const dv2 = new DataView(data.buffer, data.byteOffset + f64Offset, 8);
        return [dv2.getFloat64(0), offset];
      }

      if (additional === 31) {
        // Break — should not appear here as standalone
        return [undefined, offset];
      }

      // Simple value
      return [argument, offset];
    }

    default:
      throw new Error(`CBOR decode: unknown major type ${majorType}`);
  }
}

// ── High-level decoder ──────────────────────────────────────────────

/**
 * Decode an OpenPrintTag CBOR payload (meta + main maps).
 *
 * @param data - The CBOR payload bytes (from NDEF record payload or .bin file export)
 * @returns Decoded tag data with named fields
 */
export function decodeOpenPrintTagBinary(data: Uint8Array): DecodedOpenPrintTag {
  // Decode meta map
  const [metaRaw, mainOffset] = decodeCBORItem(data, 0);
  const metaMap = metaRaw as Record<string, unknown>;

  const meta: Record<string, number> = {};
  for (const [k, v] of Object.entries(metaMap)) {
    const keyNum = parseInt(k, 10);
    const name = META_KEY_TO_NAME[keyNum] ?? `unknown_${k}`;
    meta[name] = v as number;
  }

  // Decode main map
  const [mainRaw] = decodeCBORItem(data, mainOffset);
  const mainMap = mainRaw as Record<string, unknown>;

  const main: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mainMap)) {
    const keyNum = parseInt(k, 10);
    const name = MAIN_KEY_TO_NAME[keyNum] ?? `key_${k}`;
    main[name] = v;
  }

  // Build convenience fields
  const result: DecodedOpenPrintTag = { meta, main };

  if (main.MATERIAL_NAME !== undefined) {
    result.materialName = main.MATERIAL_NAME as string;
  }
  if (main.BRAND_NAME !== undefined) {
    result.brandName = main.BRAND_NAME as string;
  }
  if (main.MATERIAL_TYPE !== undefined) {
    const typeNum = main.MATERIAL_TYPE as number;
    result.materialTypeRaw = typeNum;
    result.materialType = MATERIAL_TYPE_TO_NAME[typeNum] ?? `Unknown(${typeNum})`;
  }
  if (main.PRIMARY_COLOR !== undefined) {
    const colorBytes = main.PRIMARY_COLOR as Uint8Array;
    const hex = Array.from(colorBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    result.color = `#${hex}`;
  }
  if (main.DENSITY !== undefined) {
    result.density = main.DENSITY as number;
  }
  if (main.FILAMENT_DIAMETER !== undefined) {
    result.diameter = main.FILAMENT_DIAMETER as number;
  } else {
    result.diameter = 1.75; // spec default
  }
  if (main.MAX_PRINT_TEMPERATURE !== undefined) {
    result.nozzleTemp = main.MAX_PRINT_TEMPERATURE as number;
  }
  if (main.MIN_PRINT_TEMPERATURE !== undefined) {
    result.nozzleTempMin = main.MIN_PRINT_TEMPERATURE as number;
  }
  if (main.PREHEAT_TEMPERATURE !== undefined) {
    result.preheatTemp = main.PREHEAT_TEMPERATURE as number;
  }
  if (main.MAX_BED_TEMPERATURE !== undefined) {
    result.bedTemp = main.MAX_BED_TEMPERATURE as number;
  }
  if (main.MIN_BED_TEMPERATURE !== undefined) {
    result.bedTempMin = main.MIN_BED_TEMPERATURE as number;
  }
  if (main.CHAMBER_TEMPERATURE !== undefined) {
    result.chamberTemp = main.CHAMBER_TEMPERATURE as number;
  }
  if (main.NOMINAL_NETTO_FULL_WEIGHT !== undefined) {
    result.weightGrams = main.NOMINAL_NETTO_FULL_WEIGHT as number;
  }
  if (main.ACTUAL_NETTO_FULL_WEIGHT !== undefined) {
    result.actualWeightGrams = main.ACTUAL_NETTO_FULL_WEIGHT as number;
  }
  if (main.EMPTY_CONTAINER_WEIGHT !== undefined) {
    result.emptySpoolWeight = main.EMPTY_CONTAINER_WEIGHT as number;
  }
  if (main.MATERIAL_ABBREVIATION !== undefined) {
    result.materialAbbreviation = main.MATERIAL_ABBREVIATION as string;
  }
  if (main.COUNTRY_OF_ORIGIN !== undefined) {
    result.countryOfOrigin = main.COUNTRY_OF_ORIGIN as string;
  }

  // brand_specific_instance_id – spool/instance identifier string
  if (main.BRAND_SPECIFIC_INSTANCE_ID !== undefined) {
    result.spoolUid = main.BRAND_SPECIFIC_INSTANCE_ID as string;
  }

  if (main.DRYING_TEMPERATURE !== undefined) {
    result.dryingTemperature = main.DRYING_TEMPERATURE as number;
  }
  if (main.DRYING_TIME !== undefined) {
    result.dryingTime = main.DRYING_TIME as number;
  }
  if (main.TRANSMISSION_DISTANCE !== undefined) {
    result.transmissionDistance = main.TRANSMISSION_DISTANCE as number;
  }
  if (main.TAGS !== undefined && Array.isArray(main.TAGS)) {
    result.tags = main.TAGS as number[];
  }

  return result;
}

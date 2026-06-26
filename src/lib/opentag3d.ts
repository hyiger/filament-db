/**
 * OpenTag3D fixed-binary memory-map codec (decode + dev-write encoder).
 *
 * OpenTag3D (https://opentag3d.info, github.com/queengooborg/OpenTag3D) is a
 * SEPARATE, competing standard from OpenPrintTag (Prusa). Where OpenPrintTag is
 * CBOR (see openprinttag.ts), OpenTag3D v1.000 is a FIXED BINARY MEMORY MAP:
 * absolute byte offsets, big-endian unsigned integers, UTF-8 / ASCII strings,
 * and RGBA color quads — NOT CBOR. (The "is OpenTag3D CBOR?" confusion comes
 * from conflating the two standards; the live spec.json and spec.md design
 * rationale settle it as a memory map.)
 *
 * The field table below mirrors the authoritative
 *   https://opentag3d.info/spec.json   (fetched 2026-06-25, version 1.000)
 * one-to-one (id / start offset / length / type / scaling). Decoding rule for
 * integers: `real = raw * scaling` (scaling null → identity). Strings are
 * NUL-padded. RGBA is 4×1-byte sRGB. The layout is NOT contiguous — there are
 * reserved gaps at 0x0C–0x1A and the single byte 0x4F in Core, so a reader MUST
 * use the absolute `start` offsets, never assume packed fields.
 *
 * The data is carried in an NDEF record of MIME type `application/opentag3d`.
 * Both an OpenTag3D and an OpenPrintTag record can live on ONE physical tag, so
 * codec selection is per-NDEF-record-MIME (see tagCodecs.ts), not per-chip.
 *
 * This module is DB-free and browser-safe (no Node APIs) so it is shared by the
 * Electron read path, the server /api/nfc/decode route, the dev write CLI, and
 * the unit tests.
 */

/** NDEF MIME type that carries an OpenTag3D payload (TNF = 0x02, media). */
export const OPENTAG3D_MIME = "application/opentag3d";

/** Spec version this decoder targets. */
export const OPENTAG3D_SPEC_VERSION = "1.000";

/** Core range is 0x00–0x6F (112 bytes — fits an NTAG213). */
export const OPENTAG3D_CORE_SIZE = 0x70;
/** Last byte used by the Extended map (0xBA). */
export const OPENTAG3D_LAST_BYTE = 0xba;
/** Full Core+Extended image size (0x00–0xBA → 187 bytes — needs SLIX2/NTAG215+). */
export const OPENTAG3D_TOTAL_SIZE = OPENTAG3D_LAST_BYTE + 1;

export type Ot3dFieldType = "int" | "utf8" | "ascii" | "rgba" | "date" | "time";

export interface Ot3dField {
  id: string;
  /** absolute byte offset within the payload */
  start: number;
  length: number;
  type: Ot3dFieldType;
  /** integer scaling: real = raw * scaling. null = identity / non-int. */
  scaling: number | null;
  section: "core" | "extended";
}

export interface Ot3dRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface Ot3dDate {
  year: number;
  month: number;
  day: number;
}
export interface Ot3dTime {
  hour: number;
  minute: number;
  second: number;
}
export type Ot3dValue = number | string | Ot3dRgba | Ot3dDate | Ot3dTime;

/**
 * The OpenTag3D field table, transcribed from opentag3d.info/spec.json (v1.000).
 * Single source of truth shared by the decoder AND the encoder so offsets can
 * never drift between the two. tests/opentag3d.test.ts pins the table against
 * the spec's own `examples` golden values.
 */
export const OPENTAG3D_FIELDS: readonly Ot3dField[] = [
  // ── Core (0x00–0x6F) ──
  { id: "tag_version", start: 0x00, length: 2, type: "int", scaling: 0.001, section: "core" },
  { id: "material_base", start: 0x02, length: 5, type: "utf8", scaling: null, section: "core" },
  { id: "material_mod", start: 0x07, length: 5, type: "utf8", scaling: null, section: "core" },
  // reserved 0x0C–0x1A
  { id: "manufacturer", start: 0x1b, length: 16, type: "utf8", scaling: null, section: "core" },
  { id: "color_name", start: 0x2b, length: 32, type: "utf8", scaling: null, section: "core" },
  { id: "color_1", start: 0x4b, length: 4, type: "rgba", scaling: null, section: "core" },
  // reserved 0x4F
  { id: "color_2", start: 0x50, length: 4, type: "rgba", scaling: null, section: "core" },
  { id: "color_3", start: 0x54, length: 4, type: "rgba", scaling: null, section: "core" },
  { id: "color_4", start: 0x58, length: 4, type: "rgba", scaling: null, section: "core" },
  { id: "target_diameter", start: 0x5c, length: 2, type: "int", scaling: 0.001, section: "core" },
  { id: "target_weight", start: 0x5e, length: 2, type: "int", scaling: null, section: "core" },
  { id: "print_temp", start: 0x60, length: 1, type: "int", scaling: 5, section: "core" },
  { id: "bed_temp", start: 0x61, length: 1, type: "int", scaling: 5, section: "core" },
  { id: "density", start: 0x62, length: 2, type: "int", scaling: 0.001, section: "core" },
  { id: "td", start: 0x64, length: 2, type: "int", scaling: 0.1, section: "core" },
  // reserved 0x66–0x6F
  // ── Extended (0x70–0xBA) ──
  { id: "online_data_url", start: 0x70, length: 32, type: "ascii", scaling: null, section: "extended" },
  { id: "serial", start: 0x90, length: 16, type: "utf8", scaling: null, section: "extended" },
  { id: "mfg_date", start: 0xa0, length: 4, type: "date", scaling: null, section: "extended" },
  { id: "mfg_time", start: 0xa4, length: 3, type: "time", scaling: null, section: "extended" },
  { id: "spool_core_diameter", start: 0xa7, length: 1, type: "int", scaling: null, section: "extended" },
  { id: "mfi_temp", start: 0xa8, length: 1, type: "int", scaling: 5, section: "extended" },
  { id: "mfi_load", start: 0xa9, length: 1, type: "int", scaling: 10, section: "extended" },
  // spec.json lists scaling 10 for mfi_value, but that is an upstream spec bug:
  // raw×10 yields g/10min values ~100× a plausible MFI (e.g. raw 63 → 630, vs
  // PLA's ~6 g/10min). The field is "divided by 10" with a g/10min unit, i.e.
  // tenths — so raw 63 = 6.3. We decode tenths (scaling 0.1). (mfi_load's ×10 is
  // correct: raw 216 → 2160 g = the standard 2.16 kg ASTM test load.)
  { id: "mfi_value", start: 0xaa, length: 1, type: "int", scaling: 0.1, section: "extended" },
  { id: "measured_tolerance", start: 0xab, length: 1, type: "int", scaling: null, section: "extended" },
  { id: "empty_spool_weight", start: 0xac, length: 2, type: "int", scaling: null, section: "extended" },
  { id: "measured_filament_weight", start: 0xae, length: 2, type: "int", scaling: null, section: "extended" },
  { id: "measured_filament_length", start: 0xb0, length: 2, type: "int", scaling: null, section: "extended" },
  { id: "max_dry_temp", start: 0xb2, length: 1, type: "int", scaling: 5, section: "extended" },
  { id: "dry_time", start: 0xb3, length: 1, type: "int", scaling: null, section: "extended" },
  { id: "min_print_temp", start: 0xb4, length: 1, type: "int", scaling: 5, section: "extended" },
  { id: "max_print_temp", start: 0xb5, length: 1, type: "int", scaling: 5, section: "extended" },
  { id: "min_bed_temp", start: 0xb6, length: 1, type: "int", scaling: 5, section: "extended" },
  { id: "max_bed_temp", start: 0xb7, length: 1, type: "int", scaling: 5, section: "extended" },
  { id: "min_vso", start: 0xb8, length: 1, type: "int", scaling: null, section: "extended" },
  { id: "max_vso", start: 0xb9, length: 1, type: "int", scaling: null, section: "extended" },
  { id: "target_vso", start: 0xba, length: 1, type: "int", scaling: null, section: "extended" },
];

const FIELD_BY_ID: Record<string, Ot3dField> = Object.fromEntries(
  OPENTAG3D_FIELDS.map((f) => [f.id, f]),
);

/** Look up a field definition by id (throws on an unknown id — programmer error). */
export function ot3dField(id: string): Ot3dField {
  const f = FIELD_BY_ID[id];
  if (!f) throw new Error(`Unknown OpenTag3D field id: ${id}`);
  return f;
}

// ── low-level primitives ────────────────────────────────────────────

/** Read an unsigned big-endian integer of `length` bytes. */
function readUintBE(buf: Uint8Array, start: number, length: number): number {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + buf[start + i];
  return v;
}

/** Write an unsigned big-endian integer of `length` bytes (value clamped ≥ 0). */
function writeUintBE(buf: Uint8Array, start: number, length: number, value: number): void {
  let v = Math.max(0, Math.round(value));
  for (let i = length - 1; i >= 0; i--) {
    buf[start + i] = v & 0xff;
    v = Math.floor(v / 256);
  }
}

/** Decode a NUL-padded string field; everything from the first NUL is dropped. */
function decodeString(buf: Uint8Array, f: Ot3dField): string {
  const slice = buf.subarray(f.start, f.start + f.length);
  const decoded = new TextDecoder("utf-8").decode(slice);
  return decoded.split("\u0000")[0].trim();
}

// ── decode ──────────────────────────────────────────────────────────

export interface Ot3dDecoded {
  /** "1.000" etc. — the tag's declared format version. */
  version: string;
  /** Raw tag_version integer (e.g. 1000), for policy decisions. */
  versionRaw: number;
  /** True when the tag declares a newer MINOR than this decoder targets. */
  versionNewerMinor: boolean;
  /** Decoded fields by id. Absent / empty fields are omitted (see semantics). */
  fields: Record<string, Ot3dValue>;
  /** True when the payload extends into the Extended map (≥ 0x70). */
  hasExtended: boolean;
}

/** True when an RGBA quad is the spec's "unused color" sentinel (transparent black). */
export function isTransparentBlack(c: Ot3dRgba): boolean {
  return c.r === 0 && c.g === 0 && c.b === 0 && c.a === 0;
}

/** Convert an RGBA quad to `#RRGGBB` (alpha dropped, mirroring the OPT decoder). */
export function rgbaToHex(c: Ot3dRgba): string {
  const h = (n: number) => (n & 0xff).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

/** Parse `#RGB` / `#RRGGBB` to an RGBA quad with the given alpha (default opaque). */
export function hexToRgba(hex: string, alpha = 255): Ot3dRgba {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex color: ${hex}`);
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: alpha & 0xff,
  };
}

/**
 * Decode an OpenTag3D binary payload (the NDEF record payload, starting at the
 * memory-map byte 0x00) into raw, unit-scaled field values.
 *
 * Field-presence semantics (a fixed memory map has no "absent" marker, so a
 * blank region is all-zero):
 *   - strings: omitted when empty after NUL-trim.
 *   - rgba: omitted when transparent-black (the spec's unused-color sentinel).
 *   - int / date / time: always included when the buffer covers the field
 *     (0 is a legitimate value — the mapping layer decides what is meaningful).
 *
 * Throws on an unsupported MAJOR version (per the spec reader policy: refuse a
 * newer major, warn-but-parse a newer minor).
 */
export function decodeOpenTag3D(payload: Uint8Array): Ot3dDecoded {
  // The fixed Core map (0x00–0x6F) is ALWAYS present on a real OpenTag3D tag, so
  // a payload shorter than that is truncated/corrupt — reject it rather than
  // returning a "successful" decode with required identity fields (material,
  // manufacturer, colors) silently skipped because they fall past payload.length
  // (Codex P2 on PR #865).
  if (payload.length < OPENTAG3D_CORE_SIZE) {
    throw new Error(
      `OpenTag3D payload too short: ${payload.length} bytes, need at least the ${OPENTAG3D_CORE_SIZE}-byte Core map`,
    );
  }

  const versionRaw = readUintBE(payload, 0, 2);
  const major = Math.floor(versionRaw / 1000);
  if (major > 1) {
    throw new Error(
      `Unsupported OpenTag3D major version ${(versionRaw / 1000).toFixed(3)} (this reader supports 1.x)`,
    );
  }
  const version = (versionRaw / 1000).toFixed(3);
  const versionNewerMinor = versionRaw > 1000;

  const fields: Record<string, Ot3dValue> = {};
  for (const f of OPENTAG3D_FIELDS) {
    if (f.start + f.length > payload.length) continue; // not covered by this image

    switch (f.type) {
      case "int": {
        const raw = readUintBE(payload, f.start, f.length);
        fields[f.id] = f.scaling != null ? raw * f.scaling : raw;
        break;
      }
      case "utf8":
      case "ascii": {
        const s = decodeString(payload, f);
        if (s) fields[f.id] = s;
        break;
      }
      case "rgba": {
        const c: Ot3dRgba = {
          r: payload[f.start],
          g: payload[f.start + 1],
          b: payload[f.start + 2],
          a: payload[f.start + 3],
        };
        // color_1 (primary) is kept even if transparent-black; the optional
        // secondary slots use transparent-black as "unused".
        if (f.id === "color_1" || !isTransparentBlack(c)) fields[f.id] = c;
        break;
      }
      case "date": {
        const d: Ot3dDate = {
          year: readUintBE(payload, f.start, 2),
          month: payload[f.start + 2],
          day: payload[f.start + 3],
        };
        if (d.year || d.month || d.day) fields[f.id] = d;
        break;
      }
      case "time": {
        const t: Ot3dTime = {
          hour: payload[f.start],
          minute: payload[f.start + 1],
          second: payload[f.start + 2],
        };
        fields[f.id] = t;
        break;
      }
    }
  }

  return {
    version,
    versionRaw,
    versionNewerMinor,
    fields,
    hasExtended: payload.length > OPENTAG3D_CORE_SIZE,
  };
}

// ── encode (dev write harness + test fixtures) ──────────────────────

/**
 * Encode a partial set of OpenTag3D field values (keyed by spec id) into a
 * fixed-binary payload. Used by the dev write CLI and the unit-test fixtures —
 * NOT a product write path (product OpenTag3D write is Phase 2). Unset fields
 * stay zero (the spec's "unused" state); reserved gaps stay zero.
 *
 * @param values   field id → value (int in real units, string, rgba, date, time)
 * @param opts.includeExtended  emit the full 0x00–0xBA image (default) or Core-only
 */
export function encodeOpenTag3D(
  values: Record<string, Ot3dValue>,
  opts: { includeExtended?: boolean } = {},
): Uint8Array {
  const includeExtended = opts.includeExtended ?? true;
  const size = includeExtended ? OPENTAG3D_TOTAL_SIZE : OPENTAG3D_CORE_SIZE;
  const buf = new Uint8Array(size);

  // Always stamp a version so the result is a valid OpenTag3D tag.
  const merged: Record<string, Ot3dValue> = { tag_version: 1.0, ...values };

  for (const f of OPENTAG3D_FIELDS) {
    if (f.start + f.length > size) continue; // extended field, core-only buffer
    const v = merged[f.id];
    if (v === undefined || v === null) continue;

    switch (f.type) {
      case "int": {
        const real = v as number;
        const raw = f.scaling != null ? Math.round(real / f.scaling) : Math.round(real);
        writeUintBE(buf, f.start, f.length, raw);
        break;
      }
      case "utf8":
      case "ascii": {
        const bytes = new TextEncoder().encode(String(v));
        buf.set(bytes.subarray(0, f.length), f.start); // truncate; zero-init pads
        break;
      }
      case "rgba": {
        const c = v as Ot3dRgba;
        buf[f.start] = c.r & 0xff;
        buf[f.start + 1] = c.g & 0xff;
        buf[f.start + 2] = c.b & 0xff;
        buf[f.start + 3] = c.a & 0xff;
        break;
      }
      case "date": {
        const d = v as Ot3dDate;
        writeUintBE(buf, f.start, 2, d.year);
        buf[f.start + 2] = d.month & 0xff;
        buf[f.start + 3] = d.day & 0xff;
        break;
      }
      case "time": {
        const t = v as Ot3dTime;
        buf[f.start] = t.hour & 0xff;
        buf[f.start + 1] = t.minute & 0xff;
        buf[f.start + 2] = t.second & 0xff;
        break;
      }
    }
  }

  return buf;
}

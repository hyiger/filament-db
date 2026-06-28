/**
 * Filament → OpenTag3D forward mapper (the inverse of opentag3d-decode.ts).
 *
 * DB-free / browser-safe (imports only the pure opentag3d + ndef libs), so it
 * runs in the renderer (the detail-page Write button builds the payload) AND in
 * the Electron main process. Produces an `Ot3dValue` field set for
 * `encodeOpenTag3D`, plus the NDEF Type-2 wrapping the NTAG write path needs.
 *
 * Field choices mirror `ot3dToDecodedTag` so write→read round-trips:
 *   - nozzle/bed: `print_temp`/`bed_temp` carry the recommended value, and the
 *     Extended `min/max_print_temp` carry the range when the filament has one.
 *     The decoder reads `nozzleTemp = max_print_temp ?? print_temp`, so a
 *     ranged filament shows min–max and an un-ranged one shows the single value.
 *   - dry_time is HOURS on the tag but MINUTES on the filament (decoder ×60).
 *   - coextruded (null primary + secondaries): `color_1` is left transparent-
 *     black, which the decoder (#895) reads as "no primary".
 *
 * Over-capacity inputs are reported in `notices` (the encoder itself silently
 * truncates) so the UI can warn before writing — e.g. an OpenTag3D
 * `material_base` is only 5 bytes, and there are only 3 secondary-color slots
 * vs OpenPrintTag's 5.
 */

import {
  encodeOpenTag3D,
  hexToRgba,
  OPENTAG3D_MIME,
  ot3dField,
  type Ot3dValue,
} from "./opentag3d";
import { buildMediaNdefRecord, buildNdefMessageTlv } from "./ndef";

/** The subset of a Filament document the mapper reads. All optional/nullable so
 * a partially-filled filament still produces a valid (sparse) tag. */
export interface FilamentForOpenTag3D {
  type?: string | null;
  vendor?: string | null;
  colorName?: string | null;
  color?: string | null;
  secondaryColors?: string[] | null;
  diameter?: number | null;
  netFilamentWeight?: number | null;
  density?: number | null;
  temperatures?: {
    nozzle?: number | null;
    bed?: number | null;
    nozzleRangeMin?: number | null;
    nozzleRangeMax?: number | null;
  } | null;
  dryingTemperature?: number | null;
  /** minutes (filament unit) — converted to hours for the tag */
  dryingTime?: number | null;
  maxVolumetricSpeed?: number | null;
  spoolWeight?: number | null;
}

export interface OpenTag3DEncodeOptions {
  /** Written to the `serial` field so a scan can match the exact spool. */
  spoolInstanceId?: string | null;
  /** Remaining (scale) grams → `measured_filament_weight`. When omitted, only
   * the nominal `target_weight` (netFilamentWeight) is written. */
  actualWeightGrams?: number | null;
}

export interface OpenTag3DFieldSet {
  fields: Record<string, Ot3dValue>;
  /** Human-readable warnings about lossy mappings (truncation / dropped slots).
   * i18n-agnostic English; callers surface them as a notice. */
  notices: string[];
}

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** Set a string field, flagging truncation when it exceeds the tag's byte budget. */
function setStr(
  out: Record<string, Ot3dValue>,
  notices: string[],
  id: string,
  value: string | null | undefined,
  label: string,
): void {
  const v = (value ?? "").trim();
  if (!v) return;
  const max = ot3dField(id).length;
  if (utf8Len(v) > max) {
    notices.push(`${label} "${v}" is longer than this tag allows (${max} bytes) and will be truncated.`);
  }
  out[id] = v;
}

function setNum(
  out: Record<string, Ot3dValue>,
  id: string,
  value: number | null | undefined,
): void {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    out[id] = value;
  }
}

/**
 * Map a filament (+ optional spool/remaining context) to an OpenTag3D field set.
 * Returns the fields for `encodeOpenTag3D` plus any lossy-mapping notices.
 */
export function filamentToOpenTag3DFields(
  f: FilamentForOpenTag3D,
  opts: OpenTag3DEncodeOptions = {},
): OpenTag3DFieldSet {
  const fields: Record<string, Ot3dValue> = {};
  const notices: string[] = [];

  // ── identity ──
  setStr(fields, notices, "material_base", f.type, "Material type");
  setStr(fields, notices, "manufacturer", f.vendor, "Vendor");
  setStr(fields, notices, "color_name", f.colorName, "Color name");

  // ── colors ──
  // Primary: a real hex → color_1. A coextruded filament (null primary +
  // secondaries) leaves color_1 transparent-black, which the decoder reads as
  // "no primary" (#895), so we simply don't set it.
  if (f.color && HEX_RE.test(f.color)) {
    fields.color_1 = hexToRgba(f.color);
  }
  const secondaries = (f.secondaryColors ?? []).filter((c) => typeof c === "string" && HEX_RE.test(c));
  const slots = ["color_2", "color_3", "color_4"]; // OpenTag3D has 3 vs OPT's 5
  secondaries.slice(0, slots.length).forEach((c, i) => {
    fields[slots[i]] = hexToRgba(c);
  });
  if (secondaries.length > slots.length) {
    notices.push(
      `OpenTag3D has only ${slots.length} secondary-color slots; ${secondaries.length - slots.length} extra color(s) won't be written.`,
    );
  }

  // ── physical ──
  setNum(fields, "target_diameter", f.diameter);
  setNum(fields, "target_weight", f.netFilamentWeight);
  setNum(fields, "density", f.density);
  setNum(fields, "empty_spool_weight", f.spoolWeight);

  // ── temperatures ── recommended on Core, range on Extended (decoder reads
  // nozzleTemp = max_print_temp ?? print_temp).
  const t = f.temperatures ?? {};
  setNum(fields, "print_temp", t.nozzle);
  setNum(fields, "min_print_temp", t.nozzleRangeMin);
  setNum(fields, "max_print_temp", t.nozzleRangeMax);
  setNum(fields, "bed_temp", t.bed);

  // ── drying ── dryingTime is MINUTES; the tag stores HOURS (decoder ×60).
  setNum(fields, "max_dry_temp", f.dryingTemperature);
  if (typeof f.dryingTime === "number" && Number.isFinite(f.dryingTime) && f.dryingTime > 0) {
    fields.dry_time = Math.round(f.dryingTime / 60);
  }

  // ── volumetric speed ── decoder reads maxVolumetricSpeed = max_vso ?? target_vso.
  setNum(fields, "max_vso", f.maxVolumetricSpeed);

  // ── identity / remaining ──
  setStr(fields, notices, "serial", opts.spoolInstanceId, "Spool ID");
  setNum(fields, "measured_filament_weight", opts.actualWeightGrams);

  return { fields, notices };
}

/**
 * Build the full NDEF Type-2 message TLV for an OpenTag3D field set — the bytes
 * an NTAG write path lays down from page 4. Mirrors the dev CLI's
 * encode → media-record → TLV sequence so the two share one code path.
 * `includeExtended` false emits the 112-byte Core image (fits a tiny NTAG213).
 */
export function wrapOpenTag3DType2(
  fields: Record<string, Ot3dValue>,
  opts: { includeExtended?: boolean } = {},
): { payload: Uint8Array; tlv: Uint8Array } {
  const payload = encodeOpenTag3D(fields, { includeExtended: opts.includeExtended ?? true });
  const tlv = buildNdefMessageTlv(buildMediaNdefRecord(OPENTAG3D_MIME, payload));
  return { payload, tlv };
}

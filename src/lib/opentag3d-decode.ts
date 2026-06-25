/**
 * OpenTag3D → DecodedOpenPrintTag mapping.
 *
 * Decodes an OpenTag3D binary payload (via opentag3d.ts) and maps its fields
 * onto the SAME `DecodedOpenPrintTag` shape the OpenPrintTag and Bambu decoders
 * already emit, so matching (matchFilament.ts), the read dialog, and the scan
 * bus stay codec-agnostic. The inverse of generateOpenPrintTag* is irrelevant
 * here — OpenTag3D is a different wire format (fixed binary, not CBOR).
 *
 * Mapping rules:
 *   - Fields with a first-class home on DecodedOpenPrintTag reuse it (colors,
 *     temps, density, diameter, weights, drying, TD, brand/material, etc.).
 *   - OpenTag3D-only fields with NO existing home (MFI block, spool-core
 *     diameter, measured tolerance, the vso triple, serial, manufacture
 *     timestamp, online URL) are stashed in `aux` under `opentag3d_*` keys so
 *     nothing is lost and the read dialog can surface them. (Per #864 they ride
 *     the Filament `settings` passthrough bag on create — see
 *     decodedTagToFilament.ts — rather than getting first-class schema columns
 *     in this read-only phase.)
 *
 * NOTE on TD: OpenTag3D's `td` is "opaque thickness in millimetres" (raw ÷10).
 * It is mapped onto `transmissionDistance` for display continuity, but the unit
 * semantics differ from OpenPrintTag's transmission-distance — flagged here and
 * surfaced verbatim in `aux.opentag3d_td_mm` so the raw mm value is never lost.
 */

import {
  decodeOpenTag3D,
  isTransparentBlack,
  rgbaToHex,
  type Ot3dDate,
  type Ot3dDecoded,
  type Ot3dRgba,
  type Ot3dTime,
} from "./opentag3d";
import type { DecodedOpenPrintTag } from "./openprinttag-decode";

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
/** A temperature/weight of 0 in a fixed memory map means "unset"; drop it. */
function posNum(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
}

/** Zero-pad an integer to a fixed width. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * Map a decoded OpenTag3D field set onto a DecodedOpenPrintTag. Exposed
 * separately from decodeOpenTag3DTag so callers that already have the raw
 * decode (e.g. tests) can map without re-parsing.
 */
export function ot3dToDecodedTag(decoded: Ot3dDecoded): DecodedOpenPrintTag {
  const f = decoded.fields;
  const aux: Record<string, unknown> = {};

  // ── identity / material ──
  const base = str(f.material_base);
  const mod = str(f.material_mod);
  const materialType = base;
  const materialName = base ? (mod ? `${base} ${mod}` : base) : undefined;
  if (mod) aux.opentag3d_material_modifier = mod;

  // ── colors ──
  const color = f.color_1 ? rgbaToHex(f.color_1 as Ot3dRgba) : undefined;
  const secondaryColors: string[] = [];
  for (const id of ["color_2", "color_3", "color_4"]) {
    const c = f[id] as Ot3dRgba | undefined;
    if (c && !isTransparentBlack(c)) secondaryColors.push(rgbaToHex(c));
  }

  // ── manufacture timestamp ──
  let productionDate: string | undefined;
  const d = f.mfg_date as Ot3dDate | undefined;
  if (d) {
    productionDate = `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
    const t = f.mfg_time as Ot3dTime | undefined;
    if (t) productionDate += ` ${pad(t.hour, 2)}:${pad(t.minute, 2)}:${pad(t.second, 2)} UTC`;
  }

  // ── Extended no-home fields → aux (lossless; ride settings bag on create) ──
  const serial = str(f.serial);
  if (serial) aux.opentag3d_serial = serial;
  const onlineUrl = str(f.online_data_url);
  // Stored WITHOUT a scheme to save bytes; surface the raw value (the
  // create/display path re-prefixes https:// and gates through safeHttpUrl).
  if (onlineUrl) aux.opentag3d_online_data_url = onlineUrl;
  const spoolCore = posNum(f.spool_core_diameter);
  if (spoolCore !== undefined) aux.opentag3d_spool_core_diameter_mm = spoolCore;
  const mfiTemp = posNum(f.mfi_temp);
  const mfiLoad = posNum(f.mfi_load);
  const mfiValue = posNum(f.mfi_value);
  if (mfiTemp !== undefined) aux.opentag3d_mfi_temp_c = mfiTemp;
  if (mfiLoad !== undefined) aux.opentag3d_mfi_load_g = mfiLoad;
  if (mfiValue !== undefined) aux.opentag3d_mfi_value = mfiValue;
  const tol = posNum(f.measured_tolerance);
  if (tol !== undefined) aux.opentag3d_measured_tolerance_um = tol;
  const measuredWeight = posNum(f.measured_filament_weight);
  const measuredLength = posNum(f.measured_filament_length);
  if (measuredLength !== undefined) aux.opentag3d_measured_filament_length_m = measuredLength;
  const maxPrintTemp = posNum(f.max_print_temp);
  const maxBedTemp = posNum(f.max_bed_temp);
  if (maxPrintTemp !== undefined) aux.opentag3d_max_print_temp_c = maxPrintTemp;
  if (maxBedTemp !== undefined) aux.opentag3d_max_bed_temp_c = maxBedTemp;
  const minVso = posNum(f.min_vso);
  const maxVso = posNum(f.max_vso);
  const targetVso = posNum(f.target_vso);
  if (minVso !== undefined) aux.opentag3d_min_volumetric_speed = minVso;
  if (maxVso !== undefined) aux.opentag3d_max_volumetric_speed = maxVso;
  if (targetVso !== undefined) aux.opentag3d_target_volumetric_speed = targetVso;
  const tdMm = posNum(f.td);
  if (tdMm !== undefined) aux.opentag3d_td_mm = tdMm;
  // OpenTag3D dry_time is in HOURS; DecodedOpenPrintTag.dryingTime is MINUTES
  // (the read dialog renders it as Hh Mm), so convert on the way in.
  const dryHours = posNum(f.dry_time);
  if (decoded.versionNewerMinor) aux.opentag3d_version = decoded.version;

  const tag: DecodedOpenPrintTag = {
    meta: {},
    main: { ...f },
    tagSource: "opentag3d",
    materialType,
    materialName,
    materialAbbreviation: base,
    brandName: str(f.manufacturer),
    colorName: str(f.color_name),
    color,
    secondaryColors: secondaryColors.length ? secondaryColors : undefined,
    density: posNum(f.density),
    diameter: posNum(f.target_diameter),
    nozzleTemp: posNum(f.print_temp),
    nozzleTempMin: posNum(f.min_print_temp),
    bedTemp: posNum(f.bed_temp),
    bedTempMin: posNum(f.min_bed_temp),
    weightGrams: posNum(f.target_weight),
    actualWeightGrams: measuredWeight,
    emptySpoolWeight: posNum(f.empty_spool_weight),
    dryingTemperature: posNum(f.max_dry_temp),
    dryingTime: dryHours !== undefined ? dryHours * 60 : undefined,
    // OpenTag3D `td` (opaque thickness, mm) is intentionally NOT mapped onto
    // transmissionDistance — that is OpenPrintTag's HueForge TD, a different
    // quantity. The raw mm value is preserved in aux.opentag3d_td_mm instead.
    maxVolumetricSpeed: targetVso ?? maxVso,
    filamentLength: measuredLength,
    productionDate,
    aux: Object.keys(aux).length ? aux : undefined,
  };

  return tag;
}

/**
 * Decode an OpenTag3D NDEF-record payload into a DecodedOpenPrintTag.
 * Throws on a payload too short or an unsupported major version.
 */
export function decodeOpenTag3DTag(payload: Uint8Array): DecodedOpenPrintTag {
  return ot3dToDecodedTag(decodeOpenTag3D(payload));
}

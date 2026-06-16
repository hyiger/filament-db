/**
 * DTOs mirroring the Filament DB REST API surface the scanner uses.
 *
 * Hand-maintained for Phase 1. These can later be generated from
 * `public/openapi.json` (e.g. openapi-typescript) so the client can't drift
 * from the server — see docs/mobile-app-plan.md §7. Kept deliberately partial:
 * only the fields the app reads/writes are typed; `[k: string]: unknown` keeps
 * the rest of each document accessible without over-specifying.
 */

export interface DecodedOpenPrintTag {
  materialName?: string;
  brandName?: string;
  materialType?: string;
  color?: string;
  secondaryColors?: string[];
  diameter?: number;
  nozzleTemp?: number;
  nozzleTempMin?: number;
  bedTemp?: number;
  /** Nominal full-roll net weight (OpenPrintTag key 16), grams. */
  weightGrams?: number;
  /** ACTUAL remaining filament weight (OpenPrintTag key 17), grams — what's
   *  really left on a partial roll; defaults to weightGrams on a full roll. */
  actualWeightGrams?: number;
  spoolUid?: string;
  tagSource?: 'openprinttag' | 'bambu';
  readOnly?: boolean;
  [k: string]: unknown;
}

export interface Spool {
  _id: string;
  label?: string;
  /** #732: per-spool 5-byte hex id (10 hex chars) — the durable spool identity. */
  instanceId?: string;
  /** Gross weight (filament + empty spool tare), grams. Null = unknown. */
  totalWeight?: number | null;
  locationId?: string | null;
  retired?: boolean;
}

/** Resolved temperatures (the detail endpoint runs resolveFilament). All nullable. */
export interface FilamentTemperatures {
  nozzle?: number | null;
  nozzleFirstLayer?: number | null;
  nozzleRangeMin?: number | null;
  nozzleRangeMax?: number | null;
  bed?: number | null;
  bedFirstLayer?: number | null;
  standby?: number | null;
}

export interface Filament {
  _id: string;
  name: string;
  vendor?: string;
  type?: string;
  color?: string | null;
  colorName?: string | null;
  secondaryColors?: string[];
  instanceId?: string;
  /** Empty-spool tare, grams. Used to derive remaining filament. */
  spoolWeight?: number | null;
  /** Nominal net filament weight, grams. */
  netFilamentWeight?: number | null;
  density?: number | null;
  diameter?: number | null;
  temperatures?: FilamentTemperatures;
  dryingTemperature?: number | null;
  /** Drying time in minutes. */
  dryingTime?: number | null;
  shoreHardnessA?: number | null;
  shoreHardnessD?: number | null;
  transmissionDistance?: number | null;
  glassTempTransition?: number | null;
  heatDeflectionTemp?: number | null;
  spools?: Spool[];
  [k: string]: unknown;
}

export interface Location {
  _id: string;
  name: string;
  kind?: string;
}

export interface MatchResult {
  match: Filament | null;
  candidates: Filament[];
  /**
   * #732: the specific spool whose instanceId matched, or null/absent for a
   * filament-level (legacy fallback) / name / vendor+type match. Absent when
   * talking to a pre-Phase-2 server — always read it optionally.
   */
  matchedSpool?: Spool | null;
}

export interface NfcDecodeResponse {
  decoded: DecodedOpenPrintTag;
  match: Filament | null;
  candidates: Filament[];
  /**
   * How `match` was resolved. Only `'instanceId'` is a confident "this exact
   * tag is in the DB"; `'heuristic'` is a weaker name / vendor+type match that
   * may be a sibling color, so the scanner offers "create new" alongside it.
   */
  matchedBy?: 'instanceId' | 'heuristic' | null;
  /** #732: the spool the tag's spool_uid resolved to (see MatchResult.matchedSpool). */
  matchedSpool?: Spool | null;
}

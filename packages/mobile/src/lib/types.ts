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
  weightGrams?: number;
  spoolUid?: string;
  tagSource?: 'openprinttag' | 'bambu';
  readOnly?: boolean;
  [k: string]: unknown;
}

export interface Spool {
  _id: string;
  label?: string;
  /** Gross weight (filament + empty spool tare), grams. Null = unknown. */
  totalWeight?: number | null;
  locationId?: string | null;
  retired?: boolean;
}

export interface Filament {
  _id: string;
  name: string;
  vendor?: string;
  type?: string;
  color?: string | null;
  secondaryColors?: string[];
  instanceId?: string;
  /** Empty-spool tare, grams. Used to derive remaining filament. */
  spoolWeight?: number | null;
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
}

export interface NfcDecodeResponse {
  decoded: DecodedOpenPrintTag;
  match: Filament | null;
  candidates: Filament[];
}

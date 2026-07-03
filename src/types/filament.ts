/**
 * Shared Filament type definitions used across pages and components.
 * Single source of truth — avoids redeclaring Filament interfaces in every file.
 */

export interface FilamentVariant {
  _id: string;
  name: string;
  /** GH #477: primary color hex. May be `null` per OpenPrintTag spec key
   *  19 — coextruded / rainbow filaments don't have a single primary,
   *  and the form's "Coextruded" arrangement toggle writes `null` here.
   *  UI sites that need a single representative color should call
   *  `displayColor()` from `src/lib/filamentColors.ts` to fall back to
   *  `secondaryColors[0]`. */
  color: string | null;
  /** GH #477: up to 5 additional color hexes, mirroring OpenPrintTag
   *  spec keys 20–24. Inherits as a whole array from parent when this
   *  variant's array is empty. */
  secondaryColors?: string[];
  cost: number | null;
  /** Tag IDs that drive the finish-derived swatch texture + chip when
   * this variant is rendered under its parent on the detail page. The
   * parent-detail variants projection in `/api/filaments/{id}` includes
   * this for the same reason `FilamentSummary` carries it on list rows. */
  optTags?: number[];
}

export interface FilamentNozzle {
  _id: string;
  name: string;
  diameter: number;
  type: string;
  highFlow: boolean;
}

export interface FilamentPrinter {
  _id: string;
  name: string;
}

export interface FilamentBedType {
  _id: string;
  name: string;
  material: string;
}

export interface FilamentCalibration {
  printer: FilamentPrinter | null;
  nozzle: FilamentNozzle & { highFlow: boolean };
  bedType: FilamentBedType | null;
  extrusionMultiplier: number | null;
  maxVolumetricSpeed: number | null;
  pressureAdvance: number | null;
  retractLength: number | null;
  retractSpeed: number | null;
  retractLift: number | null;
  nozzleTemp: number | null;
  nozzleTempFirstLayer: number | null;
  bedTemp: number | null;
  bedTempFirstLayer: number | null;
  chamberTemp: number | null;
  fanMinSpeed: number | null;
  fanMaxSpeed: number | null;
  fanBridgeSpeed: number | null;
}

export interface FilamentPreset {
  label: string;
  extrusionMultiplier: number | null;
  temperatures: {
    nozzle: number | null;
    nozzleFirstLayer: number | null;
    bed: number | null;
    bedFirstLayer: number | null;
  };
}

export interface FilamentSpool {
  _id: string;
  /** #732: per-spool 5-byte hex id (10 hex chars). */
  instanceId?: string;
  label: string;
  totalWeight: number | null;
  lotNumber?: string | null;
  purchaseDate?: string | null;
  openedDate?: string | null;
  createdAt: string;
  /** Retired spools drop out of inventory counts but keep their history. */
  retired?: boolean;
}

export interface FilamentTemperatures {
  nozzle: number | null;
  nozzleFirstLayer: number | null;
  nozzleRangeMin?: number | null;
  nozzleRangeMax?: number | null;
  bed: number | null;
  bedFirstLayer: number | null;
  standby?: number | null;
}

/** Full filament detail (used on detail page and form initialData) */
export interface FilamentDetail {
  _id: string;
  name: string;
  instanceId?: string;
  vendor: string;
  type: string;
  /** GH #477: nullable per OpenPrintTag spec. See FilamentVariant.color. */
  color: string | null;
  /** GH #477: spec keys 20–24, up to 5 secondary color hexes. */
  secondaryColors?: string[];
  cost: number | null;
  density: number | null;
  diameter: number;
  temperatures: FilamentTemperatures;
  maxVolumetricSpeed: number | null;
  compatibleNozzles: FilamentNozzle[];
  calibrations: FilamentCalibration[];
  presets: FilamentPreset[];
  spools: FilamentSpool[];
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  totalWeight: number | null;
  dryingTemperature: number | null;
  dryingTime: number | null;
  transmissionDistance: number | null;
  glassTempTransition: number | null;
  heatDeflectionTemp: number | null;
  shoreHardnessA: number | null;
  shoreHardnessD: number | null;
  minPrintSpeed: number | null;
  maxPrintSpeed: number | null;
  colorName: string | null;
  spoolType: string | null;
  optTags: number[];
  tdsUrl: string | null;
  inherits: string | null;
  parentId: string | null;
  settings: Record<string, string | null>;
  _inherited?: string[];
  _variants?: FilamentVariant[];
  /** Light parent summary attached when this filament is a variant. The
   * non-raw GET sets just `{ _id, name }` so the variant detail page can
   * render an "Up to <parent>" link without a second request; the raw
   * GET (used by the edit form) attaches the full parent doc instead. */
  _parent?: { _id: string; name: string };
  /** GH #607: true when THIS row carries its own `openprinttag_slug`
   *  (computed server-side from the raw doc, before settings inheritance).
   *  Gates the "Check for updates" button so an inherited slug on a variant
   *  doesn't show a dead action. */
  _hasOwnOptLink?: boolean;
  // GH #955: form-managed schema fields that were missing from the type. Kept
  // client-safe (no import from src/models, which pulls in mongoose) by
  // mirroring IBedTypeTemp locally.
  bedTypeTemps?: FilamentBedTypeTemp[];
  /** Below this many grams remaining, the row shows a low-stock badge. */
  lowStockThreshold?: number | null;
  shrinkageXY?: number | null;
  shrinkageZ?: number | null;
}

/** Client-safe mirror of the model's IBedTypeTemp (per-bed-surface temps). */
export interface FilamentBedTypeTemp {
  bedType: string;
  temperature: number | null;
  firstLayerTemperature: number | null;
}

/** Lightweight filament summary (used on list/dashboard page) */
export interface FilamentSummary {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  /** GH #477: nullable per OpenPrintTag spec. See FilamentVariant.color. */
  color: string | null;
  /** GH #477: spec keys 20–24, up to 5 secondary color hexes. */
  secondaryColors?: string[];
  cost: number | null;
  density: number | null;
  parentId: string | null;
  spools: {
    _id: string;
    /** #732 — per-spool 5-byte hex id (10 hex chars). */
    instanceId?: string;
    /** #717 — per-spool label, shown in the home-page spool panel so the user
     * can tell spools apart when changing a location. */
    label?: string | null;
    totalWeight: number | null;
    /** v1.11 — retired spools are excluded from inventory totals and list
     * weight bars, but the spool itself remains for historical reference. */
    retired?: boolean;
    /** #616 — location reference, used to count distinct spool locations for
     * the home-page stat line AND (#717) to show/change a spool's location
     * inline in the expandable per-spool panel. Null when unassigned. */
    locationId?: string | null;
    /** #941 — provenance dates (ISO strings after JSON serialization), used to
     * sort/display the home list's Purchased/Opened columns. Null when unset. */
    purchaseDate?: string | null;
    openedDate?: string | null;
  }[];
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  totalWeight: number | null;
  /** v1.11 — remaining-grams threshold below which this filament is flagged
   * as low stock in the list and on the dashboard. Null = not configured. */
  lowStockThreshold?: number | null;
  temperatures: {
    nozzle: number | null;
    bed: number | null;
  };
  /** True when the filament has at least one nozzle calibration. Used by
   * the noCalibration quick filter on the list page; computed in the
   * aggregation projection so the full calibrations array doesn't need
   * to ship with every list row. */
  hasCalibrations?: boolean;
  /** True when ≥1 non-deleted filament currently references this row as
   * parent. Drives the cross-hatch swatch render: parents have no
   * canonical color of their own. Auto-detected — no schema flag. */
  hasVariants?: boolean;
  /** Numeric optTag IDs ridden through the list aggregation so the row
   * can render its finish-derived swatch texture (matte/silk/sparkle/
   * glow/translucent/transparent) and the matching chip beside the
   * name. See `src/lib/filamentFinish.ts` for the tag-id → finish map. */
  optTags?: number[];
}

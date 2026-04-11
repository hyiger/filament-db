/**
 * Shared Filament type definitions used across pages and components.
 * Single source of truth — avoids redeclaring Filament interfaces in every file.
 */

export interface FilamentVariant {
  _id: string;
  name: string;
  color: string;
  cost: number | null;
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
  label: string;
  totalWeight: number | null;
  lotNumber?: string | null;
  purchaseDate?: string | null;
  openedDate?: string | null;
  createdAt: string;
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
  color: string;
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
}

/** Lightweight filament summary (used on list/dashboard page) */
export interface FilamentSummary {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
  cost: number | null;
  density: number | null;
  parentId: string | null;
  spools: {
    _id: string;
    totalWeight: number | null;
  }[];
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  totalWeight: number | null;
  temperatures: {
    nozzle: number | null;
    bed: number | null;
  };
}

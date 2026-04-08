/**
 * Resolves a filament's effective values by merging parent defaults with variant overrides.
 *
 * For variants (filaments with a parentId), fields set to null/undefined inherit from the parent.
 * Fields with explicit values on the variant override the parent.
 *
 * The `color` field always comes from the variant itself (never inherited).
 * The `name` field always comes from the variant itself.
 * The `settings` bag is shallow-merged: parent settings as base, variant settings as overrides.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilamentDoc = Record<string, any>;

/** Fields that are always variant-specific and never inherited */
const VARIANT_ONLY_FIELDS = ["_id", "name", "color", "colorName", "parentId", "spools", "createdAt", "updatedAt", "__v", "instanceId", "syncId", "_deletedAt", "totalWeight"];

/** Numeric/string fields that can be inherited from parent */
const INHERITABLE_FIELDS = [
  "vendor",
  "type",
  "cost",
  "density",
  "diameter",
  "maxVolumetricSpeed",
  "spoolWeight",
  "netFilamentWeight",
  "dryingTemperature",
  "dryingTime",
  "transmissionDistance",
  "glassTempTransition",
  "heatDeflectionTemp",
  "shoreHardnessA",
  "shoreHardnessD",
  "minPrintSpeed",
  "maxPrintSpeed",
  "spoolType",
  "tdsUrl",
  "inherits",
  "shrinkageXY",
  "shrinkageZ",
];

/**
 * Resolve a filament by merging parent defaults with variant overrides.
 * Returns a new object with all resolved values plus `_inherited` metadata
 * indicating which fields came from the parent.
 */
export function resolveFilament(
  filament: FilamentDoc,
  parent: FilamentDoc | null | undefined,
): FilamentDoc & { _inherited: string[] } {
  // No parent = standalone filament, nothing to resolve
  if (!parent || !filament.parentId) {
    return { ...filament, _inherited: [] };
  }

  const resolved: FilamentDoc = {};
  const inherited: string[] = [];

  // Copy variant-only fields directly
  for (const field of VARIANT_ONLY_FIELDS) {
    resolved[field] = filament[field];
  }

  // Resolve inheritable scalar fields
  for (const field of INHERITABLE_FIELDS) {
    const variantVal = filament[field];
    if (variantVal != null && variantVal !== "") {
      resolved[field] = variantVal;
    } else {
      resolved[field] = parent[field];
      if (parent[field] != null) {
        inherited.push(field);
      }
    }
  }

  // Resolve temperatures (nested object)
  const variantTemps = filament.temperatures || {};
  const parentTemps = parent.temperatures || {};
  resolved.temperatures = {
    nozzle: variantTemps.nozzle ?? parentTemps.nozzle ?? null,
    nozzleFirstLayer: variantTemps.nozzleFirstLayer ?? parentTemps.nozzleFirstLayer ?? null,
    bed: variantTemps.bed ?? parentTemps.bed ?? null,
    bedFirstLayer: variantTemps.bedFirstLayer ?? parentTemps.bedFirstLayer ?? null,
    nozzleRangeMin: variantTemps.nozzleRangeMin ?? parentTemps.nozzleRangeMin ?? null,
    nozzleRangeMax: variantTemps.nozzleRangeMax ?? parentTemps.nozzleRangeMax ?? null,
    standby: variantTemps.standby ?? parentTemps.standby ?? null,
  };
  for (const tempField of ["nozzle", "nozzleFirstLayer", "bed", "bedFirstLayer", "nozzleRangeMin", "nozzleRangeMax", "standby"]) {
    if (
      variantTemps[tempField] == null &&
      parentTemps[tempField] != null
    ) {
      inherited.push(`temperatures.${tempField}`);
    }
  }

  // Resolve compatibleNozzles — use variant's if defined (even empty), otherwise parent's
  if (filament.compatibleNozzles !== undefined) {
    resolved.compatibleNozzles = filament.compatibleNozzles;
  } else {
    resolved.compatibleNozzles = parent.compatibleNozzles || [];
    if (parent.compatibleNozzles?.length > 0) {
      inherited.push("compatibleNozzles");
    }
  }

  // Resolve optTags — use variant's if defined (even empty), otherwise parent's
  if (filament.optTags !== undefined) {
    resolved.optTags = filament.optTags;
  } else {
    resolved.optTags = parent.optTags || [];
    if (parent.optTags?.length > 0) {
      inherited.push("optTags");
    }
  }

  // Resolve bedTypeTemps — use variant's if defined (even empty), otherwise parent's
  if (filament.bedTypeTemps !== undefined) {
    resolved.bedTypeTemps = filament.bedTypeTemps;
  } else {
    resolved.bedTypeTemps = parent.bedTypeTemps || [];
    if (parent.bedTypeTemps?.length > 0) {
      inherited.push("bedTypeTemps");
    }
  }

  // Resolve calibrations — use variant's if defined (even empty), otherwise parent's
  if (filament.calibrations !== undefined) {
    resolved.calibrations = filament.calibrations;
  } else {
    resolved.calibrations = parent.calibrations || [];
    if (parent.calibrations?.length > 0) {
      inherited.push("calibrations");
    }
  }

  // Resolve presets — use variant's if defined (even empty), otherwise parent's
  if (filament.presets !== undefined) {
    resolved.presets = filament.presets;
  } else {
    resolved.presets = parent.presets || [];
    if (parent.presets?.length > 0) {
      inherited.push("presets");
    }
  }

  // Resolve settings — shallow merge, variant overrides parent
  const parentSettings = parent.settings || {};
  const variantSettings = filament.settings || {};
  resolved.settings = { ...parentSettings, ...variantSettings };
  if (Object.keys(parentSettings).length > 0 && Object.keys(variantSettings).length === 0) {
    inherited.push("settings");
  }

  resolved._inherited = inherited;
  return resolved as FilamentDoc & { _inherited: string[] };
}

/**
 * Check if a filament is a parent (has variants pointing to it).
 * This is a query helper — call with the Filament model.
 */
export async function hasVariants(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilamentModel: any,
  parentId: string,
): Promise<boolean> {
  const count = await FilamentModel.countDocuments({ parentId, _deletedAt: null });
  return count > 0;
}

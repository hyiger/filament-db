/**
 * Spool weight check logic — platform-agnostic, no database dependency.
 *
 * Extracted from the spool-check API route for reuse in the mobile app.
 */

export interface SpoolInput {
  _id: string;
  label: string;
  totalWeight: number | null;
}

export interface SpoolCheckResult {
  ok: boolean;
  requiredWeightG: number;
  requiredLengthM: number | null;
  spools: SpoolResult[];
  warning?: string;
}

export interface SpoolResult {
  id: string;
  label: string;
  remainingWeightG: number;
  remainingLengthM: number | null;
  enough: boolean;
}

/**
 * Convert weight in grams to filament length in meters.
 * Returns null if density or diameter are missing/invalid.
 */
export function weightToLengthM(
  weightG: number,
  density: number | null | undefined,
  diameter: number | null | undefined,
): number | null {
  if (!density || density <= 0 || !diameter || diameter <= 0) return null;
  const volumeCm3 = weightG / density;
  const radiusCm = diameter / 20;
  const areaCm2 = Math.PI * radiusCm * radiusCm;
  return volumeCm3 / areaCm2 / 100;
}

/**
 * Check whether any spool has enough remaining filament for a print job.
 *
 * @param spools - Array of spools with totalWeight
 * @param spoolWeight - Empty spool weight in grams (subtracted from totalWeight)
 * @param requiredWeight - Required filament weight in grams
 * @param density - Filament density in g/cm³ (for length calculation)
 * @param diameter - Filament diameter in mm (for length calculation)
 * @returns Spool check result with per-spool breakdown
 */
export function checkSpoolWeight(
  spools: SpoolInput[],
  spoolWeight: number | null,
  requiredWeight: number,
  density?: number | null,
  diameter?: number | null,
): SpoolCheckResult {
  const requiredLengthM = weightToLengthM(requiredWeight, density, diameter);

  if (spools.length === 0 || spoolWeight == null) {
    return {
      ok: true,
      requiredWeightG: Math.round(requiredWeight * 10) / 10,
      requiredLengthM: requiredLengthM !== null ? Math.round(requiredLengthM * 100) / 100 : null,
      spools: [],
    };
  }

  const spoolResults = spools
    .filter((s) => s.totalWeight != null)
    .map((s) => {
      const remainingWeight = Math.max(0, s.totalWeight! - spoolWeight);
      const remainingLengthM = weightToLengthM(remainingWeight, density, diameter);
      const enough = remainingWeight >= requiredWeight;
      return {
        id: String(s._id),
        label: s.label || "Default",
        remainingWeightG: Math.round(remainingWeight * 10) / 10,
        remainingLengthM: remainingLengthM !== null ? Math.round(remainingLengthM * 100) / 100 : null,
        enough,
      };
    });

  if (spoolResults.length === 0) {
    return {
      ok: true,
      requiredWeightG: Math.round(requiredWeight * 10) / 10,
      requiredLengthM: requiredLengthM !== null ? Math.round(requiredLengthM * 100) / 100 : null,
      spools: [],
    };
  }

  const anyEnough = spoolResults.some((s) => s.enough);

  const result: SpoolCheckResult = {
    ok: anyEnough,
    requiredWeightG: Math.round(requiredWeight * 10) / 10,
    requiredLengthM: requiredLengthM !== null ? Math.round(requiredLengthM * 100) / 100 : null,
    spools: spoolResults,
  };

  if (!anyEnough) {
    const best = spoolResults.reduce((a, b) =>
      a.remainingWeightG > b.remainingWeightG ? a : b
    );
    const shortfall = Math.round((requiredWeight - best.remainingWeightG) * 10) / 10;
    result.warning = `Insufficient filament: need ${result.requiredWeightG}g but best spool "${best.label}" has ${best.remainingWeightG}g remaining (${shortfall}g short)`;
  }

  return result;
}

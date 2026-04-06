import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/filaments/{nameOrId}/spool-check?weight=42.5
 *
 * Checks whether any spool of this filament has enough remaining
 * filament (by weight in grams) for a print job.
 *
 * Query params:
 *   weight  — estimated filament weight in grams (required)
 *
 * Finds the filament by URL-encoded name (falling back to ObjectId),
 * then for each spool computes:
 *   remainingWeight = spool.totalWeight - filament.spoolWeight
 *
 * Returns:
 *   ok       — true if at least one spool has enough remaining
 *   spools[] — per-spool breakdown (label, remaining, enough flag)
 *   warning  — human-readable warning if no spool has enough
 *
 * If the filament has no spools, or no spool has a totalWeight set,
 * returns ok: true (no data = no warning).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const { searchParams } = request.nextUrl;
    const weightParam = searchParams.get("weight");

    if (!weightParam) {
      return errorResponse("weight query param required (estimated filament weight in grams)", 400);
    }
    const requiredWeight = parseFloat(weightParam);
    if (isNaN(requiredWeight) || requiredWeight < 0) {
      return errorResponse("weight must be a non-negative number", 400);
    }

    // Find filament by name or ObjectId
    const decodedName = decodeURIComponent(id);
    let filament = await Filament.findOne({ name: decodedName, _deletedAt: null }).lean();
    if (!filament && /^[a-f0-9]{24}$/i.test(id)) {
      filament = await Filament.findOne({ _id: id, _deletedAt: null }).lean();
    }

    if (!filament) {
      return errorResponse(`Filament not found: ${decodedName}`, 404);
    }

    const spoolWeight = filament.spoolWeight as number | null;
    const density = filament.density as number | null;
    const diameter = filament.diameter as number | null;

    // Collect all spools — multi-spool array takes priority, fall back to legacy single spool
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawSpools: any[] = [];
    if (Array.isArray(filament.spools) && filament.spools.length > 0) {
      rawSpools.push(...filament.spools);
    } else if (filament.totalWeight != null) {
      // Legacy single-spool mode
      rawSpools.push({
        _id: "default",
        label: "Default",
        totalWeight: filament.totalWeight,
      });
    }

    // If no spools or no spool weight configured, we can't check — assume OK
    if (rawSpools.length === 0 || spoolWeight == null) {
      return NextResponse.json({
        ok: true,
        filament: filament.name,
        message: "No spool weight data available — skipping check",
        spools: [],
      });
    }

    // Compute remaining length in meters from weight
    function weightToLengthM(weightG: number): number | null {
      if (!density || density <= 0 || !diameter || diameter <= 0) return null;
      const volumeCm3 = weightG / density;
      const radiusCm = diameter / 20;
      const areaCm2 = Math.PI * radiusCm * radiusCm;
      return volumeCm3 / areaCm2 / 100;
    }

    const requiredLengthM = weightToLengthM(requiredWeight);

    // Check each spool
    const spoolResults = rawSpools
      .filter((s) => s.totalWeight != null)
      .map((s) => {
        const remainingWeight = Math.max(0, (s.totalWeight as number) - spoolWeight);
        const remainingLengthM = weightToLengthM(remainingWeight);
        const enough = remainingWeight >= requiredWeight;
        return {
          id: String(s._id),
          label: s.label || "Default",
          remainingWeightG: Math.round(remainingWeight * 10) / 10,
          remainingLengthM: remainingLengthM !== null ? Math.round(remainingLengthM * 100) / 100 : null,
          enough,
        };
      });

    // If no spools had totalWeight set, assume OK
    if (spoolResults.length === 0) {
      return NextResponse.json({
        ok: true,
        filament: filament.name,
        message: "No spool weight data available — skipping check",
        spools: [],
      });
    }

    const anyEnough = spoolResults.some((s) => s.enough);

    const response: Record<string, unknown> = {
      ok: anyEnough,
      filament: filament.name,
      requiredWeightG: Math.round(requiredWeight * 10) / 10,
      requiredLengthM: requiredLengthM !== null ? Math.round(requiredLengthM * 100) / 100 : null,
      spools: spoolResults,
    };

    if (!anyEnough) {
      const best = spoolResults.reduce((a, b) =>
        a.remainingWeightG > b.remainingWeightG ? a : b
      );
      const shortfall = Math.round((requiredWeight - best.remainingWeightG) * 10) / 10;
      response.warning = `Insufficient filament: need ${response.requiredWeightG}g but best spool "${best.label}" has ${best.remainingWeightG}g remaining (${shortfall}g short)`;
    }

    return NextResponse.json(response);
  } catch (err) {
    return errorResponse("Failed to check spool", 500, getErrorMessage(err));
  }
}

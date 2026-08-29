import { NextRequest, NextResponse } from "next/server";
import {
  findExactRawNameId,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
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

    // GH #950 / #867: a 24-hex param is an ObjectId and is AUTHORITATIVE —
    // try it FIRST, name lookup only when that _id misses (name-first let a
    // 24-hex preset name shadow another filament's real _id). `params.id`
    // is ALREADY URL-decoded — do NOT re-decode (a literal `%` throws
    // URIError, #671).
    const decodedName = id;
    let filament = /^[a-f0-9]{24}$/i.test(id)
      ? await Filament.findOne({ _id: id, _deletedAt: null }).lean()
      : null;
    if (!filament) {
      // name-lookup-ok: read-only; a miss is a 404
      // GH #1116: the EXACT stored spelling wins — the setter casts this
      // query, so with both "X" and "X " active a request addressed as
      // "X " would return the CANONICAL row's spool state.
      const exactId = await findExactRawNameId(
        Filament.collection as unknown as MinimalNameCollection,
        decodedName,
        { _deletedAt: null },
      );
      // name-lookup-ok: exact-spelling resolution above covers the cast case
      filament = await Filament.findOne(
        exactId
          ? { _id: exactId, _deletedAt: null }
          : { name: decodedName, _deletedAt: null },
      ).lean();
    }

    if (!filament) {
      return errorResponse(`Filament not found: ${decodedName}`, 404);
    }

    // GH #223: variants store `spoolWeight: null` and inherit from their
    // parent — reading the field directly hit the `spoolWeight == null`
    // guard and silently disabled PrusaSlicer's insufficient-filament
    // warning for every variant. Density and diameter inherit the same way
    // and are needed for the weight-to-length conversion, so resolve all
    // three in one parent fetch.
    let spoolWeight = filament.spoolWeight as number | null;
    let density = filament.density as number | null;
    let diameter = filament.diameter as number | null;

    // Spool source. A legacy single-weight variant (#273) stores its
    // capacity in `totalWeight` — excluded from variant inheritance — so
    // without a parent fallback the check hits the "no data" branch and
    // silently disables the slicer warning for every legacy-mode variant.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ownSpools: any[] = Array.isArray(filament.spools) ? filament.spools : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let spoolsSource: any[] = ownSpools;
    let legacyTotalWeight = filament.totalWeight as number | null;

    const needsParent =
      spoolWeight == null ||
      density == null ||
      diameter == null ||
      (ownSpools.length === 0 && legacyTotalWeight == null);
    if (filament.parentId && needsParent) {
      const parent = await Filament.findOne({
        _id: filament.parentId,
        _deletedAt: null,
      })
        .select("spoolWeight density diameter spools totalWeight")
        .lean();
      if (parent) {
        if (spoolWeight == null) spoolWeight = (parent.spoolWeight as number | null) ?? null;
        if (density == null) density = (parent.density as number | null) ?? null;
        if (diameter == null) diameter = (parent.diameter as number | null) ?? null;
        // Only borrow the parent's spool data when the variant has none
        // of its own — an explicit variant spool always wins.
        if (ownSpools.length === 0 && legacyTotalWeight == null) {
          if (Array.isArray(parent.spools) && parent.spools.length > 0) {
            spoolsSource = parent.spools;
          } else if (parent.totalWeight != null) {
            legacyTotalWeight = parent.totalWeight as number | null;
          }
        }
      }
    }

    // Collect all spools — multi-spool array takes priority, fall back to legacy single spool
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawSpools: any[] = [];
    if (spoolsSource.length > 0) {
      rawSpools.push(...spoolsSource);
    } else if (legacyTotalWeight != null) {
      // Legacy single-spool mode
      rawSpools.push({
        _id: "default",
        label: "Default",
        totalWeight: legacyTotalWeight,
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

    // GH #954: the "all measured stock is retired" warning does NOT need
    // the spool tare, so check it BEFORE the tare guard — otherwise a
    // filament with only retired weighed stock and a null tare would return
    // ok:true and suppress the warning. An active-but-UNWEIGHED spool
    // counts as active stock (just unmeasured) and falls through to the
    // "no data → ok:true" guard, not a false warning.
    const hasActiveSpool = rawSpools.some((s) => !s.retired);
    const hasRetiredWeightData = rawSpools.some(
      (s) => s.totalWeight != null && s.retired,
    );
    if (!hasActiveSpool && hasRetiredWeightData) {
      return NextResponse.json({
        ok: false,
        filament: filament.name,
        requiredWeightG: Math.round(requiredWeight * 10) / 10,
        requiredLengthM:
          requiredLengthM !== null ? Math.round(requiredLengthM * 100) / 100 : null,
        warning: "No active spools — all spools with weight data are retired",
        spools: [],
      });
    }

    // If no spools or no spool weight configured, we can't check — assume OK.
    // (An active-but-unweighed spool lands here too: active stock exists, just
    // unmeasured — keep the original no-data → ok:true behavior, no false warning.)
    if (rawSpools.length === 0 || spoolWeight == null) {
      return NextResponse.json({
        ok: true,
        filament: filament.name,
        message: "No spool weight data available — skipping check",
        spools: [],
      });
    }

    // Retired spools are intentionally out of service and must not satisfy
    // the check — otherwise a retired spool with enough weight would
    // suppress the slicer's warning while active stock is empty.
    const spoolResults = rawSpools
      .filter((s) => s.totalWeight != null && !s.retired)
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

    // Active spools exist but none carries a totalWeight (the all-retired case was
    // already handled before the tare guard above) → no measurable data → ok:true.
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

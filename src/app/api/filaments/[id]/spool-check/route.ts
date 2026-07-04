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

    // GH #950 / #867: a 24-hex param is an ObjectId and is AUTHORITATIVE — try
    // it FIRST, name lookup only when that _id misses (a preset legitimately
    // NAMED with 24 hex chars). Name-first let such a name shadow another
    // filament's real _id, so a slicer addressing this endpoint by id checked
    // the WRONG row's spool availability — inconsistent with the id-first
    // sync/export routes. `params.id` is ALREADY URL-decoded — do NOT re-decode
    // (a literal `%` like "ABS 100%" throws URIError and 500s the request, #671).
    const decodedName = id;
    let filament = /^[a-f0-9]{24}$/i.test(id)
      ? await Filament.findOne({ _id: id, _deletedAt: null }).lean()
      : null;
    if (!filament) {
      filament = await Filament.findOne({ name: decodedName, _deletedAt: null }).lean();
    }

    if (!filament) {
      return errorResponse(`Filament not found: ${decodedName}`, 404);
    }

    // GH #223: variants typically store `spoolWeight: null` and inherit
    // from their parent (see src/lib/resolveFilament.ts INHERITABLE_FIELDS).
    // Reading `filament.spoolWeight` directly meant the route hit the
    // `spoolWeight == null` guard below and returned "no data — skipping
    // check" for every color variant, silently disabling PrusaSlicer's
    // insufficient-filament warning. Same bug class as the v1.16 compare
    // route fix (PR #190): resolve the parent inline.
    //
    // Density and diameter use the same inheritance and are needed for the
    // weight-to-length conversion, so resolve them in the same parent
    // fetch.
    let spoolWeight = filament.spoolWeight as number | null;
    let density = filament.density as number | null;
    let diameter = filament.diameter as number | null;

    // Spool source for the check. A variant usually carries its own
    // spools array, but a legacy single-weight variant (#273) stores its
    // capacity in `totalWeight` — which is excluded from variant
    // inheritance — so its own value is typically null. Without a parent
    // fallback the check below hits the "no data" branch and silently
    // disables PrusaSlicer's insufficient-filament warning for every
    // legacy-mode variant.
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

    // GH #954 (Codex): the "all measured stock is retired" warning does NOT need
    // the spool tare (it's a pure retired-vs-active question), so check it BEFORE
    // the tare guard below — otherwise a filament with only retired weighed stock
    // and a null/inherited-missing spoolWeight would hit the `spoolWeight == null`
    // guard and return ok:true, silently suppressing PrusaSlicer's warning for
    // null-tare legacy data. An active spool that is merely UNWEIGHED counts as
    // active stock (just unmeasured), so `hasActiveSpool` keeps this from firing a
    // false warning — that case falls through to the "no data → ok:true" guard.
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

    // Check each spool. Retired spools are intentionally out of service
    // and must not satisfy the check (Codex review) — otherwise a
    // retired spool with enough weight (the variant's own, or one
    // borrowed from the parent via the #273 fallback) would suppress
    // the slicer's insufficient-filament warning while active stock is
    // empty. Retired spools drop out of spool-check per CLAUDE.md.
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

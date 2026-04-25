import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { IFilament } from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament, hasVariants } from "@/lib/resolveFilament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/filaments/{id}
 *
 * Returns a single filament with populated references. By default, if the
 * filament is a variant (has parentId) its inheritable fields are resolved
 * from its parent so the response is a complete view suitable for display.
 *
 * Pass `?raw=true` to skip inheritance resolution and receive the variant's
 * own values. Fields the variant does not override come back as `null`
 * (or empty). This is what the edit page needs — prefilling the form with
 * resolved values and then saving would copy the parent's fields onto the
 * variant and silently sever the inheritance link (GH #106).
 *
 * When `?raw=true` is passed on a parent, the response shape is unchanged
 * (parents don't inherit from anything).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const raw = request.nextUrl.searchParams.get("raw") === "true";

    const filament = await Filament.findOne({ _id: id, _deletedAt: null })
      .populate("compatibleNozzles")
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .populate("calibrations.bedType")
      .lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }

    // Resolve inheritance when displaying; skip when editing so the form
    // only sees the variant's own overrides.
    let resolved: IFilament | ReturnType<typeof resolveFilament> = filament;
    let parentDoc: IFilament | null = null;
    if (filament.parentId) {
      parentDoc = (await Filament.findOne({ _id: filament.parentId, _deletedAt: null })
        .populate("compatibleNozzles")
        .populate("calibrations.nozzle")
        .populate("calibrations.printer")
        .populate("calibrations.bedType")
        .lean()) as IFilament | null;
      if (!raw && parentDoc) {
        resolved = resolveFilament(filament, parentDoc);
      }
    }

    // If this is a parent, include its variants
    const variants = await Filament.find({ parentId: id, _deletedAt: null })
      .select("name color cost")
      .sort({ name: 1 })
      .lean();

    // In raw mode, attach the parent doc alongside so the edit UI can show
    // "inherited from parent" placeholders for any field the variant left
    // blank, without a second round-trip.
    if (raw && parentDoc) {
      return NextResponse.json({
        ...resolved,
        _variants: variants,
        _parent: parentDoc,
      });
    }

    return NextResponse.json({ ...resolved, _variants: variants });
  } catch (err) {
    return errorResponse("Failed to fetch filament", 500, getErrorMessage(err));
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  try {
    await dbConnect();
    const { id } = await params;
    delete body._id;
    delete body._deletedAt;
    delete body.createdAt;
    delete body.updatedAt;
    delete body.__v;
    delete body.instanceId;
    delete body.syncId;
    // Server-side response-only fields that clients may echo back (e.g. the
    // edit page fetches with ?raw=true and receives _parent / _variants /
    // _inherited). Strip so they don't become persisted document fields.
    delete body._parent;
    delete body._variants;
    delete body._inherited;

    // Validate parentId if provided
    if (body.parentId) {
      const parent = await Filament.findOne({ _id: body.parentId, _deletedAt: null }).lean();
      if (!parent) {
        return errorResponse("Parent filament not found", 400);
      }
      // Prevent circular references
      if (parent.parentId) {
        return errorResponse("Cannot set a variant as parent (no nested inheritance)", 400);
      }
      // Prevent self-reference
      if (body.parentId === id) {
        return errorResponse("Cannot be your own parent", 400);
      }
      // Prevent converting a parent to a variant while it has children
      const variantCount = await Filament.countDocuments({ parentId: id, _deletedAt: null });
      if (variantCount > 0) {
        return errorResponse("Cannot set parent on a filament that has variants — remove variants first", 400);
      }
    }

    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      body,
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(filament);
  } catch (err) {
    return errorResponse("Failed to update filament", 500, getErrorMessage(err));
  }
}

/**
 * POST /api/filaments/:nameOrId
 *
 * Sync a filament preset back from PrusaSlicer. The param can be a
 * URL-encoded preset name (e.g. "The%20K8%20PC") or a MongoDB ObjectId.
 *
 * Body: { name: string, config: Record<string, string> }
 *
 * Finds the filament by name (falling back to _id), then merges the
 * incoming config keys into the filament's `settings` bag.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  try {
    await dbConnect();
    const { id } = await params;
    const config: Record<string, string> = body.config || {};

    if (!config || Object.keys(config).length === 0) {
      return errorResponse("No config provided", 400);
    }

    // Try to find by name first (PrusaSlicer sends URL-encoded name),
    // then fall back to ObjectId
    const decodedName = decodeURIComponent(id);
    let filament = await Filament.findOne({ name: decodedName, _deletedAt: null });
    if (!filament && /^[a-f0-9]{24}$/i.test(id)) {
      filament = await Filament.findOne({ _id: id, _deletedAt: null });
    }

    if (!filament) {
      return errorResponse(`Filament not found: ${decodedName}`, 404);
    }

    // Reverse-map PrusaSlicer INI keys → structured DB fields
    const update: Record<string, unknown> = {};
    const temps: Record<string, unknown> = {};

    // Core fields
    if (config.filament_type) update.type = config.filament_type;
    if (config.filament_vendor) update.vendor = config.filament_vendor;
    if (config.filament_colour) update.color = config.filament_colour;
    if (config.filament_diameter) { const v = parseFloat(config.filament_diameter); if (!isNaN(v)) update.diameter = v; }
    if (config.filament_density) { const v = parseFloat(config.filament_density); if (!isNaN(v)) update.density = v; }
    if (config.filament_cost) { const v = parseFloat(config.filament_cost); if (!isNaN(v)) update.cost = v; }
    if (config.filament_spool_weight) { const v = parseFloat(config.filament_spool_weight); if (!isNaN(v)) update.spoolWeight = v; }
    if (config.filament_max_volumetric_speed) { const v = parseFloat(config.filament_max_volumetric_speed); if (!isNaN(v)) update.maxVolumetricSpeed = v; }

    // Temperatures
    if (config.temperature) { const v = parseInt(config.temperature); if (!isNaN(v)) temps.nozzle = v; }
    if (config.first_layer_temperature) { const v = parseInt(config.first_layer_temperature); if (!isNaN(v)) temps.nozzleFirstLayer = v; }
    if (config.bed_temperature) { const v = parseInt(config.bed_temperature); if (!isNaN(v)) temps.bed = v; }
    if (config.first_layer_bed_temperature) { const v = parseInt(config.first_layer_bed_temperature); if (!isNaN(v)) temps.bedFirstLayer = v; }

    // Shrinkage
    if (config.filament_shrinkage_compensation_xy) { const v = parseFloat(config.filament_shrinkage_compensation_xy); if (!isNaN(v)) update.shrinkageXY = v; }
    if (config.filament_shrinkage_compensation_z) { const v = parseFloat(config.filament_shrinkage_compensation_z); if (!isNaN(v)) update.shrinkageZ = v; }

    // Flags
    if (config.filament_soluble) update.soluble = config.filament_soluble === "1";
    if (config.filament_abrasive) update.abrasive = config.filament_abrasive === "1";

    // Merge temperatures into existing
    if (Object.keys(temps).length > 0) {
      const existing = (filament.temperatures as Record<string, unknown>) || {};
      update.temperatures = { ...existing, ...temps };
    }

    // Update per-nozzle calibration data when nozzle_diameter is provided.
    // PrusaSlicer passes ?nozzle_diameter=0.4&high_flow=0|1 so the API
    // knows which calibration entry to update with EM, PA, retraction, etc.
    // The high_flow flag disambiguates e.g. 0.4mm standard vs 0.4mm HF.
    const nozzleDiameterParam = request.nextUrl.searchParams.get("nozzle_diameter");
    const nozzleDiameter = nozzleDiameterParam ? parseFloat(nozzleDiameterParam) : NaN;
    if (!isNaN(nozzleDiameter) && nozzleDiameter > 0) {
      const calFields: Record<string, number | null> = {};
      if (config.extrusion_multiplier) {
        const v = parseFloat(config.extrusion_multiplier);
        if (!isNaN(v)) calFields.extrusionMultiplier = v;
      }
      if (config.pressure_advance_value || config.pressure_advance) {
        const raw = config.pressure_advance_value || config.pressure_advance;
        const v = parseFloat(raw);
        if (!isNaN(v)) calFields.pressureAdvance = v;
      }
      if (config.filament_retract_length) {
        const v = config.filament_retract_length === "nil" ? null : parseFloat(config.filament_retract_length);
        calFields.retractLength = v !== null && !isNaN(v) ? v : null;
      }
      if (config.filament_retract_speed) {
        const v = config.filament_retract_speed === "nil" ? null : parseFloat(config.filament_retract_speed);
        calFields.retractSpeed = v !== null && !isNaN(v) ? v : null;
      }
      if (config.filament_retract_lift) {
        const v = config.filament_retract_lift === "nil" ? null : parseFloat(config.filament_retract_lift);
        calFields.retractLift = v !== null && !isNaN(v) ? v : null;
      }

      if (Object.keys(calFields).length > 0) {
        // Find the nozzle by diameter (and optionally high_flow) among
        // this filament's compatible nozzles. The high_flow param
        // disambiguates e.g. 0.4mm Diamondback vs 0.4mm HF.
        const compatIds = (filament.compatibleNozzles || []).map((n: unknown) => String(n));
        if (compatIds.length > 0) {
          const highFlowParam = request.nextUrl.searchParams.get("high_flow");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nozzleQuery: Record<string, any> = {
            _id: { $in: compatIds },
            diameter: nozzleDiameter,
            _deletedAt: null,
          };
          // Only filter by highFlow when the param is explicitly provided
          if (highFlowParam !== null) {
            nozzleQuery.highFlow = highFlowParam === "1";
          }
          const matchingNozzle = await Nozzle.findOne(nozzleQuery).lean();

          if (matchingNozzle) {
            const nozzleId = String(matchingNozzle._id);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const calibrations = [...((filament.calibrations as any[]) || [])];
            const idx = calibrations.findIndex(
              (cal) => String(cal.nozzle) === nozzleId && !cal.printer,
            );
            if (idx >= 0) {
              // Update existing calibration entry
              Object.assign(calibrations[idx], calFields);
            } else {
              // Create new calibration entry for this nozzle
              calibrations.push({ nozzle: nozzleId, printer: null, ...calFields });
            }
            update.calibrations = calibrations;
          }
        }
      }
    }

    // Everything else goes into the settings bag
    const STRUCTURED_KEYS = new Set([
      "filament_type", "filament_vendor", "filament_colour", "filament_diameter",
      "filament_density", "filament_cost", "filament_spool_weight",
      "filament_max_volumetric_speed", "temperature", "first_layer_temperature",
      "bed_temperature", "first_layer_bed_temperature",
      "filament_shrinkage_compensation_xy", "filament_shrinkage_compensation_z",
      "filament_soluble", "filament_abrasive", "filament_settings_id",
    ]);
    const settings = (filament.settings as Record<string, unknown>) || {};
    for (const [key, value] of Object.entries(config)) {
      if (!STRUCTURED_KEYS.has(key)) {
        settings[key] = value;
      }
    }
    update.settings = settings;

    await Filament.findByIdAndUpdate(filament._id, { $set: update });

    return NextResponse.json({
      message: `Synced ${Object.keys(config).length} settings for "${decodedName}"`,
      filamentId: filament._id,
    });
  } catch (err) {
    return errorResponse("Failed to sync filament", 500, getErrorMessage(err));
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;

    // Prevent deleting a parent that has variants
    if (await hasVariants(Filament, id)) {
      return errorResponse(
        "Cannot delete a filament that has color variants. Delete the variants first.",
        400,
      );
    }

    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      { _deletedAt: new Date() },
      { returnDocument: "after" }
    ).lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponse("Failed to delete filament", 500, getErrorMessage(err));
  }
}

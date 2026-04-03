import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { IFilament } from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import { resolveFilament, hasVariants } from "@/lib/resolveFilament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const filament = await Filament.findOne({ _id: id, _deletedAt: null })
      .populate("compatibleNozzles")
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }

    // If this is a variant, resolve inherited values from parent
    let resolved: IFilament | ReturnType<typeof resolveFilament> = filament;
    if (filament.parentId) {
      const parent = await Filament.findOne({ _id: filament.parentId, _deletedAt: null })
        .populate("compatibleNozzles")
        .populate("calibrations.nozzle")
        .populate("calibrations.printer")
        .lean();
      resolved = resolveFilament(filament, parent);
    }

    // If this is a parent, include its variants
    const variants = await Filament.find({ parentId: id, _deletedAt: null })
      .select("name color cost")
      .sort({ name: 1 })
      .lean();

    return NextResponse.json({ ...resolved, _variants: variants });
  } catch (err) {
    return errorResponse("Failed to fetch filament", 500, getErrorMessage(err));
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const body = await request.json();

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
    }

    const filament = await Filament.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      body,
      { new: true, runValidators: true }
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
  try {
    await dbConnect();
    const { id } = await params;
    const body = await request.json();
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

    // Merge incoming config into the settings bag
    const settings = (filament.settings as Record<string, unknown>) || {};
    for (const [key, value] of Object.entries(config)) {
      settings[key] = value;
    }

    await Filament.findByIdAndUpdate(filament._id, { $set: { settings } });

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

    const filament = await Filament.findByIdAndUpdate(
      id,
      { _deletedAt: new Date() },
      { new: true }
    ).lean();
    if (!filament) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponse("Failed to delete filament", 500, getErrorMessage(err));
  }
}

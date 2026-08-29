import { NextRequest, NextResponse } from "next/server";
import {
  survivorNameConflict,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import dbConnect from "@/lib/mongodb";
import BedType from "@/models/BedType";
import Filament from "@/models/Filament";
import Printer from "@/models/Printer";
import { errorResponse, errorResponseFromCaught, handleDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import {
  bedTypeCalibrationRefFilter,
  bedTypePrinterRefFilter,
  bedTypeTempRefFilter,
} from "@/lib/entityDependents";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const bedType = await BedType.findOne({ _id: id, _deletedAt: null }).lean();
    if (!bedType) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(bedType);
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to fetch bed type");
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

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
    // GH #424: explicit allowlist so a future schema field isn't
    // automatically client-writable (e.g. an ownership flag).
    const update: Record<string, unknown> = {};
    if ("name" in body) update.name = body.name;
    if ("material" in body) update.material = body.material;
    if ("notes" in body) update.notes = body.notes;
    // GH #1116: a RENAME needs the same trimmed check as the create — the
    // index compares raw stored strings, so renaming onto a surviving
    // untrimmed spelling does not collide and leaves two rows rendering
    // identically. `id` excludes this row itself.
    const nameConflict = await survivorNameConflict(
      BedType.collection as unknown as MinimalNameCollection,
      (body as { name?: unknown }).name,
      id,
    );
    if (nameConflict) {
      return errorResponse(
        `A bed type with that name already exists: "${String((body as { name?: unknown }).name).trim()}"`,
        409,
      );
    }
    const bedType = await BedType.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      update,
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!bedType) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(bedType);
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "bed type");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to update bed type");
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
    const { id } = await params;

    // Load the target up front — its name is needed to match the free-text
    // `bedTypeTemps[].bedType` keys below.
    const bedType = await BedType.findOne({ _id: id, _deletedAt: null }).lean();
    if (!bedType) {
      return errorResponse("Not found", 404);
    }

    // Prevent deleting a bed type referenced by any filament calibration.
    // GH #629: trashed filaments count too (a restore would resurrect a
    // dangling ref); only `_purged` tombstones don't block. Predicate
    // shared with the dependents counter (src/lib/entityDependents.ts) —
    // the two must not drift.
    const referencingCount = await Filament.countDocuments(bedTypeCalibrationRefFilter(id));
    if (referencingCount > 0) {
      return errorResponse(
        `Cannot delete this bed type — it is referenced by ${referencingCount} filament${referencingCount !== 1 ? "s" : ""}, possibly including filaments in the trash. Remove it from those filaments (or permanently delete the trashed ones) first.`,
        400,
      );
    }

    // Prevent deleting a bed type installed on any printer (dangling refs
    // are silently dropped by populate's `_deletedAt: null` match). Keeps
    // the `_deletedAt: null` term (unlike the filament guards): printers
    // have no trash/restore loop, so a soft-deleted printer's refs can
    // never resurrect — counting them would block the delete with no way
    // for the user to clear the reference.
    const printerCount = await Printer.countDocuments(bedTypePrinterRefFilter(id));
    if (printerCount > 0) {
      return errorResponse(
        `Cannot delete this bed type — it is installed on ${printerCount} printer${printerCount !== 1 ? "s" : ""}. Remove it from those printers first.`,
        400,
      );
    }

    // GH #557: filaments also name a bed surface by NAME via the free-text
    // `bedTypeTemps[].bedType` key — deliberately NOT a BedType ObjectId
    // ref (see src/models/Filament.ts). Deleting a catalog bed type whose
    // name a per-surface temperature table still uses would silently remove
    // a selectable surface existing data depends on. GH #629: trashed
    // filaments count here too; `_purged` tombstones don't.
    const bedTempCount = await Filament.countDocuments(bedTypeTempRefFilter(bedType.name));
    if (bedTempCount > 0) {
      return errorResponse(
        `Cannot delete this bed type — ${bedTempCount} filament${bedTempCount !== 1 ? "s" : ""} (possibly including filaments in the trash) reference${bedTempCount === 1 ? "s" : ""} "${bedType.name}" in per-bed-type temperatures. Remove it from those filaments first.`,
        400,
      );
    }

    const deleted = await BedType.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      { _deletedAt: new Date() },
      { returnDocument: "after" }
    ).lean();
    if (!deleted) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to delete bed type");
  }
}

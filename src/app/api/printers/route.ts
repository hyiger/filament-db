import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Printer from "@/models/Printer";
import Filament from "@/models/Filament";
import { findNozzleConflicts } from "@/lib/nozzleConflicts";
import { clearSpoolsFromOtherPrinters, findInvalidSlotSpoolRef } from "@/lib/spoolSlots";
import Nozzle from "@/models/Nozzle";
import BedType from "@/models/BedType";
import { getErrorMessage, errorResponse, errorResponseFromCaught, handleDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

export async function GET(request: NextRequest) {
  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const manufacturer = searchParams.get("manufacturer");

    const filter: Record<string, unknown> = { _deletedAt: null };
    if (manufacturer) filter.manufacturer = manufacturer;

    const printers = await Printer.find(filter)
      .sort({ manufacturer: 1, name: 1 })
      .populate({ path: "installedNozzles", match: { _deletedAt: null } })
      .populate({ path: "installedBedTypes", match: { _deletedAt: null } })
      .lean();
    return NextResponse.json(printers);
  } catch (err) {
    return errorResponse("Failed to fetch printers", 500, getErrorMessage(err));
  }
}

export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
  } catch (err) {
    return errorResponse("Database connection failed", 500, getErrorMessage(err));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  delete body._id;
  delete body._deletedAt;
  delete body.createdAt;
  delete body.updatedAt;
  delete body.__v;
  delete body.instanceId;
  delete body.syncId;

  // GH #524.4: dedupe ref arrays at entry so a body with the same valid id
  // twice doesn't trip the `activeCount !== body.installedNozzles.length`
  // comparison and 400 with the misleading "no longer exist." message.
  if (Array.isArray(body.installedNozzles)) {
    body.installedNozzles = Array.from(new Set(body.installedNozzles.map(String)));
  }
  if (Array.isArray(body.installedBedTypes)) {
    body.installedBedTypes = Array.from(new Set(body.installedBedTypes.map(String)));
  }

  try {
    // Validate that all referenced nozzle IDs exist and are active
    if (body.installedNozzles?.length > 0) {
      const activeCount = await Nozzle.countDocuments({
        _id: { $in: body.installedNozzles },
        _deletedAt: null,
      });
      if (activeCount !== body.installedNozzles.length) {
        return errorResponse("One or more selected nozzles no longer exist.", 400);
      }

      // GH #232 — parallel of the PUT check. No printer id to exclude
      // (this is a create), so any other-printer claim is a conflict.
      const conflicts = await findNozzleConflicts(
        Printer,
        Nozzle,
        body.installedNozzles,
        null,
      );
      if (conflicts.length > 0) {
        return NextResponse.json(
          {
            error: "Nozzle is already installed in another printer",
            conflicts,
          },
          { status: 409 },
        );
      }
    }

    // Validate that all referenced bed-type IDs exist and are active.
    // Unlike nozzles, bed types are a shared catalog — a surface like
    // "Textured PEI" can be on many printers at once — so there is no
    // conflict check, only an existence check.
    if (body.installedBedTypes?.length > 0) {
      const activeBedCount = await BedType.countDocuments({
        _id: { $in: body.installedBedTypes },
        _deletedAt: null,
      });
      if (activeBedCount !== body.installedBedTypes.length) {
        return errorResponse("One or more selected bed types no longer exist.", 400);
      }
    }

    // GH #631: amsSlots[].spoolId was written verbatim, bypassing the
    // checks the dedicated assignment route enforces (spool must exist on
    // an active filament; retired spools are out of inventory and not
    // loadable). Validate each non-null slot ref before the create.
    const slotError = await findInvalidSlotSpoolRef(Filament, body.amsSlots);
    if (slotError) {
      return errorResponse(slotError, 400);
    }

    const printer = await Printer.create(body);

    // GH #242 — see printers/[id] PUT. Clear any spools this new printer
    // claims out of every other printer's slots.
    const claimedSpoolIds = printer.amsSlots
      .map((s) => s.spoolId)
      .filter((x): x is NonNullable<typeof x> => x != null);
    if (claimedSpoolIds.length > 0) {
      await clearSpoolsFromOtherPrinters(Printer, claimedSpoolIds, String(printer._id));
    }

    return NextResponse.json(printer, { status: 201 });
  } catch (err: unknown) {
    const dupResponse = handleDuplicateKeyError(err, "printer");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to create printer");
  }
}

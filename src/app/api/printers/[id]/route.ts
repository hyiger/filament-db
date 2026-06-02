import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Printer from "@/models/Printer";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import { errorResponse, errorResponseFromCaught, handleDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { findNozzleConflicts } from "@/lib/nozzleConflicts";
import { clearSpoolsFromOtherPrinters } from "@/lib/spoolSlots";
import BedType from "@/models/BedType";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const printer = await Printer.findOne({ _id: id, _deletedAt: null })
      .populate({ path: "installedNozzles", match: { _deletedAt: null } })
      .populate({ path: "installedBedTypes", match: { _deletedAt: null } })
      .lean();
    if (!printer) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json(printer);
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to fetch printer");
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
    delete body._id;
    delete body._deletedAt;
    delete body.createdAt;
    delete body.updatedAt;
    delete body.__v;
    delete body.instanceId;
    delete body.syncId;

    // GH #524.4: see parallel comment in POST handler.
    if (Array.isArray(body.installedNozzles)) {
      body.installedNozzles = Array.from(new Set(body.installedNozzles.map(String)));
    }
    if (Array.isArray(body.installedBedTypes)) {
      body.installedBedTypes = Array.from(new Set(body.installedBedTypes.map(String)));
    }

    // Validate that all referenced nozzle IDs exist and are active
    if (body.installedNozzles?.length > 0) {
      const activeCount = await Nozzle.countDocuments({
        _id: { $in: body.installedNozzles },
        _deletedAt: null,
      });
      if (activeCount !== body.installedNozzles.length) {
        return errorResponse("One or more selected nozzles no longer exist.", 400);
      }

      // GH #232 — a physical nozzle can only live in one printer at a
      // time. Reject the request with a structured 409 listing the
      // conflicting nozzles + the printer that currently claims each
      // one. The client (PrinterForm) reads the `conflicts[]` payload to
      // offer a Move / Clone / Cancel prompt rather than just showing
      // a raw error. See src/lib/nozzleConflicts.ts for the rationale
      // on keeping resolution client-side instead of adding a `force`
      // flag here.
      const conflicts = await findNozzleConflicts(
        Printer,
        Nozzle,
        body.installedNozzles,
        id,
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

    // Validate bed-type refs. Bed types are a shared catalog (a surface
    // spec can be on many printers) so this is an existence check only —
    // no conflict detection, unlike the nozzle block above.
    if (body.installedBedTypes?.length > 0) {
      const activeBedCount = await BedType.countDocuments({
        _id: { $in: body.installedBedTypes },
        _deletedAt: null,
      });
      if (activeBedCount !== body.installedBedTypes.length) {
        return errorResponse("One or more selected bed types no longer exist.", 400);
      }
    }

    // GH #424: explicit allowlist so a future schema field doesn't
    // silently become client-writable. Matches the Filament PUT
    // pattern.
    const update: Record<string, unknown> = {};
    if ("name" in body) update.name = body.name;
    if ("manufacturer" in body) update.manufacturer = body.manufacturer;
    if ("printerModel" in body) update.printerModel = body.printerModel;
    if ("installedNozzles" in body) update.installedNozzles = body.installedNozzles;
    if ("installedBedTypes" in body) update.installedBedTypes = body.installedBedTypes;
    if ("notes" in body) update.notes = body.notes;
    if ("buildVolume" in body) update.buildVolume = body.buildVolume;
    if ("maxFlow" in body) update.maxFlow = body.maxFlow;
    if ("maxSpeed" in body) update.maxSpeed = body.maxSpeed;
    if ("enclosed" in body) update.enclosed = body.enclosed;
    if ("autoBedLevel" in body) update.autoBedLevel = body.autoBedLevel;
    if ("amsSlots" in body) update.amsSlots = body.amsSlots;

    const printer = await Printer.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      update,
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!printer) {
      return errorResponse("Not found", 404);
    }

    // GH #242 — a spool is one physical object. If this printer now claims
    // spools in its slots, clear those spools out of every other printer
    // so the one-slot-per-spool invariant holds regardless of which form
    // wrote the assignment.
    const claimedSpoolIds = (printer.amsSlots ?? [])
      .map((s) => s.spoolId)
      .filter((x): x is NonNullable<typeof x> => x != null);
    if (claimedSpoolIds.length > 0) {
      await clearSpoolsFromOtherPrinters(Printer, claimedSpoolIds, id);
    }

    return NextResponse.json(printer);
  } catch (err) {
    const dupResponse = handleDuplicateKeyError(err, "printer");
    if (dupResponse) return dupResponse;
    return errorResponseFromCaught(err, "Failed to update printer");
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

    // Prevent deleting a printer referenced by filament calibrations
    const referencingCount = await Filament.countDocuments({
      _deletedAt: null,
      "calibrations.printer": id,
    });
    if (referencingCount > 0) {
      return errorResponse(
        `Cannot delete this printer — it is referenced by ${referencingCount} filament${referencingCount !== 1 ? "s" : ""}. Remove its calibrations from those filaments first.`,
        400,
      );
    }

    const printer = await Printer.findOneAndUpdate(
      { _id: id, _deletedAt: null },
      { _deletedAt: new Date() },
      { returnDocument: "after" }
    ).lean();
    if (!printer) {
      return errorResponse("Not found", 404);
    }
    return NextResponse.json({ message: "Deleted" });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to delete printer");
  }
}

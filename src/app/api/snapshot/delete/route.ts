import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";
import BedType from "@/models/BedType";
import Location from "@/models/Location";
import PrintHistory from "@/models/PrintHistory";
import SharedCatalog from "@/models/SharedCatalog";

/**
 * DELETE /api/snapshot/delete — Permanently delete all data from all collections.
 *
 * Every user-facing collection must be listed here. A missed collection means
 * a "reset" still surfaces stale data in the dashboard / analytics and can
 * leave published share links active after what the user asked to be a wipe.
 */
export async function DELETE() {
  try {
    await dbConnect();

    const [
      filaments,
      nozzles,
      printers,
      bedTypes,
      locations,
      printHistory,
      sharedCatalogs,
    ] = await Promise.all([
      Filament.deleteMany({}),
      Nozzle.deleteMany({}),
      Printer.deleteMany({}),
      BedType.deleteMany({}),
      Location.deleteMany({}),
      PrintHistory.deleteMany({}),
      SharedCatalog.deleteMany({}),
    ]);

    return NextResponse.json({
      message: "Database cleared",
      deleted: {
        filaments: filaments.deletedCount,
        nozzles: nozzles.deletedCount,
        printers: printers.deletedCount,
        bedTypes: bedTypes.deletedCount,
        locations: locations.deletedCount,
        printHistory: printHistory.deletedCount,
        sharedCatalogs: sharedCatalogs.deletedCount,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to clear database", detail: message }, { status: 500 });
  }
}

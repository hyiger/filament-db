import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import Printer from "@/models/Printer";

/**
 * DELETE /api/snapshot/delete — Permanently delete all data from all collections.
 */
export async function DELETE() {
  await dbConnect();

  const [filaments, nozzles, printers] = await Promise.all([
    Filament.deleteMany({}),
    Nozzle.deleteMany({}),
    Printer.deleteMany({}),
  ]);

  return NextResponse.json({
    message: "Database cleared",
    deleted: {
      filaments: filaments.deletedCount,
      nozzles: nozzles.deletedCount,
      printers: printers.deletedCount,
    },
  });
}

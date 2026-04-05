import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { parseIniFilaments } from "@/lib/parseIni";
import { checkFileSize } from "@/lib/apiErrorHandler";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const sizeError = checkFileSize(file);
    if (sizeError) return sizeError;

    const content = await file.text();
    const filaments = parseIniFilaments(content);

    if (filaments.length === 0) {
      return NextResponse.json(
        { error: "No filament profiles found in the INI file" },
        { status: 400 }
      );
    }

    await dbConnect();

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const filament of filaments) {
      try {
        const existing = await Filament.findOne({ name: filament.name, _deletedAt: null });
        if (existing) {
          await Filament.updateOne({ _id: existing._id }, filament);
          updated++;
        } else {
          // If a soft-deleted doc with the same name exists, resurrect it
          const softDeleted = await Filament.findOne({ name: filament.name, _deletedAt: { $ne: null } });
          if (softDeleted) {
            await Filament.updateOne({ _id: softDeleted._id }, { ...filament, _deletedAt: null });
            updated++;
          } else {
            await Filament.create(filament);
            created++;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${filament.name}: ${msg}`);
      }
    }

    const result: Record<string, unknown> = {
      message: `Imported ${created + updated} filaments (${created} new, ${updated} updated)`,
      total: created + updated,
      created,
      updated,
    };
    if (errors.length > 0) {
      result.errors = errors;
      result.message = `${result.message}. ${errors.length} error(s).`;
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to import filaments", detail: message },
      { status: 500 },
    );
  }
}

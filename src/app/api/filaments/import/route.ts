import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { parseIniFilaments } from "@/lib/parseIni";
import { assertMultipartFormData, checkFileSize, isDuplicateKeyError } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // GH #338: bad content-type is client input, not a server fault — 400 + clear message.
  const ctError = assertMultipartFormData(request);
  if (ctError) return ctError;
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

    // GH #297: cap the bundle size — mirrors parseCsv's 10k maxRows.
    // A huge bundle would otherwise drive unbounded sequential writes.
    const MAX_IMPORT_FILAMENTS = 10_000;
    if (filaments.length > MAX_IMPORT_FILAMENTS) {
      return NextResponse.json(
        {
          error: `Import too large: ${filaments.length} profiles exceeds the ${MAX_IMPORT_FILAMENTS} limit.`,
        },
        { status: 400 },
      );
    }

    await dbConnect();

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const filament of filaments) {
      try {
        const { name, ...rest } = filament;

        // GH #327 (Codex): each branch is a single atomic operation so
        // there is no findOne→write window for a concurrent soft-delete
        // or insert to slip through. `runValidators` keeps the update
        // path enforcing the same schema constraints as a create (#308).

        // 1) Update an existing ACTIVE filament with this name.
        const activeUpdated = await Filament.findOneAndUpdate(
          { name, _deletedAt: null },
          { $set: rest },
          { runValidators: true, context: "query", returnDocument: "after" },
        );
        if (activeUpdated) {
          updated++;
          continue;
        }

        // 2) GH #297: if a TRASHED (non-purged) filament owns this name,
        // resurrect-and-update it rather than creating a second active
        // row — a duplicate would strand the trashed one (its restore
        // would 409 on the name conflict forever).
        const trashedResurrected = await Filament.findOneAndUpdate(
          { name, _deletedAt: { $ne: null }, _purged: { $ne: true } },
          { $set: { ...rest, _deletedAt: null } },
          { runValidators: true, context: "query", returnDocument: "after" },
        );
        if (trashedResurrected) {
          updated++;
          continue;
        }

        // 3) No active or trashed row — create. A concurrent import of
        // the same new name can still race two requests into create();
        // the partial-unique index throws E11000 for the loser. Treat
        // that as "another request just created it" and resolve it as
        // an update, so identical parallel imports stay idempotent.
        try {
          await Filament.create({ name, ...rest });
          created++;
        } catch (createErr) {
          if (!isDuplicateKeyError(createErr)) throw createErr;
          const raced = await Filament.findOneAndUpdate(
            { name, _deletedAt: null },
            { $set: rest },
            { runValidators: true, context: "query", returnDocument: "after" },
          );
          if (!raced) throw createErr;
          updated++;
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

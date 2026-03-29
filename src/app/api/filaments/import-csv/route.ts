import { NextRequest, NextResponse } from "next/server";
import { mapHeaders, rowToImport, upsertImportRows } from "@/lib/importFilaments";

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const content = await file.text();
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");

  if (lines.length < 2) {
    return NextResponse.json(
      { error: "CSV file must have a header row and at least one data row" },
      { status: 400 },
    );
  }

  const headers = parseCsvLine(lines[0]);
  const mapping = mapHeaders(headers);

  // Verify required columns exist
  const mappedKeys = mapping.filter(Boolean);
  if (!mappedKeys.includes("name") || !mappedKeys.includes("vendor") || !mappedKeys.includes("type")) {
    return NextResponse.json(
      { error: "CSV must include Name, Vendor, and Type columns" },
      { status: 400 },
    );
  }

  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return rowToImport(values, mapping);
  });

  const result = await upsertImportRows(rows);

  return NextResponse.json({
    message: `Imported ${result.total} filaments (${result.created} new, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ""})`,
    ...result,
  });
}

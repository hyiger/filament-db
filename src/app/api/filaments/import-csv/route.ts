import { NextRequest, NextResponse } from "next/server";
import { mapHeaders, rowToImport, upsertImportRows } from "@/lib/importFilaments";
import { assertMultipartFormData, getErrorMessage, errorResponse, checkFileSize } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

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
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // GH #338: bad content-type is client input, not a server fault — 400 + clear message.
  const ctError = assertMultipartFormData(request);
  if (ctError) return ctError;
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return errorResponse("No file provided", 400);
    }

    // Validate file size (max 10 MB)
    const sizeError = checkFileSize(file);
    if (sizeError) return sizeError;

    // GH #309: strip a leading UTF-8 BOM (U+FEFF). Excel-saved CSVs —
    // and the app's own xlsx exports — begin with a BOM; left in place
    // it becomes part of the first header cell, fails HEADER_MAP, and
    // the required-column check rejects an otherwise-valid file.
    const content = (await file.text()).replace(/^\uFEFF/, "");
    const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");

    if (lines.length < 2) {
      return errorResponse(
        "CSV file must have a header row and at least one data row",
        400,
      );
    }

    const headers = parseCsvLine(lines[0]);
    const mapping = mapHeaders(headers);

    // Verify required columns exist
    const mappedKeys = mapping.filter(Boolean);
    if (!mappedKeys.includes("name") || !mappedKeys.includes("vendor") || !mappedKeys.includes("type")) {
      return errorResponse("CSV must include Name, Vendor, and Type columns", 400);
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
  } catch (err) {
    return errorResponse("Failed to import CSV", 500, getErrorMessage(err));
  }
}

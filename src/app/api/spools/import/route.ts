import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Location from "@/models/Location";
import { parseCsv } from "@/lib/parseCsv";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * POST /api/spools/import — bulk-create spools from CSV.
 *
 * Accepts either:
 *   - Content-Type: text/csv with the CSV as the raw request body
 *   - Content-Type: application/json with { csv: string }
 *
 * Required columns (case-sensitive):
 *   filament   — matched to Filament.name; vendor can disambiguate
 *   totalWeight — grams (number)
 *
 * Optional columns:
 *   vendor, label, lotNumber, purchaseDate (ISO date), openedDate,
 *   location (name — will create the Location if it doesn't exist)
 *
 * Returns a per-row result so the client can show granular success/failure.
 * Does not transactionally roll back on partial failure — this is a user
 * bulk-paste, not a critical path.
 */
export async function POST(request: NextRequest) {
  let csvText: string;

  const contentType = request.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      const body = await request.json();
      if (typeof body?.csv !== "string") {
        return errorResponse("Body must be { csv: string } for JSON requests", 400);
      }
      csvText = body.csv;
    } else {
      csvText = await request.text();
    }
  } catch {
    return errorResponse("Failed to read request body", 400);
  }

  // Strip BOM if present
  if (csvText.charCodeAt(0) === 0xfeff) {
    csvText = csvText.slice(1);
  }

  if (!csvText.trim()) {
    return errorResponse("CSV body is empty", 400);
  }

  let rows: Array<Record<string, string>>;
  try {
    rows = parseCsv(csvText, { header: true }) as Array<Record<string, string>>;
  } catch (err) {
    return errorResponse("Failed to parse CSV", 400, getErrorMessage(err));
  }

  if (rows.length === 0) {
    return errorResponse("No data rows found in CSV", 400);
  }

  const required = ["filament", "totalWeight"];
  const firstRow = rows[0];
  for (const col of required) {
    if (!(col in firstRow)) {
      return errorResponse(`CSV is missing required column: ${col}`, 400);
    }
  }

  try {
    await dbConnect();

    // Cache location lookups so a 50-row paste with 3 distinct locations
    // only hits the collection 3 times.
    const locationCache = new Map<string, string>();
    async function resolveLocationId(name: string): Promise<string | null> {
      if (!name) return null;
      if (locationCache.has(name)) return locationCache.get(name)!;
      let loc = await Location.findOne({ name, _deletedAt: null });
      if (!loc) {
        loc = await Location.create({ name });
      }
      const id = String(loc._id);
      locationCache.set(name, id);
      return id;
    }

    const results: Array<{
      row: number;
      ok: boolean;
      error?: string;
      filament?: string;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const filamentName = (r.filament || "").trim();
      const vendor = (r.vendor || "").trim();
      const weightStr = (r.totalWeight || "").trim();

      if (!filamentName) {
        results.push({ row: i + 2, ok: false, error: "filament is required" });
        continue;
      }

      const weight = Number(weightStr);
      if (!Number.isFinite(weight) || weight < 0) {
        results.push({ row: i + 2, ok: false, error: "totalWeight must be a non-negative number" });
        continue;
      }

      // Disambiguate by vendor if provided, otherwise match by name alone.
      const query: Record<string, unknown> = { name: filamentName, _deletedAt: null };
      if (vendor) query.vendor = vendor;

      const filament = await Filament.findOne(query);
      if (!filament) {
        results.push({
          row: i + 2,
          ok: false,
          error: vendor
            ? `No filament named "${filamentName}" from vendor "${vendor}"`
            : `No filament named "${filamentName}"`,
        });
        continue;
      }

      const locationId = await resolveLocationId((r.location || "").trim());

      const purchaseDate = r.purchaseDate ? new Date(r.purchaseDate) : null;
      const openedDate = r.openedDate ? new Date(r.openedDate) : null;

      // Mongoose's subdocument type doesn't include our added fields until
      // the outer Filament schema is re-inferred — cast to unknown first
      // to avoid the direct `any` eslint rule while still satisfying the
      // push signature.
      filament.spools.push({
        label: r.label || "",
        totalWeight: weight,
        lotNumber: r.lotNumber || null,
        purchaseDate: purchaseDate && !isNaN(+purchaseDate) ? purchaseDate : null,
        openedDate: openedDate && !isNaN(+openedDate) ? openedDate : null,
        locationId: locationId || null,
      } as unknown as Parameters<typeof filament.spools.push>[0]);
      await filament.save();
      results.push({ row: i + 2, ok: true, filament: filament.name });
    }

    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    return NextResponse.json({ imported: ok, failed, results });
  } catch (err) {
    return errorResponse("Failed to import spools", 500, getErrorMessage(err));
  }
}

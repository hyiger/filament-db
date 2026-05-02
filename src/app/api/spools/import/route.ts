import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Location from "@/models/Location";
import { parseCsv } from "@/lib/parseCsv";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { unsanitizeCsvCell } from "@/lib/csvWriter";

/**
 * POST /api/spools/import — bulk-create OR upsert spools from CSV.
 *
 * Accepts either:
 *   - Content-Type: text/csv with the CSV as the raw request body
 *   - Content-Type: application/json with { csv: string }
 *
 * Required columns (case-sensitive):
 *   filament   — matched to Filament.name; vendor can disambiguate
 *   totalWeight — grams (number). An empty cell maps to null (the spool
 *     schema's "weight unknown" state), so a CSV produced by
 *     `/api/spools/export-csv` round-trips for spools created via
 *     `POST /api/filaments/[id]/spools` (which default totalWeight to null).
 *     Codex P2 on PR #141.
 *
 * Optional columns:
 *   vendor, label, lotNumber, purchaseDate (ISO date), openedDate,
 *   location (name — will create the Location if it doesn't exist),
 *   spoolId — when present and the matching filament already has a spool
 *     with that subdoc _id, the existing spool's mutable fields are
 *     updated instead of appending a new one. This makes the export →
 *     re-import round-trip idempotent (GH #159 — pre-fix re-importing
 *     an export silently doubled inventory).
 *
 * Returns a per-row result tagged `created | updated` so the client can
 * show granular success/failure. Does not transactionally roll back on
 * partial failure — this is a user bulk-paste, not a critical path.
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
      action?: "created" | "updated";
      error?: string;
      filament?: string;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // Strip the formula guard apostrophe (`csvCell` adds `'` in front
      // of cells starting with =, +, -, @, tab, CR) so a row exported
      // by `/api/spools/export-csv` round-trips cleanly. Codex P2
      // follow-up to PR #144.
      const filamentName = unsanitizeCsvCell((r.filament || "").trim());
      const vendor = unsanitizeCsvCell((r.vendor || "").trim());
      const weightStr = (r.totalWeight || "").trim();

      if (!filamentName) {
        results.push({ row: i + 2, ok: false, error: "filament is required" });
        continue;
      }

      // Empty cell → preserve null. Importer used to coerce "" → 0 because
      // Number("") === 0, which broke round-trip parity with the export
      // (Codex P2 on PR #141: a spool created with totalWeight=null and
      // re-imported from its own export would land as 0g). A populated cell
      // still has to be a non-negative finite number.
      let weight: number | null;
      if (weightStr === "") {
        weight = null;
      } else {
        const w = Number(weightStr);
        if (!Number.isFinite(w) || w < 0) {
          results.push({
            row: i + 2,
            ok: false,
            error: "totalWeight must be a non-negative number",
          });
          continue;
        }
        weight = w;
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

      const locationId = await resolveLocationId(
        unsanitizeCsvCell((r.location || "").trim()),
      );

      const purchaseDate = r.purchaseDate ? new Date(r.purchaseDate) : null;
      const openedDate = r.openedDate ? new Date(r.openedDate) : null;

      // Build the field set for a NEW spool — defaults fill in for any
      // optional column the user didn't include.
      const newSpoolFields = {
        label: unsanitizeCsvCell(r.label || ""),
        totalWeight: weight,
        lotNumber: r.lotNumber ? unsanitizeCsvCell(r.lotNumber) : null,
        purchaseDate: purchaseDate && !isNaN(+purchaseDate) ? purchaseDate : null,
        openedDate: openedDate && !isNaN(+openedDate) ? openedDate : null,
        locationId: locationId || null,
      };

      // Round-trip dedup: when the CSV row carries a `spoolId` and the
      // matching filament already has a spool with that subdoc _id,
      // update the existing entry instead of appending a duplicate.
      // Without this, exporting and re-importing the same CSV silently
      // doubles the library's spool count (GH #159).
      //
      // For the UPDATE path, only assign the columns that were actually
      // present in the CSV header — missing columns must leave existing
      // metadata untouched. Otherwise a partial-column re-import (e.g.
      // `filament,totalWeight,spoolId` to bulk-update weights) would
      // silently null label / lotNumber / dates / location on every
      // matched spool. Codex P1 on PR #172.
      const incomingSpoolId = (r.spoolId || "").trim();
      let action: "created" | "updated" = "created";
      if (incomingSpoolId) {
        // .id() returns the matching subdoc or null. Cast through unknown
        // because the inferred subdoc type doesn't expose our extended
        // fields, the same workaround the push path below uses.
        const existing = (filament.spools as unknown as { id(id: string): Record<string, unknown> | null }).id(incomingSpoolId);
        if (existing) {
          // totalWeight is required so it always counts as "present" — its
          // empty-cell-means-null semantics are still honoured by `weight`.
          const partialUpdate: Record<string, unknown> = { totalWeight: weight };
          if ("label" in r) partialUpdate.label = unsanitizeCsvCell(r.label || "");
          if ("lotNumber" in r) partialUpdate.lotNumber = r.lotNumber ? unsanitizeCsvCell(r.lotNumber) : null;
          if ("purchaseDate" in r) {
            partialUpdate.purchaseDate = purchaseDate && !isNaN(+purchaseDate) ? purchaseDate : null;
          }
          if ("openedDate" in r) {
            partialUpdate.openedDate = openedDate && !isNaN(+openedDate) ? openedDate : null;
          }
          if ("location" in r) partialUpdate.locationId = locationId || null;
          Object.assign(existing, partialUpdate);
          action = "updated";
        }
      }
      if (action === "created") {
        // Mongoose's subdocument type doesn't include our added fields until
        // the outer Filament schema is re-inferred — cast to unknown first
        // to avoid the direct `any` eslint rule while still satisfying the
        // push signature.
        filament.spools.push(newSpoolFields as unknown as Parameters<typeof filament.spools.push>[0]);
      }
      await filament.save();
      results.push({ row: i + 2, ok: true, action, filament: filament.name });
    }

    const ok = results.filter((r) => r.ok).length;
    const created = results.filter((r) => r.ok && r.action === "created").length;
    const updated = results.filter((r) => r.ok && r.action === "updated").length;
    const failed = results.length - ok;
    // `imported` is preserved for backwards compatibility with any client
    // that already reads it; `created`/`updated` are the new breakdown so
    // a re-import can be reported as "updated 6" rather than misleadingly
    // "imported 6" (which would imply doubling).
    return NextResponse.json({ imported: ok, created, updated, failed, results });
  } catch (err) {
    return errorResponse("Failed to import spools", 500, getErrorMessage(err));
  }
}

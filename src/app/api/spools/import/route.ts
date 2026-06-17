import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { generateInstanceId, isSpoolInstanceIdTaken } from "@/models/Filament";
import Location from "@/models/Location";
import { parseCsv } from "@/lib/parseCsv";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { unsanitizeCsvCell } from "@/lib/csvWriter";
import { isValidIsoDateString, validateSpoolInstanceId } from "@/lib/validateSpoolBody";

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
 *   instanceId — the spool's own id (#732 Phase 5). Validated for
 *     charset/length and checked for uniqueness (against other spools'
 *     ids, other filaments' top-level ids, AND other rows in this same
 *     CSV). On CREATE it's stamped on the new spool (auto-generated when
 *     absent); on UPDATE a non-empty cell rewrites the matched spool's id
 *     (an empty cell leaves it unchanged). A duplicate or malformed id
 *     fails just that row, side-effect-free.
 *
 * Returns a per-row result tagged `created | updated` so the client can
 * show granular success/failure. Does not transactionally roll back on
 * partial failure — this is a user bulk-paste, not a critical path.
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  let csvText: string;

  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  try {
    if (contentType.includes("application/json")) {
      const body = await request.json();
      if (typeof body?.csv !== "string") {
        return errorResponse("Body must be { csv: string } for JSON requests", 400);
      }
      csvText = body.csv;
    } else if (contentType.includes("multipart/form-data")) {
      // GH #339: the in-app importer (SpoolCsvImportDialog) reads the file
      // client-side and POSTs it as raw text/csv, but every other import
      // route in the app takes a multipart upload. Without this branch a
      // `-F "file=@..."` curl call would land in the raw-text fallback
      // below, parse the MIME envelope as CSV, and 400 with the misleading
      // "CSV is missing required column: filament".
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return errorResponse("multipart upload must include a 'file' field", 400);
      }
      csvText = await file.text();
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

    type RowResult = {
      row: number;
      ok: boolean;
      action?: "created" | "updated";
      error?: string;
      filament?: string;
    };

    // GH #525.1: cache filament lookups by `name|vendor` so a 50-row paste
    // of the same material hits the collection once, not 50 times — same
    // pattern locationCache already uses above. `null` is a cached
    // negative (filament not found) so repeated missing-filament rows
    // don't re-query.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filamentCache = new Map<string, any | null>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function resolveFilament(name: string, vendor: string): Promise<any | null> {
      // JSON-encode the (name, vendor) pair for a collision-free cache key.
      // Both are arbitrary user strings, so no single-character delimiter is
      // safe. An earlier version used a raw separator that also smuggled a
      // literal NUL byte into this source file, making git treat the route as
      // binary (Codex P2 on PR #546).
      const key = JSON.stringify([name, vendor]);
      if (filamentCache.has(key)) return filamentCache.get(key)!;
      const query: Record<string, unknown> = { name, _deletedAt: null };
      if (vendor) query.vendor = vendor;
      const doc = await Filament.findOne(query);
      filamentCache.set(key, doc);
      return doc;
    }

    // Defer save() to once-per-filament after ALL its rows are applied to
    // the in-memory doc — instead of save()-ing per row, which for N rows
    // of one filament was N hydrate+save round-trips against (possibly
    // remote) Atlas. `rowResults` is index-keyed so the per-row order is
    // preserved even though saves finalize their rows after the loop.
    const rowResults: Array<RowResult | null> = new Array(rows.length).fill(null);
    // Per touched filament: the doc + the rows whose outcome depends on
    // that doc's single save() succeeding.
    const touched = new Map<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { doc: any; rows: Array<{ index: number; action: "created" | "updated"; name: string }> }
    >();

    // #732 Phase 5: ids explicitly claimed (set/changed) by earlier rows in
    // THIS CSV. Newly minted/changed ids aren't persisted until the post-loop
    // save(), so the DB uniqueness check can't see them — this Set catches a
    // same-id collision between two rows in the same import. Auto-generated
    // ids aren't tracked (40 bits of entropy; collision is negligible and the
    // POST /spools route takes the same posture).
    const claimedInstanceIds = new Set<string>();

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
        rowResults[i] = { row: i + 2, ok: false, error: "filament is required" };
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
          rowResults[i] = {
            row: i + 2,
            ok: false,
            error: "totalWeight must be a non-negative number",
          };
          continue;
        }
        weight = w;
      }

      // Disambiguate by vendor if provided, otherwise match by name alone.
      // Cached per (name, vendor) so a 50-row paste of one material doesn't
      // re-query (GH #525.1).
      const resolved = await resolveFilament(filamentName, vendor);
      if (!resolved) {
        rowResults[i] = {
          row: i + 2,
          ok: false,
          error: vendor
            ? `No filament named "${filamentName}" from vendor "${vendor}"`
            : `No filament named "${filamentName}"`,
        };
        continue;
      }

      // GH #372 (Codex follow-up): treat ISO-shaped-but-impossible dates
      // (Feb 29 outside a leap year, etc.) as bad input rather than
      // silently normalising them to a different day. `new Date(s)` alone
      // would shift "2025-02-29" to March 1st without warning.
      //
      // Validate BEFORE `resolveLocationId` — that call auto-creates a
      // Location row whose name matches the cell, and any row that fails
      // a later check would otherwise leave behind an orphan location
      // (Codex P2 on PR #375). Per-row failures must remain side-effect
      // free so an invalid CSV doesn't dirty the catalog.
      const rawPurchase = (r.purchaseDate || "").trim();
      if (rawPurchase && !isValidIsoDateString(rawPurchase)) {
        rowResults[i] = {
          row: i + 2,
          ok: false,
          error: "purchaseDate must be a valid ISO date (YYYY-MM-DD or full ISO 8601)",
        };
        continue;
      }
      const rawOpened = (r.openedDate || "").trim();
      if (rawOpened && !isValidIsoDateString(rawOpened)) {
        rowResults[i] = {
          row: i + 2,
          ok: false,
          error: "openedDate must be a valid ISO date (YYYY-MM-DD or full ISO 8601)",
        };
        continue;
      }
      const purchaseDate = rawPurchase ? new Date(rawPurchase) : null;
      const openedDate = rawOpened ? new Date(rawOpened) : null;

      // #732 Phase 5: optional `instanceId` column — the spool's own id.
      // Resolve and fully uniqueness-check it HERE, before `resolveLocationId`
      // auto-creates a Location, so a malformed/duplicate id fails this row
      // side-effect-free (mirrors the date checks above — Codex P2 on PR #375).
      // The mutation is applied later against the bucket doc; this block is
      // read-only against persisted state via `resolved`.
      const incomingSpoolId = (r.spoolId || "").trim();
      let incomingInstanceId: string | undefined;
      if ("instanceId" in r) {
        const rawId = unsanitizeCsvCell((r.instanceId || "").trim());
        // Empty cell = "leave unchanged" on update / auto-generate on create;
        // only a non-empty cell is a real id to validate + claim.
        if (rawId !== "") {
          const idCheck = validateSpoolInstanceId(rawId);
          if (!idCheck.ok) {
            rowResults[i] = { row: i + 2, ok: false, error: idCheck.error };
            continue;
          }
          incomingInstanceId = idCheck.value;

          // Locate the spool this row would touch (round-trip dedup by subdoc
          // _id) so we can let it keep its own id and exclude itself from the
          // uniqueness check. Read-only lookup against the persisted doc.
          const existingForCheck = incomingSpoolId
            ? (resolved.spools as unknown as {
                id(id: string): Record<string, unknown> | null;
              }).id(incomingSpoolId)
            : null;
          const keepsOwnId =
            !!existingForCheck && existingForCheck.instanceId === incomingInstanceId;
          if (!keepsOwnId) {
            if (claimedInstanceIds.has(incomingInstanceId)) {
              rowResults[i] = {
                row: i + 2,
                ok: false,
                error: `instanceId "${incomingInstanceId}" is used by more than one row in this CSV`,
              };
              continue;
            }
            const excludeSpoolId = existingForCheck
              ? String(existingForCheck._id)
              : undefined;
            if (
              await isSpoolInstanceIdTaken(
                incomingInstanceId,
                excludeSpoolId,
                String(resolved._id),
              )
            ) {
              rowResults[i] = {
                row: i + 2,
                ok: false,
                error: "That spool ID is already used by another spool",
              };
              continue;
            }
          }
          claimedInstanceIds.add(incomingInstanceId);
        }
      }

      const locationId = await resolveLocationId(
        unsanitizeCsvCell((r.location || "").trim()),
      );

      // Build the field set for a NEW spool — defaults fill in for any
      // optional column the user didn't include.
      const newSpoolFields = {
        label: unsanitizeCsvCell(r.label || ""),
        totalWeight: weight,
        lotNumber: r.lotNumber ? unsanitizeCsvCell(r.lotNumber) : null,
        purchaseDate: purchaseDate && !isNaN(+purchaseDate) ? purchaseDate : null,
        openedDate: openedDate && !isNaN(+openedDate) ? openedDate : null,
        locationId: locationId || null,
        // #732 Phase 5: stamp the spool's own id explicitly (user-supplied +
        // already validated/uniqueness-checked above, or a fresh one) rather
        // than relying on the subdoc default — matches POST /spools.
        instanceId: incomingInstanceId ?? generateInstanceId(),
      };

      // Codex P1 on PR #546: two rows for the SAME filament can resolve via
      // different cache keys — e.g. `PLA,800,` (no vendor) then
      // `PLA,900,Vendor A` (matching vendor) issue two findOne()s and hydrate
      // two SEPARATE Mongoose document instances for the same _id. The save
      // loop persists only the instance stored in the bucket, so a spool
      // pushed onto the other instance would be silently dropped while the
      // row still reports ok. Resolve (or create) the per-_id bucket here —
      // AFTER all per-row validation has passed (Codex P2 on PR #547: doing
      // it before the date checks registered a filament for save() even when
      // the row then failed validation and contributed no mutation) — and
      // mutate ONLY `bucket.doc` so every row for a given filament
      // accumulates onto the one instance that actually gets saved.
      const fid = String(resolved._id);
      let bucket = touched.get(fid);
      if (!bucket) {
        bucket = { doc: resolved, rows: [] };
        touched.set(fid, bucket);
      }
      const filament = bucket.doc;

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
      // `incomingSpoolId` was parsed during the instanceId check above.
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
          // #732 Phase 5: rewrite the id only when a non-empty `instanceId`
          // cell was given (already validated + uniqueness-checked above). An
          // empty/absent cell leaves the spool's existing id untouched — a
          // spool must always keep an id.
          if (incomingInstanceId !== undefined) partialUpdate.instanceId = incomingInstanceId;
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
      // GH #525.1: don't save() per row. Register this row's outcome against
      // its filament (bucket resolved above); the doc is saved once after all
      // rows are applied. The in-memory doc accumulates every row's spool
      // push / update, so one save persists them all.
      bucket.rows.push({ index: i, action, name: filament.name });
    }

    // GH #525.1 + #370: one save() per touched filament. Filament has
    // `optimisticConcurrency: true`, so a concurrent writer can make
    // save() throw VersionError — caught per filament so a conflict on
    // one material reports against only its rows (not the whole batch),
    // and the rest of the import still completes with partial results.
    for (const { doc, rows: bucketRows } of touched.values()) {
      try {
        await doc.save();
        for (const { index, action, name } of bucketRows) {
          rowResults[index] = { row: index + 2, ok: true, action, filament: name };
        }
      } catch (saveErr) {
        const msg = `save failed: ${getErrorMessage(saveErr)}`;
        for (const { index } of bucketRows) {
          rowResults[index] = { row: index + 2, ok: false, error: msg };
        }
      }
    }

    // Assemble in original row order (validation failures were filled
    // in-loop, save outcomes after — rowResults is index-keyed so order
    // is preserved either way).
    const results = rowResults.filter((r): r is RowResult => r !== null);

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

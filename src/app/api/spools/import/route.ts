import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { generateInstanceId, isSpoolInstanceIdTaken } from "@/models/Filament";
import Location from "@/models/Location";
import { parseCsv } from "@/lib/parseCsv";
import {
  getErrorMessage,
  errorResponse,
  checkContentLength,
  checkFileSize,
  MAX_UPLOAD_SIZE,
} from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { unsanitizeCsvCell } from "@/lib/csvWriter";
import { isValidIsoDateString, validateSpoolInstanceId, MAX_SPOOL_TEXT_LENGTH } from "@/lib/validateSpoolBody";

/**
 * Slack added to the 10 MB cap for the multipart Content-Length preflight, to
 * cover the MIME envelope (boundary lines + per-part headers + CRLFs) so a
 * legitimate ~10 MB file isn't rejected for its framing bytes. The route reads
 * only the `file` field, so a real upload's overhead is a few hundred bytes;
 * 64 KB is generous headroom while still far below the multi-MB abuse this
 * guards against (GH #991). `checkFileSize` enforces the exact 10 MB on the
 * file part itself.
 */
const MULTIPART_OVERHEAD_ALLOWANCE = 64 * 1024;

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
 *   instanceId — the spool's own id (#732 Phase 5). Honored on the CREATE
 *     path ONLY: stamped on the new spool (validated for charset/length and
 *     uniqueness-checked against other spools' ids, other filaments'
 *     top-level ids, and other rows in this same CSV; auto-generated when
 *     absent; a malformed/duplicate id fails just that row, side-effect-free).
 *     On the UPDATE path (a row whose spoolId matches an existing spool) the
 *     column is informational and IGNORED — the spool keeps its id. See the
 *     CONTRACT note at the parse site for the full rationale.
 *
 * Returns a per-row result tagged `created | updated` so the client can
 * show granular success/failure. Does not transactionally roll back on
 * partial failure — this is a user bulk-paste, not a critical path.
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  let csvText: string;

  // Branch off the media-type ESSENCE (type/subtype), with parameters stripped.
  // A substring match on the raw Content-Type let a request like
  // `application/json; x="multipart/form-data"` read as multipart and skip BOTH
  // size guards while still entering the JSON branch (Codex P2). Deciding the
  // branch AND the guard gating from the exact essence closes that bypass;
  // legitimate `charset=`/`boundary=` parameters are ignored either way.
  const mediaType = (request.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const isJson = mediaType === "application/json";
  const isMultipart = mediaType === "multipart/form-data";

  // GH #991: bound the request body BEFORE buffering it, so a large upload
  // can't drive the server to buffer + parse far more than this small
  // paste/spreadsheet workflow needs. `next.config.ts` raises
  // `proxyClientMaxBodySize` to 52 MB for snapshot restores, so without this
  // guard this endpoint inherits that budget even on the default
  // unauthenticated local/LAN API. Mirrors the sibling import routes
  // (prusaslicer, bambustudio, import-csv).
  //
  // Content-Length preflight for EVERY shape — kept OUTSIDE the try/catch below
  // so a genuine 413 isn't downgraded into the 400 "Failed to read request
  // body" path. The multipart branch gets a small envelope-overhead allowance
  // (boundaries + part headers) so a legitimate ~10 MB file isn't tripped by
  // its MIME framing, while a huge total body — a big file OR a small file plus
  // tens of MB of extra fields — is still rejected before `formData()` buffers
  // it (Codex P2: `checkFileSize` alone runs only AFTER the whole envelope is
  // parsed and measures only the `file` part). `checkFileSize` below then
  // enforces the exact 10 MB bound on the file part itself.
  const preflight = isMultipart
    ? checkContentLength(request, MAX_UPLOAD_SIZE + MULTIPART_OVERHEAD_ALLOWANCE)
    : checkContentLength(request);
  if (preflight) return preflight;

  try {
    if (isMultipart) {
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
      // GH #991: exact cap on File.size BEFORE file.text() materialises the
      // whole body into memory (matches /api/filaments/bambustudio). The
      // Content-Length preflight above already rejected an oversized TOTAL body;
      // this bounds the file part itself (e.g. a chunked request with no
      // Content-Length that slipped past the preflight).
      const sizeError = checkFileSize(file);
      if (sizeError) return sizeError;
      csvText = await file.text();
    } else {
      // Raw text/csv AND JSON: read the raw body and byte-check the WHOLE
      // buffered payload BEFORE any JSON.parse. This is the hard cap for a
      // missing/lying Content-Length (chunked/headerless) that slips past the
      // preflight and — for JSON — it bounds the full envelope, not just the
      // decoded `csv` field, so a huge sibling JSON field can't sneak an
      // oversized body through (Codex P2). Byte length, not String.length
      // (UTF-16 units): a non-ASCII UTF-8 body can exceed 10 MB of bytes while
      // under the char count (Codex P2 on PR #685).
      const raw = await request.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_UPLOAD_SIZE) {
        return errorResponse("Request body too large. Maximum is 10 MB.", 413);
      }
      if (isJson) {
        const body = JSON.parse(raw);
        if (typeof body?.csv !== "string") {
          return errorResponse("Body must be { csv: string } for JSON requests", 400);
        }
        csvText = body.csv;
      } else {
        csvText = raw;
      }
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

      // GH #953: cap the free-form spool text fields. The schema `maxlength`
      // backstops the save, but check here (side-effect-free, before
      // resolveLocationId auto-creates a Location) so a too-long value fails its
      // own row with a clean message rather than aborting the whole bucket save
      // with a misattributed Mongoose ValidationError. Measure the UNSANITIZED
      // value — that's what persists.
      if (unsanitizeCsvCell(r.label || "").length > MAX_SPOOL_TEXT_LENGTH) {
        rowResults[i] = {
          row: i + 2,
          ok: false,
          error: `label must be ${MAX_SPOOL_TEXT_LENGTH} characters or fewer`,
        };
        continue;
      }
      if (r.lotNumber && unsanitizeCsvCell(r.lotNumber).length > MAX_SPOOL_TEXT_LENGTH) {
        rowResults[i] = {
          row: i + 2,
          ok: false,
          error: `lotNumber must be ${MAX_SPOOL_TEXT_LENGTH} characters or fewer`,
        };
        continue;
      }

      // #732 Phase 5: optional `instanceId` column — the spool's own id.
      // CONTRACT: the column is honored only when CREATING a new spool; on the
      // UPDATE path (a row whose `spoolId` matches an existing spool) it is
      // informational and the spool's id is left untouched. Rationale:
      //   - Pre-Phase-5 exports wrote the FILAMENT-level id into this column for
      //     EVERY spool row (the bug this phase fixes) AND always emitted
      //     `spoolId`, so that legacy artifact only ever arrives on an UPDATE
      //     row. Ignoring it there makes such a CSV round-trip idempotently
      //     (no id rewritten to the filament id, no within-batch dup) — exactly
      //     what Codex asked for on PR #742. Keying off the runtime value
      //     (`rawId === filament.instanceId`) instead was fragile: a legitimate
      //     carry-over spool's own id EQUALS the filament id, so the value test
      //     couldn't tell "legacy artifact" from "real id" (two review rounds
      //     found edge cases). The structural create-vs-update split is exact.
      //   - A NEW (Phase-5) export round-trips losslessly anyway: an update
      //     row's spool already holds the id sitting in its (ignored) cell.
      //   - The spool's id is its stable scan identity; deliberate per-spool id
      //     edits go through the detail-page editor (PUT /spools/{id}, Phase 4),
      //     not a bulk-CSV rewrite.
      // The id resolution/validation/uniqueness runs HERE, before
      // `resolveLocationId` auto-creates a Location, so a malformed/duplicate id
      // fails its row side-effect-free (mirrors the date checks above).
      //
      // Limitation: the DB uniqueness check reads PERSISTED state and the
      // within-batch Set only tracks ids freshly CLAIMED this run, so two CREATE
      // rows in one CSV claiming the same explicit id fail the second safely
      // ("already used") rather than succeeding. Rare for a machine export.
      //
      // Known transitional edge: a PRE-Phase-5 export (filament-level id in
      // every row) imported into a FRESH DB hits the CREATE path for every row,
      // so a multi-spool filament's rows all carry the same id → the first
      // creates, the rest fail loudly as within-batch dups. This is NOT the
      // backup-restore path (full restores go through /api/snapshot/restore,
      // which preserves spool ids verbatim); spool CSV import is for
      // incremental bulk-add. Remedy: re-export with the current version (each
      // row then carries its spool's own id) or drop the instanceId column.
      const incomingSpoolId = (r.spoolId || "").trim();
      let incomingInstanceId: string | undefined;
      if ("instanceId" in r) {
        const rawId = unsanitizeCsvCell((r.instanceId || "").trim());
        if (rawId !== "") {
          // Determine create-vs-update by locating the spool this row targets.
          // A pure persisted-existence question (the column only changes
          // behavior on CREATE), so reading `resolved` is correct regardless of
          // the #546 dual-instance split — a row can only reference a spool _id
          // that already exists in the DB, which every instance of the filament
          // sees identically. The mutation itself still lands on `bucket.doc`
          // in the update/create branch below.
          const existingSpool = incomingSpoolId
            ? (resolved.spools as unknown as {
                id(id: string): Record<string, unknown> | null;
              }).id(incomingSpoolId)
            : null;

          // UPDATE path → leave the existing spool's id untouched (see CONTRACT).
          // CREATE path → honor the supplied id: validate, then uniqueness-check
          // against other spools, other filaments' top-level ids, and other
          // rows in this CSV (the Set, since freshly minted ids aren't persisted
          // until the batched save). `ownFilamentId` permits the legitimate
          // self-filament carry-over collision.
          if (!existingSpool) {
            const idCheck = validateSpoolInstanceId(rawId);
            if (!idCheck.ok) {
              rowResults[i] = { row: i + 2, ok: false, error: idCheck.error };
              continue;
            }
            incomingInstanceId = idCheck.value;

            if (claimedInstanceIds.has(incomingInstanceId)) {
              rowResults[i] = {
                row: i + 2,
                ok: false,
                error: `instanceId "${incomingInstanceId}" is used by more than one row in this CSV`,
              };
              continue;
            }
            if (
              await isSpoolInstanceIdTaken(
                incomingInstanceId,
                undefined,
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
            claimedInstanceIds.add(incomingInstanceId);
          }
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
          // #732 Phase 5: the spool's id is intentionally NOT updated here — the
          // `instanceId` column is honored on CREATE only (see the CONTRACT note
          // where the column is parsed). An existing spool keeps its id.
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

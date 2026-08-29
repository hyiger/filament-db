import { NextRequest, NextResponse } from "next/server";
import {
  findByTrimmedName,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
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
import { hasVariants } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { TEMPLATE_NO_SPOOLS_BODY } from "@/lib/spoolTemplateGuard";

/**
 * Slack added to the 10 MB cap for the multipart Content-Length preflight —
 * covers the MIME envelope so a legitimate ~10 MB file isn't rejected for its
 * framing bytes (GH #991). `checkFileSize` enforces the exact 10 MB on the
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
 *   totalWeight — grams (number). An empty cell maps to null ("weight
 *     unknown") so an export round-trips for spools created with null.
 *
 * Optional columns:
 *   vendor, label, lotNumber, purchaseDate (ISO date), openedDate,
 *   location (name — will create the Location if it doesn't exist),
 *   spoolId — when it matches an existing subdoc _id, the spool is UPDATED
 *     instead of appended, making export → re-import idempotent (GH #159 —
 *     pre-fix a re-import silently doubled inventory).
 *   instanceId — the spool's own id (#732 Phase 5). Honored on CREATE only;
 *     on UPDATE the column is informational and IGNORED. See the CONTRACT
 *     note at the parse site.
 *
 * Returns a per-row result tagged `created | updated`. Does not
 * transactionally roll back on partial failure.
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  let csvText: string;

  // Branch off the media-type ESSENCE (type/subtype), parameters stripped —
  // a substring match on the raw Content-Type let
  // `application/json; x="multipart/form-data"` read as multipart and skip
  // BOTH size guards while entering the JSON branch. Deciding the branch AND
  // the guard gating from the exact essence closes that bypass.
  const mediaType = (request.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const isJson = mediaType === "application/json";
  const isMultipart = mediaType === "multipart/form-data";

  // GH #991: bound the request body BEFORE buffering it — without this the
  // endpoint inherits next.config.ts's 52 MB `proxyClientMaxBodySize` budget
  // (raised for snapshot restores) on the default unauthenticated local/LAN
  // API. Mirrors the sibling import routes.
  //
  // Content-Length preflight for EVERY shape — kept OUTSIDE the try/catch
  // below so a genuine 413 isn't downgraded into the 400 "Failed to read
  // request body" path. The multipart branch gets the envelope-overhead
  // allowance; a huge total body is still rejected before `formData()`
  // buffers it (`checkFileSize` alone runs only AFTER the whole envelope is
  // parsed and measures only the `file` part).
  const preflight = isMultipart
    ? checkContentLength(request, MAX_UPLOAD_SIZE + MULTIPART_OVERHEAD_ALLOWANCE)
    : checkContentLength(request);
  if (preflight) return preflight;

  try {
    if (isMultipart) {
      // GH #339: without this branch a `-F "file=@..."` curl call lands in
      // the raw-text fallback, parses the MIME envelope as CSV, and 400s
      // with a misleading missing-column error.
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return errorResponse("multipart upload must include a 'file' field", 400);
      }
      // GH #991: exact cap on File.size BEFORE file.text() materialises the
      // body — bounds the file part itself (e.g. a chunked request with no
      // Content-Length that slipped past the preflight).
      const sizeError = checkFileSize(file);
      if (sizeError) return sizeError;
      csvText = await file.text();
    } else {
      // Raw text/csv AND JSON: byte-check the WHOLE buffered payload BEFORE
      // any JSON.parse — the hard cap for a missing/lying Content-Length,
      // and for JSON it bounds the full envelope (a huge sibling JSON field
      // can't sneak past). Byte length, not String.length: a non-ASCII UTF-8
      // body can exceed 10 MB of bytes while under the char count.
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
      let id: string;
      if (loc) {
        id = String(loc._id);
      } else {
        // GH #1116: the miss may be a LOOKUP failure rather than a genuine
        // absence — `name` carries `trim: true`, and the setter casts QUERY
        // values too, so this findOne cannot select a survivor still stored
        // raw ("Drybox #1 "). Creating here would succeed (distinct raw
        // strings don't trip the unique index) and mint a second location
        // that renders identically, with every imported spool attaching to
        // the twin.
        const survivor = await findByTrimmedName(
          Location.collection as unknown as MinimalNameCollection,
          name,
          { _deletedAt: null },
        );
        if (survivor) {
          // Address it by `_id` — the one key casting cannot break.
          id = String(survivor._id);
        } else {
          loc = await Location.create({ name });
          id = String(loc._id);
        }
      }
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

    // GH #525.1: cache filament lookups per (name, vendor); `null` is a
    // cached negative so repeated missing-filament rows don't re-query.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filamentCache = new Map<string, any | null>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function resolveFilament(name: string, vendor: string): Promise<any | null> {
      // JSON-encode the pair for a collision-free cache key — both are
      // arbitrary user strings, so no single-character delimiter is safe.
      const key = JSON.stringify([name, vendor]);
      if (filamentCache.has(key)) return filamentCache.get(key)!;
      const query: Record<string, unknown> = { name, _deletedAt: null };
      if (vendor) query.vendor = vendor;
      const doc = await Filament.findOne(query);
      filamentCache.set(key, doc);
      return doc;
    }

    // Defer save() to once-per-filament after ALL its rows are applied.
    // `rowResults` is index-keyed so per-row order is preserved even though
    // saves finalize their rows after the loop.
    const rowResults: Array<RowResult | null> = new Array(rows.length).fill(null);
    // Per touched filament: the doc + the rows whose outcome depends on
    // that doc's single save() succeeding.
    const touched = new Map<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { doc: any; rows: Array<{ index: number; action: "created" | "updated"; name: string }> }
    >();

    // #732 Phase 5: ids explicitly claimed by earlier rows in THIS CSV.
    // Newly minted ids aren't persisted until the post-loop save(), so the
    // DB uniqueness check can't see them — this Set catches a same-id
    // collision within one import. Auto-generated ids aren't tracked (40
    // bits of entropy; same posture as POST /spools).
    const claimedInstanceIds = new Set<string>();

    // GH #605: cached template status per filament id. Advisory only — the
    // save loop re-checks INSIDE the per-filament lock before persisting any
    // bucket that appends spools.
    const templateCache = new Map<string, boolean>();
    async function isTemplate(fid: string): Promise<boolean> {
      let cached = templateCache.get(fid);
      if (cached === undefined) {
        cached = await hasVariants(Filament, fid);
        templateCache.set(fid, cached);
      }
      return cached;
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // Strip the formula-guard apostrophe (`csvCell` prefixes cells
      // starting with =, +, -, @, tab, CR) so an export round-trips cleanly.
      const filamentName = unsanitizeCsvCell((r.filament || "").trim());
      const vendor = unsanitizeCsvCell((r.vendor || "").trim());
      const weightStr = (r.totalWeight || "").trim();

      if (!filamentName) {
        rowResults[i] = { row: i + 2, ok: false, error: "filament is required" };
        continue;
      }

      // Empty cell → preserve null — Number("") === 0 would break round-trip
      // parity (a null-weight spool re-imported from its own export landing
      // as 0g). A populated cell must be a non-negative finite number.
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

      // GH #372: reject ISO-shaped-but-impossible dates — `new Date(s)`
      // silently shifts "2025-02-29" to March 1st.
      //
      // Validate BEFORE `resolveLocationId` — that call auto-creates a
      // Location, and a row failing a later check would leave an orphan
      // behind. Per-row failures must remain side-effect free.
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

      // GH #953: cap the free-form text fields here (side-effect-free,
      // before resolveLocationId) so a too-long value fails its own row
      // rather than aborting the whole bucket save with a misattributed
      // ValidationError. Measure the UNSANITIZED value — that's what
      // persists.
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
      // CONTRACT: honored only when CREATING a new spool; on the UPDATE path
      // (a row whose `spoolId` matches an existing spool) it is
      // informational and the spool keeps its id. Rationale:
      //   - Pre-Phase-5 exports wrote the FILAMENT-level id into this column
      //     for EVERY spool row AND always emitted `spoolId`, so that legacy
      //     artifact only ever arrives on an UPDATE row — ignoring it there
      //     makes such a CSV round-trip idempotently. A value test
      //     (`rawId === filament.instanceId`) can't work: a legitimate
      //     carry-over spool's own id EQUALS the filament id. The structural
      //     create-vs-update split is exact.
      //   - Deliberate per-spool id edits go through PUT /spools/{id}, not a
      //     bulk-CSV rewrite.
      // The id validation/uniqueness runs HERE, before `resolveLocationId`
      // auto-creates a Location, so a malformed/duplicate id fails its row
      // side-effect-free.
      //
      // Known transitional edge: a PRE-Phase-5 export imported into a FRESH
      // DB hits the CREATE path for every row, so a multi-spool filament's
      // rows all carry the same id → the first creates, the rest fail loudly
      // as within-batch dups. Full restores go through /api/snapshot/restore
      // (spool ids preserved verbatim); the remedy here is a re-export with
      // the current version or dropping the column.
      const incomingSpoolId = (r.spoolId || "").trim();
      let incomingInstanceId: string | undefined;
      if ("instanceId" in r) {
        const rawId = unsanitizeCsvCell((r.instanceId || "").trim());
        if (rawId !== "") {
          // Determine create-vs-update by locating the spool this row
          // targets. A pure persisted-existence question, so reading
          // `resolved` is correct regardless of the #546 dual-instance split
          // (a row can only reference a spool _id already in the DB). The
          // mutation itself still lands on `bucket.doc` below.
          const existingSpool = incomingSpoolId
            ? (resolved.spools as unknown as {
                id(id: string): Record<string, unknown> | null;
              }).id(incomingSpoolId)
            : null;

          // UPDATE path → id untouched (see CONTRACT). CREATE path →
          // validate, then uniqueness-check against other spools, other
          // filaments' top-level ids, and other rows in this CSV;
          // `ownFilamentId` permits the legitimate self-filament carry-over
          // collision.
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

      // GH #605: a row that would CREATE a spool on a TEMPLATE fails —
      // inventory lives on the variants, and a bulk paste can't confirm a
      // promotion (same contract text as POST /filaments/{id}/spools).
      // UPDATE rows stay allowed: a legacy template's pre-#605 spools remain
      // editable (enforce-forward posture). Checked BEFORE resolveLocationId
      // so the failure is side-effect-free. Probing `resolved` is equivalent
      // to the later `filament.spools.id(...)` decision (a CSV can only
      // reference persisted subdoc _ids).
      const wouldUpdateExisting = incomingSpoolId
        ? Boolean(
            (resolved.spools as unknown as {
              id(id: string): Record<string, unknown> | null;
            }).id(incomingSpoolId),
          )
        : false;
      if (!wouldUpdateExisting && (await isTemplate(String(resolved._id)))) {
        rowResults[i] = { row: i + 2, ok: false, error: TEMPLATE_NO_SPOOLS_BODY.message };
        continue;
      }

      const locationId = await resolveLocationId(
        unsanitizeCsvCell((r.location || "").trim()),
      );

      // Field set for a NEW spool — defaults fill in for omitted columns.
      const newSpoolFields = {
        label: unsanitizeCsvCell(r.label || ""),
        totalWeight: weight,
        lotNumber: r.lotNumber ? unsanitizeCsvCell(r.lotNumber) : null,
        purchaseDate: purchaseDate && !isNaN(+purchaseDate) ? purchaseDate : null,
        openedDate: openedDate && !isNaN(+openedDate) ? openedDate : null,
        locationId: locationId || null,
        // #732 Phase 5: stamp the spool's own id explicitly rather than
        // relying on the subdoc default — matches POST /spools.
        instanceId: incomingInstanceId ?? generateInstanceId(),
      };

      // Two rows for the SAME filament can resolve via different cache keys
      // (with/without vendor) and hydrate two SEPARATE document instances
      // for one _id — the save loop persists only the bucket's instance, so
      // a spool pushed onto the other would be silently dropped while the
      // row reports ok. Resolve the per-_id bucket here — AFTER all per-row
      // validation (earlier, a failing row would still register its filament
      // for save()) — and mutate ONLY `bucket.doc`.
      const fid = String(resolved._id);
      let bucket = touched.get(fid);
      if (!bucket) {
        bucket = { doc: resolved, rows: [] };
        touched.set(fid, bucket);
      }
      const filament = bucket.doc;

      // Round-trip dedup (GH #159): a row whose `spoolId` matches an
      // existing subdoc updates it instead of appending — otherwise
      // re-importing an export silently doubles the spool count.
      //
      // On the UPDATE path, only assign columns actually present in the CSV
      // header — missing columns must leave existing metadata untouched, or
      // a partial-column re-import (e.g. bulk-updating weights) would
      // silently null label / dates / location on every matched spool.
      let action: "created" | "updated" = "created";
      if (incomingSpoolId) {
        // Cast through unknown — the inferred subdoc type doesn't expose our
        // extended fields (same workaround as the push path below).
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
          // #732: the spool's id is intentionally NOT updated here — the
          // `instanceId` column is honored on CREATE only (see CONTRACT).
          Object.assign(existing, partialUpdate);
          action = "updated";
        }
      }
      if (action === "created") {
        // GH #1111: a row this app exported FROM a legacy roll (the
        // `legacyRoll` marker + first spool) IS the legacy migration, so it
        // clears the top-level `totalWeight` — otherwise the two records
        // coexist and every `spools.length === 0` fallback sits waiting:
        // delete the imported spool later and the old roll silently
        // reappears. GATED on the export's marker, not merely on "first
        // spool": this route also accepts hand-written incremental CSVs, and
        // bulk-adding an unrelated spool to a legacy filament must add
        // alongside the roll, not delete its weight.
        const isLegacyMigration =
          filament.spools.length === 0 &&
          String(r.legacyRoll ?? "").trim().toLowerCase() === "true";
        // Cast to unknown — the inferred subdoc type doesn't include our
        // added fields.
        filament.spools.push(newSpoolFields as unknown as Parameters<typeof filament.spools.push>[0]);
        if (isLegacyMigration && filament.totalWeight != null) {
          filament.totalWeight = null;
        }
      }
      // Register this row's outcome against its filament; the doc is saved
      // once after all rows are applied.
      bucket.rows.push({ index: i, action, name: filament.name });
    }

    // GH #525.1 + #370: one save() per touched filament. A VersionError from
    // a concurrent writer is caught per filament, so a conflict on one
    // material reports against only its rows and the rest still completes.
    //
    // GH #605: each save runs inside the same per-filament mutex the
    // promotion/spool routes lock, and a bucket that APPENDED spools
    // re-checks template status in-lock first — the per-row check is
    // check-then-act, so a first-variant promotion landing mid-import could
    // otherwise have this save() write the (moved) spools array back onto
    // the freshly-cleared template. A trip fails the whole bucket (all its
    // rows share the one save).
    for (const { doc, rows: bucketRows } of touched.values()) {
      const appendsSpools = bucketRows.some((b) => b.action === "created");
      const failure = await runExclusive(
        filamentLockKey(doc._id),
        async (): Promise<string | null> => {
          if (appendsSpools && (await hasVariants(Filament, String(doc._id)))) {
            return TEMPLATE_NO_SPOOLS_BODY.message;
          }
          try {
            await doc.save();
            return null;
          } catch (saveErr) {
            return `save failed: ${getErrorMessage(saveErr)}`;
          }
        },
      );
      if (failure === null) {
        for (const { index, action, name } of bucketRows) {
          rowResults[index] = { row: index + 2, ok: true, action, filament: name };
        }
      } else {
        for (const { index } of bucketRows) {
          rowResults[index] = { row: index + 2, ok: false, error: failure };
        }
      }
    }

    const results = rowResults.filter((r): r is RowResult => r !== null);

    const ok = results.filter((r) => r.ok).length;
    const created = results.filter((r) => r.ok && r.action === "created").length;
    const updated = results.filter((r) => r.ok && r.action === "updated").length;
    const failed = results.length - ok;
    // `imported` is preserved for backwards compatibility with clients that
    // already read it; `created`/`updated` are the breakdown.
    return NextResponse.json({ imported: ok, created, updated, failed, results });
  } catch (err) {
    return errorResponse("Failed to import spools", 500, getErrorMessage(err));
  }
}

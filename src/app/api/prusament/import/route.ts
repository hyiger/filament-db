import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { generateInstanceId } from "@/models/Filament";
import type { PrusamentScrapeResult } from "../route";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { isValidIsoDateString } from "@/lib/validateSpoolBody";
import {
  errorResponseFromCaught,
  handleDuplicateKeyError,
  isDuplicateKeyError,
} from "@/lib/apiErrorHandler";

/**
 * GH #307: validate a renderer-supplied Prusament spool payload before
 * any DB write. The spool's `totalWeight` reaches the Filament via a
 * `$push`, which skips the subdocument validators the dedicated spool
 * routes rely on — so a non-numeric weight or a garbage colour would
 * otherwise be persisted. Returns a rejection reason, or null when ok.
 */
function validatePrusamentSpool(spool: unknown): string | null {
  if (!spool || typeof spool !== "object") {
    return "spool must be an object";
  }
  const s = spool as Record<string, unknown>;
  if (typeof s.spoolId !== "string" || s.spoolId.trim() === "") {
    return "spool.spoolId is required";
  }
  for (const field of [
    "diameter",
    "lengthMeters",
    "netWeight",
    "totalWeight",
    "spoolWeight",
  ]) {
    const v = s[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return `spool.${field} must be a non-negative number`;
    }
  }
  if (typeof s.colorHex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(s.colorHex)) {
    return "spool.colorHex must be a #RRGGBB hex colour";
  }
  if (typeof s.material !== "string" || s.material.trim() === "") {
    return "spool.material is required";
  }
  if (typeof s.colorName !== "string") {
    return "spool.colorName must be a string";
  }
  if (typeof s.manufactureDate !== "string") {
    return "spool.manufactureDate must be a string";
  }
  // GH #622: the fields below ride straight into schema-validated paths
  // (`cost` has min:0, `temperatures.nozzle` max:600, `temperatures.bed`
  // max:300, `tdsUrl` has the http(s) validator). Pre-fix they were
  // unchecked, so a bad value threw a ValidationError out of the handler
  // → Next's bare 500 instead of the JSON 400 every sibling route
  // returns. Reject them here so the caller gets a named reason.
  if (
    s.priceUsd != null &&
    (typeof s.priceUsd !== "number" || !Number.isFinite(s.priceUsd) || s.priceUsd < 0)
  ) {
    return "spool.priceUsd must be a non-negative number or null";
  }
  for (const field of ["nozzleTempMin", "nozzleTempMax"]) {
    const v = s[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 600) {
      return `spool.${field} must be a number between 0 and 600`;
    }
  }
  for (const field of ["bedTempMin", "bedTempMax"]) {
    const v = s[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 300) {
      return `spool.${field} must be a number between 0 and 300`;
    }
  }
  // pageUrl lands on `tdsUrl`, whose schema validator rejects anything
  // but http(s) (empty/null are allowed — the field is optional). Same
  // posture here so a `javascript:` URL 400s instead of throwing.
  if (s.pageUrl != null && s.pageUrl !== "") {
    if (typeof s.pageUrl !== "string" || !isHttpUrl(s.pageUrl)) {
      return "spool.pageUrl must be a valid http(s) URL";
    }
  }
  return null;
}

/** GH #622: mirror the Filament schema's `isValidTdsUrl` posture. */
function isHttpUrl(v: string): boolean {
  try {
    const proto = new URL(v).protocol;
    return proto === "http:" || proto === "https:";
  } catch {
    return false;
  }
}

/** Cap on spools per filament. GH #430 added it to the add-spool branch,
 *  then (Codex follow-up r3) to the existing-name $push fallback; GH #622
 *  hoisted the duplicated constants here so the resurrect + race-recovery
 *  phases reuse the same value. */
const MAX_SPOOLS_PER_FILAMENT = 500;

/** GH #430 (Codex round 4 follow-up): the per-filament spool cap enforced
 *  ATOMICALLY inside each conditional update via
 *  `$expr: { $lt: [{ $size: spools }, 500] }`. The previous
 *  "fetch → check length → $push" sequence was a race: several concurrent
 *  add-spool requests against the same filament could each see
 *  length<500, then all $push, blowing past the cap. */
const SPOOL_CAP_EXPR = {
  $lt: [{ $size: { $ifNull: ["$spools", []] } }, MAX_SPOOLS_PER_FILAMENT],
};

/**
 * POST /api/prusament/import
 *
 * Imports a scraped Prusament spool into the database.
 *
 * Body:
 *   spool       – PrusamentScrapeResult from the scrape endpoint
 *   filamentId  – (optional) existing filament ID to add a spool to
 *   action      – "create" | "add-spool"
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  try {
    await dbConnect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Database connection failed", detail: message }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
  }
  const spool: PrusamentScrapeResult = body.spool;
  const action: string = body.action; // "create" or "add-spool"
  const filamentId: string | undefined = body.filamentId;

  // GH #307: full shape validation — not just a spoolId truthiness check.
  const spoolError = validatePrusamentSpool(spool);
  if (spoolError) {
    return NextResponse.json({ error: spoolError }, { status: 400 });
  }

  if (action && action !== "create" && action !== "add-spool") {
    return NextResponse.json(
      { error: `Invalid action: "${action}". Must be "create" or "add-spool".` },
      { status: 400 },
    );
  }

  // GH #622: everything below touches the DB. Pre-fix only dbConnect and
  // the body parse were guarded, so any write error (a ValidationError a
  // future field slips past the validator above, an E11000 create race,
  // a transient driver failure) escaped the handler as Next's bare 500.
  // The catch at the bottom maps duplicate-key → 409, client-input → 400,
  // everything else → JSON 500 — same posture as the sibling importers.
  try {
    // Compute density from Prusament data: weight(g) / volume(cm³)
    // volume = length(m) * 100(cm/m) * π * (diameter_mm / 20)²
    const radiusCm = spool.diameter / 20;
    const volumeCm3 = spool.lengthMeters * 100 * Math.PI * radiusCm * radiusCm;
    const density = volumeCm3 > 0 ? Math.round((spool.netWeight / volumeCm3) * 100) / 100 : null;

    const spoolLabel = `${spool.spoolId} (${spool.manufactureDate.split(" ")[0]})`;

    if (action === "add-spool" && filamentId) {
      // GH #430: validate the filament id up front so a malformed id
      // surfaces as 400, not a downstream CastError → bare 500.
      if (!mongoose.isValidObjectId(filamentId)) {
        return NextResponse.json({ error: "Invalid filament id" }, { status: 400 });
      }

      // GH #430: carry the Prusament-specific traceability fields onto
      // the spool subdoc. Pre-fix the $push only carried label +
      // totalWeight, silently dropping the lot number and manufacture
      // date that are the whole point of a Prusament import.
      // `manufactureDate` is "YYYY-MM-DD HH:MM" — split off the time
      // and validate before persisting.
      const purchaseDateStr = spool.manufactureDate.split(" ")[0];
      const purchaseDate = isValidIsoDateString(purchaseDateStr)
        ? new Date(purchaseDateStr)
        : null;

      const filament = await Filament.findOneAndUpdate(
        {
          _id: filamentId,
          _deletedAt: null,
          $expr: SPOOL_CAP_EXPR,
        },
        {
          $push: {
            spools: {
              // #732: stamp the spool id explicitly (belt-and-suspenders;
              // the schema default would also fire on $push).
              instanceId: generateInstanceId(),
              label: spoolLabel,
              totalWeight: spool.totalWeight,
              lotNumber: spool.spoolId,
              ...(purchaseDate ? { purchaseDate } : {}),
            },
          },
        },
        { returnDocument: "after" },
      ).lean();

      if (!filament) {
        // The conditional didn't match — either the filament doesn't
        // exist, or it's already at cap. Probe to differentiate so the
        // caller gets a clear error rather than a generic 404.
        const probe = await Filament.findOne(
          { _id: filamentId, _deletedAt: null },
          { spools: 1 },
        ).lean();
        if (probe && (probe.spools?.length ?? 0) >= MAX_SPOOLS_PER_FILAMENT) {
          return NextResponse.json(
            {
              error: `This filament already has ${MAX_SPOOLS_PER_FILAMENT} spools (the per-filament limit)`,
            },
            { status: 400 },
          );
        }
        return NextResponse.json({ error: "Filament not found" }, { status: 404 });
      }

      return NextResponse.json({
        action: "add-spool",
        filament,
        message: `Added spool ${spool.spoolId} to ${filament.name}`,
      });
    }

    // action === "create" — create a new filament
    const name = `Prusament ${spool.material} ${spool.colorName}`;

    // GH #430 (Codex follow-up on #463): the create flow ALSO has to
    // carry the Prusament traceability fields onto every spool subdoc
    // it writes. Pre-fix the create branch + the existing-name $push
    // fallback both wrote `{ label, totalWeight }` only, silently
    // dropping the spool id and manufacture date that are the whole
    // point of a Prusament import — even though the add-spool branch
    // higher up already did the right thing.
    const purchaseDateForCreate = isValidIsoDateString(
      spool.manufactureDate.split(" ")[0],
    )
      ? new Date(spool.manufactureDate.split(" ")[0])
      : null;
    const prusamentSpoolFields = {
      // #732: stamp the spool id once for every branch that reuses this
      // object (the create path + the existing-name $push fallbacks).
      // Belt-and-suspenders: the schema default would also fire on both
      // Filament.create and $push — explicit keeps the invariant obvious.
      instanceId: generateInstanceId(),
      label: spoolLabel,
      totalWeight: spool.totalWeight,
      lotNumber: spool.spoolId,
      ...(purchaseDateForCreate ? { purchaseDate: purchaseDateForCreate } : {}),
    };

    // GH #430 (Codex follow-up r3): cap per-filament spool count on
    // the existing-name $push fallback too — the cap previously only
    // applied to the dedicated add-spool branch above, so a hostile
    // client routed through the default `action=create` flow could
    // push past the limit by re-importing against an existing name.
    const conditionalUpdate = await Filament.findOneAndUpdate(
      {
        name,
        _deletedAt: null,
        $expr: SPOOL_CAP_EXPR,
      },
      { $push: { spools: prusamentSpoolFields } },
      { returnDocument: "after" },
    ).lean();

    if (conditionalUpdate) {
      return NextResponse.json({
        action: "add-spool",
        filament: conditionalUpdate,
        message: `Filament "${name}" already exists. Added spool ${spool.spoolId}.`,
      });
    }

    // No conditional match — either the name doesn't exist (continue
    // to create) OR the name exists but is over cap. Check which.
    const blocked = await Filament.findOne(
      { name, _deletedAt: null },
      { spools: 1 },
    ).lean();
    if (
      blocked &&
      (blocked.spools?.length ?? 0) >= MAX_SPOOLS_PER_FILAMENT
    ) {
      return NextResponse.json(
        {
          error: `Filament "${name}" already has ${MAX_SPOOLS_PER_FILAMENT} spools (the per-filament limit)`,
        },
        { status: 400 },
      );
    }

    // GH #622 phase 2 (mirrors `/api/filaments/import` #297): if a
    // TRASHED (non-purged) filament owns this name, resurrect it and
    // push the spool rather than creating a second active row — a
    // duplicate would strand the trashed one (its restore would 409 on
    // the name conflict forever). Like the active-name fallback above,
    // the resurrect only adds the spool; it doesn't rewrite the
    // filament's structured fields.
    const resurrected = await Filament.findOneAndUpdate(
      {
        name,
        _deletedAt: { $ne: null },
        _purged: { $ne: true },
        $expr: SPOOL_CAP_EXPR,
      },
      {
        $set: { _deletedAt: null },
        $push: { spools: prusamentSpoolFields },
      },
      { returnDocument: "after" },
    ).lean();
    if (resurrected) {
      return NextResponse.json({
        action: "add-spool",
        filament: resurrected,
        message: `Restored "${name}" from trash and added spool ${spool.spoolId}.`,
      });
    }
    // Same over-cap probe as the active branch: a trashed row at cap
    // must NOT fall through to create (the new active row would strand
    // the trashed one on the name forever).
    const trashedBlocked = await Filament.findOne(
      { name, _deletedAt: { $ne: null }, _purged: { $ne: true } },
      { spools: 1 },
    ).lean();
    if (
      trashedBlocked &&
      (trashedBlocked.spools?.length ?? 0) >= MAX_SPOOLS_PER_FILAMENT
    ) {
      return NextResponse.json(
        {
          error: `Filament "${name}" already has ${MAX_SPOOLS_PER_FILAMENT} spools (the per-filament limit)`,
        },
        { status: 400 },
      );
    }

    // GH #622 phase 3 — create, recovering from the E11000 race where a
    // concurrent import created the same name between the conditional
    // $push above and this create. The loser resolves it as an
    // add-spool against the winner, so identical parallel imports stay
    // idempotent (same pattern as `/api/filaments/import`).
    //
    // Use the max nozzle temp as the default (Prusament typically
    // recommends a range).
    let filament;
    try {
      filament = await Filament.create({
        name,
        vendor: "Prusa Research",
        type: spool.material,
        color: spool.colorHex,
        cost: spool.priceUsd,
        density,
        diameter: spool.diameter,
        temperatures: {
          nozzle: spool.nozzleTempMax,
          nozzleFirstLayer: null,
          bed: spool.bedTempMax,
          bedFirstLayer: null,
        },
        spoolWeight: spool.spoolWeight,
        netFilamentWeight: spool.netWeight,
        spools: [prusamentSpoolFields],
        tdsUrl: spool.pageUrl,
        settings: {
          prusament_spool_id: spool.spoolId,
          nozzle_temp_range: `${spool.nozzleTempMin}-${spool.nozzleTempMax}`,
          bed_temp_range: `${spool.bedTempMin}-${spool.bedTempMax}`,
        },
      });
    } catch (createErr) {
      if (!isDuplicateKeyError(createErr)) throw createErr;
      const raced = await Filament.findOneAndUpdate(
        { name, _deletedAt: null, $expr: SPOOL_CAP_EXPR },
        { $push: { spools: prusamentSpoolFields } },
        { returnDocument: "after" },
      ).lean();
      // The winning row vanished (or is at cap) — surface the original
      // duplicate-key error via the outer catch's 409 mapping.
      if (!raced) throw createErr;
      return NextResponse.json({
        action: "add-spool",
        filament: raced,
        message: `Filament "${name}" already exists. Added spool ${spool.spoolId}.`,
      });
    }

    return NextResponse.json({
      action: "create",
      filament,
      message: `Created "${name}" with spool ${spool.spoolId}`,
    }, { status: 201 });
  } catch (err) {
    const dup = handleDuplicateKeyError(err, "filament");
    if (dup) return dup;
    return errorResponseFromCaught(err, "Failed to import Prusament spool");
  }
}

import mongoose from "mongoose";
import {
  findSurvivorId,
  type MinimalNameCollection,
} from "@/lib/trimmedNameLookup";
import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament, { generateInstanceId } from "@/models/Filament";
import type { PrusamentScrapeResult } from "../route";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { isValidIsoDateString } from "@/lib/validateSpoolBody";
import { hasVariants } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import {
  pushSpoolWithTemplateGuard,
  TEMPLATE_NO_SPOOLS_BODY,
} from "@/lib/spoolTemplateGuard";
import {
  errorResponseFromCaught,
  handleDuplicateKeyError,
  isDuplicateKeyError,
} from "@/lib/apiErrorHandler";

/**
 * GH #307: validate the spool payload before any DB write — the `$push`
 * write path skips the subdocument validators the dedicated spool routes
 * rely on. Returns a rejection reason, or null when ok.
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
  // GH #622: these fields ride straight into schema-validated paths — an
  // unchecked bad value would throw a ValidationError out of the handler as
  // a bare 500 instead of a named JSON 400.
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
  // pageUrl lands on `tdsUrl` (http(s)-only validator) — same posture here
  // so a `javascript:` URL 400s instead of throwing.
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

/** Cap on spools per filament (GH #430), shared by every phase. */
const MAX_SPOOLS_PER_FILAMENT = 500;

/** GH #430: the per-filament spool cap, enforced ATOMICALLY inside each
 *  conditional update — a "fetch → check length → $push" sequence is a race
 *  (concurrent requests could each see length<500 and all $push). */
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

  // GH #622: the catch at the bottom maps duplicate-key → 409, client-input
  // → 400, everything else → JSON 500 — same posture as the sibling
  // importers (an unguarded write error would escape as Next's bare 500).
  try {
    // Density from Prusament data: weight(g) / volume(cm³);
    // volume = length(m) * 100(cm/m) * π * (diameter_mm / 20)²
    const radiusCm = spool.diameter / 20;
    const volumeCm3 = spool.lengthMeters * 100 * Math.PI * radiusCm * radiusCm;
    const density = volumeCm3 > 0 ? Math.round((spool.netWeight / volumeCm3) * 100) / 100 : null;

    const spoolLabel = `${spool.spoolId} (${spool.manufactureDate.split(" ")[0]})`;

    if (action === "add-spool" && filamentId) {
      // GH #430: validate the id up front so a malformed id surfaces as
      // 400, not a downstream CastError → bare 500.
      if (!mongoose.isValidObjectId(filamentId)) {
        return NextResponse.json({ error: "Invalid filament id" }, { status: 400 });
      }

      // `manufactureDate` is "YYYY-MM-DD HH:MM" — split off the time and
      // validate before persisting.
      const purchaseDateStr = spool.manufactureDate.split(" ")[0];
      const purchaseDate = isValidIsoDateString(purchaseDateStr)
        ? new Date(purchaseDateStr)
        : null;

      // GH #605: route through the same race-hardened template guard the
      // dedicated spool route uses, inside the same per-filament mutex — a
      // raw $push could land inventory on a TEMPLATE. The spool cap stays
      // enforced atomically via the guard's extraFilter.
      const result = await runExclusive(filamentLockKey(filamentId), () =>
        pushSpoolWithTemplateGuard(
          Filament,
          filamentId,
          {
            // #732: stamp the spool id explicitly (belt-and-suspenders).
            instanceId: generateInstanceId(),
            label: spoolLabel,
            totalWeight: spool.totalWeight,
            lotNumber: spool.spoolId,
            ...(purchaseDate ? { purchaseDate } : {}),
          },
          hasVariants,
          { extraFilter: { $expr: SPOOL_CAP_EXPR } },
        ),
      );

      if (result.outcome === "template") {
        return NextResponse.json(TEMPLATE_NO_SPOOLS_BODY, { status: 400 });
      }
      if (result.outcome === "not_found") {
        // The conditional didn't match — filament missing OR at cap. Probe
        // to differentiate.
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
        filament: result.filament,
        message: `Added spool ${spool.spoolId} to ${result.filament.name}`,
      });
    }

    // action === "create" — create a new filament
    const name = `Prusament ${spool.material} ${spool.colorName}`;

    // GH #430: every branch that writes a spool subdoc must carry the
    // Prusament traceability fields (lot number + manufacture date are the
    // whole point of the import).
    const purchaseDateForCreate = isValidIsoDateString(
      spool.manufactureDate.split(" ")[0],
    )
      ? new Date(spool.manufactureDate.split(" ")[0])
      : null;
    const prusamentSpoolFields = {
      // #732: stamp the spool id once for every branch that reuses this
      // object (belt-and-suspenders — the schema default would also fire).
      instanceId: generateInstanceId(),
      label: spoolLabel,
      totalWeight: spool.totalWeight,
      lotNumber: spool.spoolId,
      ...(purchaseDateForCreate ? { purchaseDate: purchaseDateForCreate } : {}),
    };

    // GH #430: the cap applies on the existing-name $push fallback too —
    // otherwise the `action=create` flow could push past the limit against
    // an existing name. GH #605: the fallback resolves the active row's id
    // first and routes the push through the template guard inside the
    // per-filament mutex — a name that has since become a TEMPLATE must
    // 400, not attach inventory. The `name` pin plus the cap ride the
    // guard's extraFilter so the atomic-write semantics hold.
    let activeByName = await Filament.findOne({ name, _deletedAt: null })
      .select("_id")
      .lean();
    // GH #1116: an untrimmed survivor is invisible to a name-filtered query
    // (the setter casts it) — a miss here would mint a second active row.
    const activeSurvivorId = activeByName
      ? null
      : await findSurvivorId(
          Filament.collection as unknown as MinimalNameCollection,
          name,
          { _deletedAt: null },
        );
    if (activeSurvivorId) {
      activeByName = await Filament.findOne({ _id: activeSurvivorId })
        .select("_id")
        .lean();
    }
    if (activeByName) {
      const guarded = await runExclusive(filamentLockKey(activeByName._id), () =>
        pushSpoolWithTemplateGuard(
          Filament,
          String(activeByName._id),
          prusamentSpoolFields,
          hasVariants,
          {
            // The `name` pin makes the push atomic against a concurrent
            // rename. It cannot match a SURVIVOR's raw stored value, so pin
            // the `_id` there — strictly more specific, same "still the row
            // we resolved" guarantee.
            extraFilter: activeSurvivorId
              ? { _id: activeSurvivorId, $expr: SPOOL_CAP_EXPR }
              : { name, $expr: SPOOL_CAP_EXPR },
          },
        ),
      );
      if (guarded.outcome === "template") {
        return NextResponse.json(TEMPLATE_NO_SPOOLS_BODY, { status: 400 });
      }
      if (guarded.outcome === "created") {
        return NextResponse.json({
          action: "add-spool",
          filament: guarded.filament,
          message: `Filament "${name}" already exists. Added spool ${spool.spoolId}.`,
        });
      }
      // not_found: the row vanished / was renamed mid-flight, or it is at
      // cap — fall through to the same probe the pre-guard code used.
    }

    // No conditional match — name absent (continue to create) OR over cap.
    // GH #1116: reuse the resolved survivor id — a cast `name` probe would
    // MISS the very survivor that is over cap, and the request would fall
    // through and create a canonical duplicate carrying the spool.
    const blocked = await Filament.findOne(
      activeSurvivorId ? { _id: activeSurvivorId } : { name, _deletedAt: null },
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

    // GH #622 phase 2 (mirrors `/api/filaments/import` #297): if a TRASHED
    // (non-purged) filament owns this name, resurrect it and push the spool
    // rather than creating a second active row — a duplicate would strand
    // the trashed one (its restore would 409 on the name forever). The
    // resurrect only adds the spool; it doesn't rewrite structured fields.
    //
    // GH #605: this $push needs NO template guard — a trashed doc cannot be
    // a template (soft-deleting a parent with live variants is refused
    // under the same mutex as the first-variant gates; restoring a variant
    // under a trashed parent is refused; variant creation requires an
    // ACTIVE parent), and the resurrect+push is one atomic findOneAndUpdate
    // (no window between revive and push). A first-variant create racing
    // the just-revived row serializes behind the promotion gate's in-lock
    // re-fetch, which then sees (and moves) this spool.
    //
    // GH #1116: a surviving untrimmed TRASHED row is unreachable by a cast
    // name filter — a missed resurrect lets the create take the name and
    // strand the tombstone. CANONICAL FIRST, survivor only on a miss: a
    // canonical tombstone and an untrimmed one may BOTH exist, and the
    // scan's `$expr` matches either with no ordering — scanning first could
    // resurrect an arbitrary one where the indexed query deterministically
    // restores the canonical row.
    const resurrectFilter = {
      _deletedAt: { $ne: null },
      _purged: { $ne: true },
      $expr: SPOOL_CAP_EXPR,
    };
    const resurrectUpdate = {
      $set: { _deletedAt: null },
      $push: { spools: prusamentSpoolFields },
    };
    let resurrected = await Filament.findOneAndUpdate(
      // name-lookup-ok: canonical attempt; the survivor scan below covers the miss
      { name, ...resurrectFilter },
      resurrectUpdate,
      { returnDocument: "after" },
    ).lean();
    let trashedSurvivorId: unknown | null = null;
    if (!resurrected) {
      trashedSurvivorId = await findSurvivorId(
        Filament.collection as unknown as MinimalNameCollection,
        name,
        { _deletedAt: { $ne: null }, _purged: { $ne: true } },
      );
      if (trashedSurvivorId) {
        resurrected = await Filament.findOneAndUpdate(
          { _id: trashedSurvivorId, ...resurrectFilter },
          resurrectUpdate,
          { returnDocument: "after" },
        ).lean();
      }
    }
    if (resurrected) {
      return NextResponse.json({
        action: "add-spool",
        filament: resurrected,
        message: `Restored "${name}" from trash and added spool ${spool.spoolId}.`,
      });
    }
    // Same over-cap probe as the active branch: a trashed row at cap must
    // NOT fall through to create (stranding the trashed one on the name).
    const trashedBlocked = await Filament.findOne(
      trashedSurvivorId
        ? { _id: trashedSurvivorId }
        : { name, _deletedAt: { $ne: null }, _purged: { $ne: true } },
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

    // GH #622 phase 3 — create, recovering from the E11000 race: the loser
    // resolves it as an add-spool against the winner, so identical parallel
    // imports stay idempotent (same pattern as `/api/filaments/import`).
    // Max nozzle temp as the default (Prusament recommends a range).
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
    // name-lookup-ok: post-E11000 recovery: the index proved an exact stored-string match
    } catch (createErr) {
      if (!isDuplicateKeyError(createErr)) throw createErr;
      // GH #605: same guard treatment as the active-name fallback — nothing
      // stops the race winner from being (or instantly becoming) a
      // template, so the recovery push must not bypass the guard either.
      // name-lookup-ok: post-E11000 recovery; the index proved an exact stored-string match
      const winner = await Filament.findOne({ name, _deletedAt: null })
        .select("_id")
        .lean();
      // The winning row vanished — surface the original duplicate-key
      // error via the outer catch's 409 mapping.
      if (!winner) throw createErr;
      const raced = await runExclusive(filamentLockKey(winner._id), () =>
        pushSpoolWithTemplateGuard(
          Filament,
          String(winner._id),
          prusamentSpoolFields,
          hasVariants,
          { extraFilter: { name, $expr: SPOOL_CAP_EXPR } },
        ),
      );
      if (raced.outcome === "template") {
        return NextResponse.json(TEMPLATE_NO_SPOOLS_BODY, { status: 400 });
      }
      // not_found: gone again, or at cap — same posture as before (the
      // original code threw whenever its conditional update missed).
      if (raced.outcome !== "created") throw createErr;
      return NextResponse.json({
        action: "add-spool",
        filament: raced.filament,
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

import mongoose from "mongoose";
import { settingValuesEqual } from "./slicerSettings";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { unsanitizeCsvCell } from "@/lib/csvWriter";
import { hasVariants } from "@/lib/resolveFilament";
import { runExclusive, filamentLockKey } from "@/lib/filamentMutex";
import { stripTemplateFieldsForWrite } from "@/lib/templateStrip";
import { clearOrphanedParentThreshold } from "@/lib/promoteParent";
import { firstVariantGateInfo } from "@/lib/firstVariantGate";
import { trimmedNameFilter } from "@/lib/trimmedNameLookup";

export interface ImportRow {
  name?: string;
  vendor?: string;
  type?: string;
  color?: string;
  /** GH #477: comma-separated secondary color hexes from the "Secondary
   *  Colors" column (round-trips with EXPORT_COLUMNS). Blank entries are
   *  filtered; non-`#RRGGBB` entries silently dropped; capped at 5 per the
   *  spec. */
  secondaryColors?: string;
  diameter?: number | null;
  cost?: number | null;
  density?: number | null;
  nozzleTemp?: number | null;
  nozzleFirstLayerTemp?: number | null;
  bedTemp?: number | null;
  bedFirstLayerTemp?: number | null;
  maxVolumetricSpeed?: number | null;
  spoolWeight?: number | null;
  netFilamentWeight?: number | null;
  dryingTemperature?: number | null;
  dryingTime?: number | null;
  transmissionDistance?: number | null;
  glassTempTransition?: number | null;
  heatDeflectionTemp?: number | null;
  shoreHardnessA?: number | null;
  shoreHardnessD?: number | null;
  minPrintSpeed?: number | null;
  maxPrintSpeed?: number | null;
  colorName?: string | null;
  spoolType?: string | null;
  nozzleRangeMin?: number | null;
  nozzleRangeMax?: number | null;
  standbyTemp?: number | null;
  tdsUrl?: string | null;
  instanceId?: string | null;
  /**
   * GH #379: optional parent-filament name from the export's `Parent`
   * column. Only honoured on CREATE/RESURRECT — silently re-parenting an
   * existing active filament from a re-imported CSV is a surprising UX, and
   * the "Create variant" / Clone-from-parent UI covers the manual case.
   */
  parentName?: string | null;
  /**
   * GH #954: OpenPrintTag `optTags` as a comma-separated list of numeric ids
   * (the `Tags` export column). Honoured on CREATE/RESURRECT only — the
   * update path would need the same variant-inheritance split
   * `secondaryColors` gets.
   */
  optTags?: string | null;
}

/** Map header text (case-insensitive) to ImportRow keys */
const HEADER_MAP: Record<string, keyof ImportRow | undefined> = {
  name: "name",
  vendor: "vendor",
  type: "type",
  color: "color",
  "secondary colors": "secondaryColors",
  secondarycolors: "secondaryColors",
  "secondary color": "secondaryColors",
  "diameter (mm)": "diameter",
  diameter: "diameter",
  cost: "cost",
  "density (g/cm³)": "density",
  "density (g/cm3)": "density",
  density: "density",
  "nozzle temp (°c)": "nozzleTemp",
  "nozzle temp": "nozzleTemp",
  nozzletemp: "nozzleTemp",
  "nozzle first layer (°c)": "nozzleFirstLayerTemp",
  "nozzle first layer": "nozzleFirstLayerTemp",
  "bed temp (°c)": "bedTemp",
  "bed temp": "bedTemp",
  bedtemp: "bedTemp",
  "bed first layer (°c)": "bedFirstLayerTemp",
  "bed first layer": "bedFirstLayerTemp",
  "max vol. speed (mm³/s)": "maxVolumetricSpeed",
  "max volumetric speed": "maxVolumetricSpeed",
  "spool weight (g)": "spoolWeight",
  "spool weight": "spoolWeight",
  "net filament weight (g)": "netFilamentWeight",
  "net filament weight": "netFilamentWeight",
  spools: undefined, // skip spool count — computed, not importable
  "tds url": "tdsUrl",
  tdsurl: "tdsUrl",
  "instance id": "instanceId",
  instanceid: "instanceId",
  "instance_id": "instanceId",
  "drying temp": "dryingTemperature",
  "drying temp (°c)": "dryingTemperature",
  "drying temperature": "dryingTemperature",
  dryingtemperature: "dryingTemperature",
  "drying time": "dryingTime",
  "drying time (min)": "dryingTime",
  dryingtime: "dryingTime",
  "transmission distance": "transmissionDistance",
  "hueforge td": "transmissionDistance",
  transmissiondistance: "transmissionDistance",
  td: "transmissionDistance",
  "shore a": "shoreHardnessA",
  "shore hardness a": "shoreHardnessA",
  shorea: "shoreHardnessA",
  "shore d": "shoreHardnessD",
  "shore hardness d": "shoreHardnessD",
  shored: "shoreHardnessD",
  "glass transition": "glassTempTransition",
  "glass transition tg (°c)": "glassTempTransition",
  tg: "glassTempTransition",
  "heat deflection": "heatDeflectionTemp",
  "heat deflection hdt (°c)": "heatDeflectionTemp",
  hdt: "heatDeflectionTemp",
  "min print speed": "minPrintSpeed",
  "min print speed (mm/s)": "minPrintSpeed",
  "max print speed": "maxPrintSpeed",
  "max print speed (mm/s)": "maxPrintSpeed",
  "color name": "colorName",
  colorname: "colorName",
  "spool type": "spoolType",
  spooltype: "spoolType",
  "nozzle range min": "nozzleRangeMin",
  "nozzle range min (°c)": "nozzleRangeMin",
  "nozzle range max": "nozzleRangeMax",
  "nozzle range max (°c)": "nozzleRangeMax",
  "standby temp": "standbyTemp",
  "standby temp (°c)": "standbyTemp",
  // GH #379: "Variant Count" is derived/read-only and explicitly skipped.
  parent: "parentName",
  "parent name": "parentName",
  parentname: "parentName",
  "variant count": undefined,
  variantcount: undefined,
  // GH #954: OpenPrintTag color-arrangement + finish tags (comma-separated ids).
  tags: "optTags",
  "opt tags": "optTags",
  opttags: "optTags",
};

const NUM_FIELDS = new Set<keyof ImportRow>([
  "diameter",
  "cost",
  "density",
  "nozzleTemp",
  "nozzleFirstLayerTemp",
  "bedTemp",
  "bedFirstLayerTemp",
  "maxVolumetricSpeed",
  "spoolWeight",
  "netFilamentWeight",
  "dryingTemperature",
  "dryingTime",
  "transmissionDistance",
  "shoreHardnessA",
  "shoreHardnessD",
  "glassTempTransition",
  "heatDeflectionTemp",
  "minPrintSpeed",
  "maxPrintSpeed",
  "nozzleRangeMin",
  "nozzleRangeMax",
  "standbyTemp",
]);

function parseNum(val: unknown): number | null {
  if (val == null || val === "") return null;
  const n = Number(val);
  // GH #955: Number.isFinite rejects Infinity/-Infinity as well as NaN — a raw
  // isNaN check let "Infinity" through and persisted it (matches toFiniteNumber
  // in temperatureRange.ts).
  return Number.isFinite(n) ? n : null;
}

/**
 * GH #627: free-text string fields whose exported form may carry the
 * formula-injection guard apostrophe (CSV and XLSX exports both prefix `'`
 * to trigger-leading cells). Run through `unsanitizeCsvCell` on import so
 * `+95A TPU` (exported `'+95A TPU`) re-imports unchanged — otherwise the
 * apostrophe persists, the name misses the existing row, and the import
 * creates a corrupted duplicate. Mirrors `/api/spools/import`.
 *
 * Deliberately NOT applied to `color` / `secondaryColors` / `tdsUrl` — those
 * are format-validated (`#rrggbb`, http(s)://) and can never start with a
 * trigger character, so a genuine leading apostrophe survives untouched.
 */
const UNSANITIZE_FIELDS = new Set<keyof ImportRow>([
  "name",
  "vendor",
  // `type` is required free-text the exporter also prefixes (`+PLA` / `-CF`).
  "type",
  "colorName",
  "spoolType",
  "parentName",
  // `instanceId` is NOT strictly hex-validated — legacy/custom IDs starting
  // with a trigger get formula-prefixed on export, so it must be unstripped
  // symmetrically or it round-trips corrupted as `'...` (#679).
  "instanceId",
]);

export function mapHeaders(headers: string[]): (keyof ImportRow | null)[] {
  return headers.map((h) => {
    const key = HEADER_MAP[h.trim().toLowerCase()];
    return key ?? null;
  });
}

export function rowToImport(
  values: unknown[],
  mapping: (keyof ImportRow | null)[],
): ImportRow {
  const row: ImportRow = {};
  for (let i = 0; i < mapping.length; i++) {
    const key = mapping[i];
    if (!key) continue;
    const val = values[i];
    if (NUM_FIELDS.has(key)) {
      (row as Record<string, unknown>)[key] = parseNum(val);
    } else if (val == null || val === "") {
      (row as Record<string, unknown>)[key] = null;
    } else {
      const str = String(val);
      (row as Record<string, unknown>)[key] = UNSANITIZE_FIELDS.has(key)
        ? unsanitizeCsvCell(str)
        : str;
    }
  }
  return row;
}

export interface SkippedRow {
  row: number;
  name: string | undefined;
  reason: string;
}

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  skippedRows: SkippedRow[];
  /**
   * GH #605: per-row NON-FATAL notes — content a row's update refused to
   * apply while the row itself still imported (today: the template strip on
   * a name-matched EXISTING row). Distinct from `skippedRows` (whole-row
   * failures, counted in `skipped`); same optional shape as the `errors`
   * channel the atlas / INI / OpenPrintTag bulk importers surface. Present
   * only when non-empty.
   */
  errors?: string[];
}

/**
 * GH #628: scalar fields that participate in variant→parent inheritance —
 * the plain-scalar subset of `INHERITABLE_FIELDS` in
 * `src/lib/resolveFilament.ts` (keep in sync; `temperatures.*` dot-keys and
 * the `secondaryColors` array are handled separately below). Deliberately
 * covers the FULL set of inheritable scalars, not just the columns the
 * CSV/XLSX importer maps, because `splitInheritedImportSet` is shared with
 * the PrusaSlicer per-id sync route (which also writes
 * `shrinkageXY`/`shrinkageZ`); keys the CSV importer never emits are simply
 * absent from its `setBody`.
 */
const IMPORT_INHERITABLE_SCALARS = new Set<string>([
  "vendor",
  "type",
  "cost",
  "density",
  "diameter",
  "maxVolumetricSpeed",
  "spoolWeight",
  "netFilamentWeight",
  "dryingTemperature",
  "dryingTime",
  "transmissionDistance",
  "glassTempTransition",
  "heatDeflectionTemp",
  "shoreHardnessA",
  "shoreHardnessD",
  "shrinkageXY",
  "shrinkageZ",
  "minPrintSpeed",
  "maxPrintSpeed",
  "spoolType",
  "tdsUrl",
  // GH #951: `inherits` (PrusaSlicer preset-inheritance key) is inheritable
  // per resolveFilament and carried top-level by parseIniFilaments, so an
  // INI round-trip would otherwise pin the parent's echoed value onto a
  // variant. The CSV/XLSX importer maps no `inherits` column — no-op there.
  "inherits",
]);

/** Required by the Filament schema — never `$unset` on a variant (the
 *  write would fail validation). Same rule as `REQUIRED_FIELDS` in
 *  `src/lib/bambuStudioApply.ts` (keep in sync). */
const IMPORT_REQUIRED_FIELDS = new Set<string>(["vendor", "type"]);

/** Loosely-typed filament doc — same posture as resolveFilament. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LeanFilament = Record<string, any>;

/**
 * GH #628: the CSV/XLSX export flattens variants through `resolveFilament`,
 * so re-importing that flattened row onto an EXISTING variant used to `$set`
 * every value, pinning inherited fields as local overrides and severing the
 * GH #106 live-inheritance link. This helper splits the prepared `$set` body
 * for a variant row (same semantics as `setIfNotInherited` in
 * `src/lib/bambuStudioApply.ts`):
 *
 *   - incoming value equals the parent's value → SKIP the $set so the
 *     variant keeps inheriting dynamically at read time;
 *   - …and if the variant currently carries ANY local override of that field
 *     (divergent OR parent-equal — see GH #971 below), emit an `$unset` so
 *     inheritance resumes — except schema-required fields, left in place;
 *   - incoming value differs from the parent → $set normally.
 *
 * GH #971: when the incoming section reports a field EQUAL to the parent,
 * the export can't tell a deliberate pin from a true inherit — both
 * serialize to the same value — so the safe re-import default is to CLEAR
 * any variant-local override so it tracks the parent live. The `$unset`
 * fires on PRESENCE of a local override, not on divergence: a variant value
 * equal to the parent is still a stored pin that would block a future
 * parent edit.
 *
 * Array + nested handling:
 *   - `temperatures.*` dot-keys compare against the parent's same subfield
 *     (resolveFilament inherits each temp independently via `??`).
 *   - `secondaryColors` inherits as a WHOLE array (empty array = inherit);
 *     comparison is order-sensitive (order is meaningful for multi-color
 *     rendering).
 *   - `settings` inherits by SHALLOW PER-KEY merge — rebuilt to hold only
 *     keys that differ from the parent's. Runs only when the caller supplies
 *     the parent's settings; without them it writes through.
 *   - A variant-local value of `""` counts as "missing" (already
 *     inheriting), mirroring resolveFilament — it never triggers an $unset.
 *
 * Pure + exported for unit tests.
 */
export function splitInheritedImportSet(
  setBody: Record<string, unknown>,
  variant: LeanFilament,
  parent: LeanFilament,
): { set: Record<string, unknown>; unset: string[] } {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];

  const hasLocalValue = (v: unknown): boolean => v != null && v !== "";

  for (const [key, incoming] of Object.entries(setBody)) {
    if (key.startsWith("temperatures.")) {
      const sub = key.slice("temperatures.".length);
      const parentVal = parent.temperatures?.[sub] ?? null;
      const variantVal = variant.temperatures?.[sub] ?? null;
      if (incoming != null && parentVal === incoming) {
        // GH #971: clear ANY local override of a parent-equal subfield
        // (divergent OR parent-equal pin) so it inherits live.
        if (variantVal != null) unset.push(key);
        continue;
      }
      set[key] = incoming;
      continue;
    }

    if (key === "secondaryColors" && Array.isArray(incoming)) {
      const parentArr: unknown[] = Array.isArray(parent.secondaryColors)
        ? parent.secondaryColors
        : [];
      const variantArr: unknown[] = Array.isArray(variant.secondaryColors)
        ? variant.secondaryColors
        : [];
      const equalsArr = (a: unknown[], b: unknown[]) =>
        a.length === b.length && a.every((v, i) => v === b[i]);
      if (incoming.length > 0 && equalsArr(incoming, parentArr)) {
        // GH #971: the section reports the array equal to the parent's, so any
        // non-empty variant-local array is a pin (divergent OR parent-equal) —
        // clear it so the whole array inherits live.
        if (variantArr.length > 0) {
          unset.push(key);
        }
        continue;
      }
      set[key] = incoming;
      continue;
    }

    if (key === "settings" && incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
      // GH #951: `settings` inherits by SHALLOW PER-KEY merge, so a variant
      // that inherits a setting has the parent's value echoed back into the
      // incoming bag on a round-trip — treating it as pass-through would pin
      // those echoed keys and sever inheritance. Store only keys that DIFFER
      // from the parent; rebuilding the whole bag also self-heals a stale
      // variant key that now matches the parent. Without the parent's
      // settings supplied, write through.
      const parentSettings =
        parent.settings && typeof parent.settings === "object"
          ? (parent.settings as Record<string, unknown>)
          : null;
      if (!parentSettings) {
        set[key] = incoming;
        continue;
      }
      const filtered: Record<string, unknown> = {};
      // GH #678: array-aware equality via the shared settingValuesEqual —
      // an identity compare mis-judges array values.
      for (const [sk, sv] of Object.entries(incoming as Record<string, unknown>)) {
        if (!settingValuesEqual(parentSettings[sk], sv)) filtered[sk] = sv;
      }
      set[key] = filtered;
      continue;
    }

    if (IMPORT_INHERITABLE_SCALARS.has(key)) {
      const parentVal = parent[key];
      const variantVal = variant[key];
      if (incoming != null && parentVal === incoming) {
        if (IMPORT_REQUIRED_FIELDS.has(key)) {
          // Required fields (vendor/type) are never null on a variant and
          // never inherit at read time, so they can't be unset to "track the
          // parent". When incoming == parent but the stored value is stale,
          // still write the new value through — otherwise the variant keeps
          // a stale required value.
          if (variantVal !== incoming) set[key] = incoming;
          continue;
        }
        // GH #971: clear ANY local override of a parent-equal scalar (divergent
        // OR parent-equal pin) so a later parent edit propagates. Required
        // fields returned above; they never inherit and are never unset.
        if (hasLocalValue(variantVal)) {
          unset.push(key);
        }
        continue;
      }
      set[key] = incoming;
      continue;
    }

    // Variant-only / non-inheritable fields (name, color, colorName,
    // instanceId, …) always write through.
    set[key] = incoming;
  }

  return { set, unset };
}

/**
 * GH #951: the create/resurrect counterpart to `splitInheritedImportSet` —
 * the CREATE and RESURRECT paths wrote the whole flattened doc verbatim,
 * pinning every inherited field as a local override and severing GH #106
 * live inheritance exactly the way #628 fixed for updates.
 *
 * Returns a copy of the create doc with each inheritable field whose
 * incoming value equals the parent's reset to its "inherit" sentinel:
 * scalars + `temperatures.*` subfields → `null`; `secondaryColors` → `[]`
 * (order-sensitive comparison, matching splitInheritedImportSet). No
 * `$unset` step: a create/resurrect writes the whole document, so there is
 * no pre-existing divergent override to clear.
 *
 * Never touched: `vendor`/`type` (schema-required — resolveFilament never
 * inherits them) and the always-variant-specific `name`/`color`.
 *
 * Pure + exported for unit tests.
 */
export function pruneInheritedCreateDoc(
  doc: Record<string, unknown>,
  parent: LeanFilament,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc };

  for (const key of IMPORT_INHERITABLE_SCALARS) {
    if (IMPORT_REQUIRED_FIELDS.has(key)) continue;
    const incoming = out[key];
    if (incoming != null && incoming !== "" && incoming === parent[key]) {
      out[key] = null;
    }
  }

  // Temperatures ride the create doc as a NESTED object; compare each subfield
  // against the parent's same subfield (resolveFilament inherits each temp
  // independently via `??`).
  const temps = out.temperatures;
  if (temps && typeof temps === "object" && !Array.isArray(temps)) {
    const parentTemps = (parent.temperatures ?? {}) as Record<string, unknown>;
    const nextTemps: Record<string, unknown> = { ...(temps as Record<string, unknown>) };
    for (const sub of Object.keys(nextTemps)) {
      const val = nextTemps[sub];
      if (val != null && val === parentTemps[sub]) nextTemps[sub] = null;
    }
    out.temperatures = nextTemps;
  }

  // secondaryColors inherits as a WHOLE array (empty === inherit); drop it to
  // [] only when it matches the parent's array exactly (order-sensitive).
  if (Array.isArray(out.secondaryColors) && out.secondaryColors.length > 0) {
    const parentArr: unknown[] = Array.isArray(parent.secondaryColors)
      ? parent.secondaryColors
      : [];
    const incoming = out.secondaryColors as unknown[];
    if (
      parentArr.length === incoming.length &&
      incoming.every((v, i) => v === parentArr[i])
    ) {
      out.secondaryColors = [];
    }
  }

  // GH #954: optTags inherits as a WHOLE array too (empty === inherit), so a
  // create/resurrect variant whose exported (resolved) tags equal the parent's
  // must reset to [] rather than pin them — same rule as secondaryColors.
  if (Array.isArray(out.optTags) && out.optTags.length > 0) {
    const parentArr: unknown[] = Array.isArray(parent.optTags) ? parent.optTags : [];
    const incoming = out.optTags as unknown[];
    if (
      parentArr.length === incoming.length &&
      incoming.every((v, i) => v === parentArr[i])
    ) {
      out.optTags = [];
    }
  }

  return out;
}

// GH #605 / #1073: the first-variant adoption gate lives in
// src/lib/firstVariantGate.ts, shared with the INI + Bambu bulk phase-2
// resurrect paths (see its docblock for why color deliberately doesn't gate).

export async function upsertImportRows(
  inputRows: ImportRow[],
  /**
   * GH #1115: the PHYSICAL source line for each entry in `rows`, parallel by
   * index. Both routes strip blank rows before indexing, so deriving the
   * number positionally reported a row short by every blank line above it —
   * i.e. the row a user was told to fix was not the row that failed.
   *
   * Optional so every existing caller (and test) keeps the old derivation.
   */
  sourceLines?: number[],
): Promise<ImportResult> {
  await dbConnect();

  /** The line number to report for row `i`. */
  const lineOf = (i: number) => sourceLines?.[i] ?? i + 2;

  // GH #1116: trim the NAME the importer matches on. The schema trims `name`
  // on write, so the importer has to agree or a legacy export re-imported
  // after the migration would miss its own row and take the CREATE path —
  // a duplicate. (`csvCell` quotes edge whitespace, so an untrimmed legacy
  // name survives a round-trip verbatim; that fidelity is what makes this
  // trim load-bearing rather than cosmetic.) Rows are copied rather than
  // mutated: the caller owns the array, and the two-pass driver plus
  // `sourceLines` both key on INDEX, which a 1:1 map preserves. A
  // whitespace-only name collapses to "" and is caught by the
  // missing-required-field check. Trimming here means the name we match on,
  // store, and quote in a skip reason are one value.
  const rows = inputRows.map((r) =>
    typeof r.name === "string" && r.name !== r.name.trim()
      ? { ...r, name: r.name.trim() }
      : r,
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const skippedRows: SkippedRow[] = [];
  // Per-row non-fatal notes (see ImportResult.errors), collected with their
  // row number so the report sorts back into original-row order despite the
  // two-pass driver visiting rows out of order — same treatment skippedRows
  // gets.
  const noteRows: { row: number; note: string }[] = [];

  // Batch-load all existing filaments by name (avoids N+1). GH #379: also
  // include every Parent value — a variant row's parent may not itself be an
  // import row — and project `parentId` so the parent-validity check can
  // reject a parentName pointing at a row that's itself a variant.
  const namesToLoad = new Set<string>();
  for (const r of rows) {
    if (r.name && r.vendor && r.type) namesToLoad.add(r.name);
    if (r.parentName) {
      const trimmed = r.parentName.trim();
      if (trimmed) namesToLoad.add(trimmed);
    }
  }

  // GH #628: the projection includes the inheritable fields (scalars +
  // temperatures + secondaryColors) so the variant-update path can compare
  // incoming values against the variant's current local values without a
  // second fetch. Heavy subdocuments (spools — photoDataUrl can be MBs)
  // stay excluded.
  const INHERITANCE_PROJECTION =
    "_id name parentId _deletedAt _purged vendor type cost density diameter " +
    "maxVolumetricSpeed spoolWeight netFilamentWeight dryingTemperature " +
    "dryingTime transmissionDistance glassTempTransition heatDeflectionTemp " +
    "shoreHardnessA shoreHardnessD shrinkageXY shrinkageZ minPrintSpeed " +
    "maxPrintSpeed spoolType tdsUrl inherits temperatures secondaryColors optTags";

  const allExisting = await Filament.find({ name: { $in: [...namesToLoad] } })
    .select(INHERITANCE_PROJECTION)
    .lean();

  // GH #1116: ALSO find stored rows whose TRIMMED name matches — with the
  // RAW DRIVER, the only thing that can see them. `trimEntityNames` can
  // legitimately leave a row untrimmed, and such a row is invisible to every
  // Mongoose query because a String schema setter applies to QUERY values
  // too — the `$in` above is itself trimmed, so it asks for `"PLA"` and
  // never matches a stored `"PLA "`.
  //
  // The predicate is on the STORED value, not the input's spelling —
  // whatever whitespace either side carries, the question is the one the
  // schema asks: do the trimmed forms match. (Filtering the INPUT for
  // untrimmed names missed the ordinary case: canonical `"PLA"` against a
  // surviving `"PLA "` produced no candidates and created a duplicate.)
  //
  // Only names the indexed lookup did NOT resolve, so the healthy path adds
  // nothing. `$expr` can't use the index, so this is a scan — acceptable on
  // an explicit, batch, user-initiated import versus a silent duplicate.
  //
  // Collisions resolve explicitly: the index below keys on the TRIMMED name
  // and prefers a row stored exactly that way, so a canonical row always
  // wins. ACTIVE matches only — a tombstone is not a match here: counting a
  // soft-deleted `"PLA"` as "found" would skip the scan and resurrect it
  // beside an active `"PLA "`, exactly the duplicate this exists to prevent.
  const alreadyFound = new Set(
    (allExisting as unknown as LeanFilament[])
      .filter((d) => d._deletedAt == null)
      .map((d) => String(d.name ?? "").trim()),
  );
  const stillMissing = [...namesToLoad].filter((n) => !alreadyFound.has(n.trim()));
  if (stillMissing.length > 0) {
    const projection: Record<string, 1> = {};
    for (const field of INHERITANCE_PROJECTION.split(/\s+/)) {
      if (field) projection[field] = 1;
    }
    const untrimmed = (await Filament.collection
      .find(trimmedNameFilter(stillMissing), { projection })
      .toArray()) as unknown as LeanFilament[];
    const seen = new Set(
      (allExisting as unknown as LeanFilament[]).map((d) => String(d._id)),
    );
    const extra = untrimmed.filter((doc) => !seen.has(String(doc._id)));
    if (extra.length > 0) {
      (allExisting as unknown as LeanFilament[]).push(...extra);
    }
  }

  // The same map carries existing rows AND filaments created earlier in
  // this same import batch — pass-2 (variant rows) resolves the `Parent`
  // column against it, so an export → reimport works even when the parent
  // row only exists because pass 1 just created it.
  type IndexEntry = {
    _id: mongoose.Types.ObjectId;
    parentId: mongoose.Types.ObjectId | null;
    /** GH #628: the projected lean doc, when this entry came from the
     *  batch-load (in-batch created/resurrected entries omit it — the
     *  inherited-field skip then falls back to plain $set, which only
     *  matters for the degenerate duplicate-name-in-one-file case). */
    doc?: LeanFilament;
  };
  const activeByName = new Map<string, IndexEntry>();
  const deletedByName = new Map<string, IndexEntry>();
  for (const doc of allExisting) {
    const entry: IndexEntry = {
      _id: doc._id,
      parentId: doc.parentId ?? null,
      doc,
    };
    // GH #1116: index by the TRIMMED name — keeps this side honest if the
    // lookup ever moves to the raw driver (several hot paths already have).
    // When both `"X"` and `"X "` somehow survive, the exactly-named one wins
    // the slot: it is the row every other lookup resolves to.
    const key = doc.name.trim();
    if (doc._deletedAt == null) {
      if (!activeByName.has(key) || doc.name === key) activeByName.set(key, entry);
    } else if (doc._purged !== true && !deletedByName.has(key)) {
      // GH #1004 F1: _purged tombstones land in NEITHER bucket. They are
      // one-way gone-forever markers (see the permanent-delete handler +
      // the sync engine's _purged short-circuit) — resurrecting one via
      // re-import produced an active row still flagged _purged: a "zombie"
      // that poisons hybrid sync and, once re-trashed, skips the trash
      // listing entirely. A purged name simply falls through to the create
      // path, which the partial-unique index (scoped to _deletedAt: null)
      // permits.
      deletedByName.set(key, entry);
    }
  }

  // GH #628: batch-load the PARENT docs of every existing active variant we
  // might update — a variant's parent is referenced by id and may not appear
  // in the import file at all. Must be RELOADED after pass 1 (GH #649): if a
  // parent row updated its own value in pass 1, pass 2 must compare the
  // variant's incoming value against the NEW parent value, or a bulk restore
  // that changes the parent gets written as a local override on the variant
  // (severing GH #106 inheritance). Recomputing the id set after pass 1 also
  // picks up parents resurrected into `activeByName` during pass 1.
  const parentById = new Map<string, LeanFilament>();
  async function loadParentDocs() {
    parentById.clear();
    const ids = new Set<string>();
    for (const entry of activeByName.values()) {
      if (entry.parentId) ids.add(String(entry.parentId));
    }
    if (ids.size === 0) return;
    const parentDocs = await Filament.find({
      _id: { $in: [...ids] },
      _deletedAt: null,
    })
      .select(INHERITANCE_PROJECTION)
      .lean();
    for (const p of parentDocs) parentById.set(String(p._id), p);
  }
  // Initial load covers pass-1 variant updates: an existing variant whose
  // import row omits the Parent column is routed to pass 1 and still needs
  // its parent for the inheritance split. Pass 2 gets a fresh reload below.
  await loadParentDocs();

  // Share ONE trim between the two-pass router and processRow: if routing
  // used raw `row.parentName` while processRow trimmed, a whitespace-only
  // Parent cell would route a real standalone to pass 2, and any variant
  // referencing that row's name would skip with a misleading "Parent not
  // found".
  function trimmedParentName(row: ImportRow): string {
    return row.parentName ? row.parentName.trim() : "";
  }

  async function processRow(rowIdx: number): Promise<void> {
    const row = rows[rowIdx];
    if (!row.name || !row.vendor || !row.type) {
      const missing = [
        !row.name && "name",
        !row.vendor && "vendor",
        !row.type && "type",
      ].filter(Boolean).join(", ");
      skippedRows.push({ row: lineOf(rowIdx), name: row.name, reason: `Missing required field(s): ${missing}` });
      skipped++;
      return;
    }

    const existing = activeByName.get(row.name);
    const softDeleted = !existing ? deletedByName.get(row.name) : undefined;

    // GH #379: resolve the optional Parent column — honoured ONLY on
    // create/resurrect (see ImportRow.parentName). Self-references are
    // blocked outright.
    let resolvedParentId: mongoose.Types.ObjectId | null = null;
    const parentName = trimmedParentName(row);
    if (parentName && !existing) {
      if (parentName === row.name) {
        skippedRows.push({
          row: lineOf(rowIdx),
          name: row.name,
          reason: `Parent cannot reference self`,
        });
        skipped++;
        return;
      }
      const parentEntry = activeByName.get(parentName);
      if (!parentEntry) {
        skippedRows.push({
          row: lineOf(rowIdx),
          name: row.name,
          reason: `Parent "${parentName}" not found among active filaments`,
        });
        skipped++;
        return;
      }
      if (parentEntry.parentId) {
        skippedRows.push({
          row: lineOf(rowIdx),
          name: row.name,
          reason: `Parent "${parentName}" is itself a variant — variants-of-variants are not allowed`,
        });
        skipped++;
        return;
      }
      resolvedParentId = parentEntry._id;
    }

    // Build the update doc using only fields actually present in the import
    // row, so a CSV without those columns can't overwrite existing data with
    // nulls. GH #183: `color`/`diameter` must NOT be set with defaults —
    // only attach them when the row supplied them; the create path's
    // schema-level defaults still cover missing fields.
    const doc: Record<string, unknown> = {
      name: row.name,
      vendor: row.vendor,
      type: row.type,
    };
    if (row.color !== undefined && row.color !== "" && row.color !== null) {
      // GH #503: without this per-row guard the schema validator on `color`
      // would throw on the bulk save() and lose the WHOLE batch's accounting
      // rather than the one bad row.
      if (!/^#[0-9A-Fa-f]{6}$/.test(String(row.color))) {
        skippedRows.push({
          row: lineOf(rowIdx),
          name: row.name,
          reason: `Invalid color hex "${row.color}" (expected #RRGGBB)`,
        });
        skipped++;
        return;
      }
      doc.color = row.color;
    }
    // GH #477: parse the "Secondary Colors" column — per-entry hex
    // validation + the 5-cap, so the importer produces a clean doc rather
    // than a bulk-import row that fails save.
    if (row.secondaryColors !== undefined && row.secondaryColors !== null) {
      const raw = String(row.secondaryColors).trim();
      if (raw !== "") {
        const slots = raw
          .split(",")
          .map((c) => c.trim())
          .filter((c) => /^#[0-9A-Fa-f]{6}$/.test(c))
          .slice(0, 5);
        if (slots.length > 0) {
          doc.secondaryColors = slots;
          // GH #477: preserve null primary for coextruded CSV round-trips —
          // an empty Color cell + populated secondaries must set an explicit
          // `null`, or the schema default "#808080" re-introduces a phantom
          // gray primary.
          if (row.color === null || row.color === "" || row.color === undefined) {
            doc.color = null;
          }
        }
      }
    }
    // GH #954: parse the "Tags" column into a numeric array. Honoured on
    // CREATE/RESURRECT only — the update path deletes it below. A
    // PRESENT-but-empty cell maps to [] (not skipped), so re-importing a
    // solid/untagged row CLEARS a tombstone's tags on resurrect. Empty
    // tokens are dropped BEFORE Number() so a trailing/double comma
    // ("28,16," / "28,,16") can't become `Number("") === 0` and add a
    // phantom tag 0 (glass-fiber).
    if (row.optTags !== undefined) {
      doc.optTags =
        row.optTags == null
          ? []
          : [
              ...new Set(
                String(row.optTags)
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter((tag) => tag !== "")
                  .map(Number)
                  .filter((n) => Number.isInteger(n) && n >= 0),
              ),
            ];
    }
    if (row.diameter !== undefined && row.diameter !== null) {
      doc.diameter = row.diameter;
    }

    // Only set optional scalar fields if they were explicitly provided
    if (row.cost !== undefined) doc.cost = row.cost ?? null;
    if (row.density !== undefined) doc.density = row.density ?? null;
    if (row.maxVolumetricSpeed !== undefined) doc.maxVolumetricSpeed = row.maxVolumetricSpeed ?? null;
    if (row.spoolWeight !== undefined) doc.spoolWeight = row.spoolWeight ?? null;
    if (row.netFilamentWeight !== undefined) doc.netFilamentWeight = row.netFilamentWeight ?? null;
    if (row.dryingTemperature !== undefined) doc.dryingTemperature = row.dryingTemperature ?? null;
    if (row.dryingTime !== undefined) doc.dryingTime = row.dryingTime ?? null;
    if (row.transmissionDistance !== undefined) doc.transmissionDistance = row.transmissionDistance ?? null;
    if (row.glassTempTransition !== undefined) doc.glassTempTransition = row.glassTempTransition ?? null;
    if (row.heatDeflectionTemp !== undefined) doc.heatDeflectionTemp = row.heatDeflectionTemp ?? null;
    if (row.shoreHardnessA !== undefined) doc.shoreHardnessA = row.shoreHardnessA ?? null;
    if (row.shoreHardnessD !== undefined) doc.shoreHardnessD = row.shoreHardnessD ?? null;
    if (row.minPrintSpeed !== undefined) doc.minPrintSpeed = row.minPrintSpeed ?? null;
    if (row.maxPrintSpeed !== undefined) doc.maxPrintSpeed = row.maxPrintSpeed ?? null;
    if (row.colorName !== undefined) doc.colorName = row.colorName ?? null;
    if (row.spoolType !== undefined) doc.spoolType = row.spoolType ?? null;
    // GH #951: nozzleRangeMin/Max/standby ride the nested `temperatures` object
    // (create/resurrect) and the temps loop's dotted `$set` (update) below —
    // they must NOT also be added as dotted keys on `doc`. On create the dotted
    // key overrode the nested null that `pruneInheritedCreateDoc` writes,
    // re-pinning an inherited range temp on a variant; on resurrect the dotted
    // key + nested object collided in one `updateOne` (MongoDB code 40
    // "would create a conflict at 'temperatures'"), failing the whole row.
    if (row.tdsUrl !== undefined) doc.tdsUrl = row.tdsUrl ?? null;
    if (row.instanceId) doc.instanceId = row.instanceId;

    // Only set temperature sub-fields that were present in the import
    const temps: Record<string, number | null> = {};
    if (row.nozzleTemp !== undefined) temps.nozzle = row.nozzleTemp ?? null;
    if (row.nozzleFirstLayerTemp !== undefined) temps.nozzleFirstLayer = row.nozzleFirstLayerTemp ?? null;
    if (row.bedTemp !== undefined) temps.bed = row.bedTemp ?? null;
    if (row.bedFirstLayerTemp !== undefined) temps.bedFirstLayer = row.bedFirstLayerTemp ?? null;
    if (row.nozzleRangeMin !== undefined) temps.nozzleRangeMin = row.nozzleRangeMin ?? null;
    if (row.nozzleRangeMax !== undefined) temps.nozzleRangeMax = row.nozzleRangeMax ?? null;
    if (row.standbyTemp !== undefined) temps.standby = row.standbyTemp ?? null;

    if (existing) {
      // Updates use dot-notation for temperatures to avoid overwriting
      // sub-fields that weren't in the import.
      const updateDoc = { ...doc };
      delete updateDoc.temperatures;
      // GH #954: drop `optTags` from the update `$set` so a re-import can't
      // re-pin a variant's tags (would need the same whole-array inheritance
      // split secondaryColors gets).
      delete updateDoc.optTags;
      let $set: Record<string, unknown> = { ...updateDoc };
      for (const [tempKey, tempVal] of Object.entries(temps)) {
        $set[`temperatures.${tempKey}`] = tempVal;
      }
      // GH #628: when the target is a VARIANT, split the $set so parent-equal
      // values don't pin as local overrides (see splitInheritedImportSet).
      const update: Record<string, unknown> = {};
      const parentDoc = existing.parentId
        ? parentById.get(String(existing.parentId))
        : undefined;
      if (parentDoc && existing.doc) {
        const split = splitInheritedImportSet($set, existing.doc, parentDoc);
        $set = split.set;
        if (split.unset.length > 0) {
          update.$unset = Object.fromEntries(split.unset.map((k) => [k, ""]));
        }
      }
      update.$set = $set;
      // GH #605: a name-matched EXISTING row may be a TEMPLATE (≥1 live
      // variant) — a CSV row echoes the promoted-away color/colorName back
      // verbatim, and blindly $set-ing them would re-materialize per-variant
      // state on the template. Strip the shared TEMPLATE_STRIP_FIELDS with
      // the PUT's semantics (non-null only; an explicit null — an EMPTY
      // Color Name cell — still passes as legitimate cleanup). Decision +
      // write MUST share the per-filament mutex the promotion paths lock;
      // the parent-gate lock only covers the create/resurrect branch below,
      // so this plain-update path needs its own. The strip never fails the
      // row — it's reported as a per-row note on the `errors` channel.
      //
      // GH #276: runValidators so a CSV updating an existing filament
      // (e.g. `cost = -50`) can't bypass the schema validators.
      const stripped = await runExclusive(
        filamentLockKey(existing._id),
        async () => {
          const strippedFields = await stripTemplateFieldsForWrite(
            Filament,
            existing._id,
            $set,
          );
          await Filament.updateOne(
            { _id: existing._id },
            update,
            { runValidators: true, context: "query" },
          );
          return strippedFields;
        },
      );
      if (stripped.length > 0) {
        noteRows.push({
          row: lineOf(rowIdx),
          note: `Row ${lineOf(rowIdx)} "${row.name}": skipped ${stripped.join(", ")} — the local filament is a template (inventory and color live on its variants)`,
        });
      }
      updated++;
    } else {
      // Creates/resurrections include temperatures as a nested object.
      if (Object.keys(temps).length > 0) {
        doc.temperatures = {
          nozzle: temps.nozzle ?? null,
          nozzleFirstLayer: temps.nozzleFirstLayer ?? null,
          bed: temps.bed ?? null,
          bedFirstLayer: temps.bedFirstLayer ?? null,
          nozzleRangeMin: temps.nozzleRangeMin ?? null,
          nozzleRangeMax: temps.nozzleRangeMax ?? null,
          standby: temps.standby ?? null,
        };
      }
      if (resolvedParentId) doc.parentId = resolvedParentId;

      // GH #951: create/resurrect inheritance parity with the UPDATE path
      // (see pruneInheritedCreateDoc). The effective parent after a resurrect
      // is `resolvedParentId ?? softDeleted.parentId` — parentId only rides
      // `doc` when a Parent column was supplied.
      let writeDoc = doc;
      const createParentId = softDeleted
        ? resolvedParentId ?? softDeleted.parentId
        : resolvedParentId;
      if (createParentId) {
        // `parentById` indexes the parents of EXISTING active variants, so it
        // won't hold a parent freshly created earlier in THIS batch — fall
        // back to a direct fetch. A missing/soft-deleted parent → nothing to
        // inherit → write the doc as-is.
        let parentDoc = parentById.get(String(createParentId));
        if (!parentDoc) {
          parentDoc =
            (await Filament.findOne({ _id: createParentId, _deletedAt: null })
              .select(INHERITANCE_PROJECTION)
              .lean()) ?? undefined;
        }
        if (parentDoc) writeDoc = pruneInheritedCreateDoc(doc, parentDoc);
      }

      // Captured as a narrowed const: the `!row.name` early-return above
      // proves it's a string, but that property narrowing doesn't survive
      // into the closure below.
      const rowName = row.name;
      const performWrite = async (): Promise<void> => {
        if (softDeleted) {
          // GH #228: runValidators — without it every schema-level validator
          // (`cost.min`, type coercions) was bypassed and a malformed
          // re-import of a trashed row could persist invalid numeric fields.
          // GH #1004 F1 (race belt-and-suspenders): the bucketing above
          // already excludes _purged tombstones, but a permanent delete can
          // land BETWEEN the batch load and this row's write. Guard the
          // filter so the resurrect can never revive a purge tombstone; a
          // zero-match falls through to the create path below instead of
          // incrementing `updated` against a write that matched nothing.
          const res = await Filament.updateOne(
            { _id: softDeleted._id, _purged: { $ne: true } },
            { ...writeDoc, _deletedAt: null },
            { runValidators: true, context: "query" },
          );
          if (res.matchedCount === 0) {
            // The tombstone was purged mid-import — mint a fresh doc (the
            // partial-unique name index permits it; the purged row keeps its
            // gone-forever state). writeDoc may have been pruned against the
            // TOMBSTONE's parent, but this fallback creates a STANDALONE
            // whenever no Parent column was supplied — a standalone has no
            // parent to inherit the pruned fields from, so creating from the
            // pruned doc would drop every flattened CSV value that matched
            // the old parent to null/[]. Use the UNPRUNED doc in that case;
            // keep the pruned writeDoc only when the created row is actually
            // a variant.
            const createDoc = resolvedParentId ? writeDoc : doc;
            const newDoc = await Filament.create(createDoc);
            activeByName.set(rowName, { _id: newDoc._id, parentId: resolvedParentId });
            deletedByName.delete(rowName);
            created++;
          } else {
            // GH #379: re-promote into activeByName so a later pass-2 row
            // referencing this name as Parent resolves correctly — including
            // its effective parentId, or a pass-2 row pointing at this
            // resurrected row would wrongly skip the variant-of-variant
            // guard.
            const effectiveParentId = resolvedParentId ?? softDeleted.parentId;
            activeByName.set(rowName, { _id: softDeleted._id, parentId: effectiveParentId });
            deletedByName.delete(rowName);
            updated++;
          }
        } else {
          const newDoc = await Filament.create(writeDoc);
          // GH #379: seed activeByName so a later pass-2 row referencing this
          // fresh row as Parent resolves in-batch (parent + variant rows in
          // the same CSV).
          activeByName.set(rowName, { _id: newDoc._id, parentId: resolvedParentId });
          created++;
        }
      };

      // GH #605: when this row's write surfaces a live VARIANT (create with a
      // resolved Parent column, or resurrect of a trashed variant), gate it
      // on the parent's held INVENTORY (see firstVariantGateInfo for why
      // color deliberately doesn't gate) and run the decision + write inside
      // the same per-parent mutex the interactive promotion gate locks. A
      // bulk import can't confirm a promotion, so a gated row SKIPS with a
      // per-row reason rather than silently minting the mixed
      // template-with-inventory state #605 forbids.
      if (createParentId) {
        const gateReason = await runExclusive(
          filamentLockKey(createParentId),
          async (): Promise<string | null> => {
            const gate = await firstVariantGateInfo(Filament, createParentId);
            if (gate.reason) return gate.reason;
            await performWrite();
            // An ungated first variant of a threshold-ONLY parent just
            // surfaced — clear the now-dead lowStockThreshold AFTER the
            // write (parent state change last), still inside the per-parent
            // lock. Re-checking hasVariants (rather than trusting the
            // pre-write snapshot) covers the purged-tombstone fallback,
            // which can create a STANDALONE when no Parent column was
            // supplied — no variant surfaced there, so the threshold stays.
            if (
              gate.orphanedThreshold &&
              (await hasVariants(Filament, String(createParentId)))
            ) {
              await clearOrphanedParentThreshold(Filament, createParentId);
            }
            return null;
          },
        );
        if (gateReason) {
          skippedRows.push({ row: lineOf(rowIdx), name: row.name, reason: gateReason });
          skipped++;
          return;
        }
      } else {
        await performWrite();
      }
    }
  }

  // GH #627: per-row error isolation. Any error escaping a row's
  // create/update — an E11000 from the partial-unique `instanceId` index
  // (e.g. re-importing an export after renaming a filament, so the name
  // misses but the carried Instance ID collides), a ValidationError, a
  // transient driver error — must not abort the WHOLE batch with a bare 500
  // and no report of the rows already committed. Route it into skippedRows,
  // with a named reason for duplicate-key errors (mirrors the spool
  // importer's GH #370 per-row posture).
  function importErrorReason(err: unknown): string {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === 11000
    ) {
      const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue;
      const field = keyValue ? Object.keys(keyValue)[0] : "field";
      const value = keyValue ? Object.values(keyValue)[0] : "unknown";
      return `Duplicate ${field}: "${value}" already exists`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  async function processRowSafe(rowIdx: number): Promise<void> {
    try {
      await processRow(rowIdx);
    } catch (err) {
      skippedRows.push({
        row: lineOf(rowIdx),
        name: rows[rowIdx].name,
        reason: importErrorReason(err),
      });
      skipped++;
    }
  }

  // GH #379: two-pass driver. Rows without a Parent column run first so any
  // new top-level filaments are present in `activeByName` by the time pass 2
  // (variant rows) tries to resolve them. Uses the same trimmed view of the
  // cell as processRow so a whitespace-only Parent resolves to pass 1. The
  // skipped report is sorted at the end to preserve original-row order.
  for (let i = 0; i < rows.length; i++) {
    if (!trimmedParentName(rows[i])) await processRowSafe(i);
  }
  // GH #649: refresh parent values written during pass 1 before the variant
  // rows compare against them in pass 2.
  await loadParentDocs();
  for (let i = 0; i < rows.length; i++) {
    if (trimmedParentName(rows[i])) await processRowSafe(i);
  }
  skippedRows.sort((a, b) => a.row - b.row);
  noteRows.sort((a, b) => a.row - b.row);

  return {
    total: rows.length,
    created,
    updated,
    skipped,
    skippedRows,
    // Optional-when-empty, matching the errors shape the sibling bulk
    // importers (atlas / INI / OpenPrintTag) return.
    ...(noteRows.length > 0 ? { errors: noteRows.map((n) => n.note) } : {}),
  };
}

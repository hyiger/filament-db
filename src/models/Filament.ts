import crypto from "crypto";
import mongoose, { Schema, Document, Model, AnyBulkWriteOperation } from "mongoose";
import { isEncodableOptTag } from "@/lib/openprinttag";
import { MAX_SPOOL_TEXT_LENGTH } from "@/lib/validateSpoolBody";

/** Random 5-byte hex instance ID (10 hex chars), matching Prusament's format.
 * Exported so the spool-create routes that write via `$push` — which
 * bypasses Mongoose schema defaults — can stamp a spool `instanceId` explicitly. */
export function generateInstanceId(): string {
  return crypto.randomBytes(5).toString("hex");
}

/** Reject anything but http(s). Empty/null are allowed (field is optional).
 * Shared by the schema validator and the pre-update hooks below. */
function isValidTdsUrl(v: string | null | undefined): boolean {
  if (v == null || v === "") return true;
  try {
    const proto = new URL(v).protocol;
    return proto === "http:" || proto === "https:";
  } catch {
    return false;
  }
}

/** The one hex shape we store for colors. Shared by the schema validators
 * on `color` / `secondaryColors` AND the pre-update hooks below. */
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** `color` is nullable per the OpenPrintTag spec (coextruded materials
 * have a null primary); anything non-null must be `#RRGGBB`. */
function isValidColor(v: unknown): boolean {
  return v == null || (typeof v === "string" && HEX_COLOR_RE.test(v));
}

/** GH #634: optTags entries are CBOR unsigned ints on the wire — a
 * negative entry makes the encoder throw, a fractional one would silently
 * encode a different tag id, and a value above 2^32-1 truncates to its low
 * 32 bits in the encoder's `>>>` arithmetic.
 * Sanitize on assignment rather than with a rejecting validator: a hard
 * validator would block ANY later `save()` on a legacy doc that already
 * carries a bad tag (e.g. the print-history / spool-usage paths, which
 * save without touching optTags). `isEncodableOptTag` is shared with
 * the encoder so the schema and the wire agree on what's kept. */
function sanitizeOptTags(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isEncodableOptTag);
}

export interface IDryCycle {
  _id?: mongoose.Types.ObjectId;
  date: Date;
  tempC: number | null;
  durationMin: number | null;
  notes: string;
}

export interface IUsageEntry {
  _id?: mongoose.Types.ObjectId;
  /** Grams consumed on this event. Always positive; a refill is a separate entry type. */
  grams: number;
  /** Free-form job label: slicer filename, "calibration", printer name, etc. */
  jobLabel: string;
  date: Date;
  /**
   * Origin of the entry: "manual" = logged directly on the spool UI (NOT
   * via /api/print-history); "slicer"/"job" = via /api/print-history
   * ("job" covers a user-posted "manual" job); "nfc" = written by an NFC
   * read. Analytics treats "job" + "slicer" as already accounted for via
   * PrintHistory records, so it only picks up "manual" entries from the
   * fallback loop.
   */
  source: "manual" | "slicer" | "job" | "nfc";
  /**
   * For entries created by `POST /api/print-history`, the _id of the
   * matching PrintHistory document. The undo path (`DELETE
   * /api/print-history/{id}`) uses this to find exactly which spool
   * usageHistory entries to refund — matching by `(grams, date)` alone
   * removes the wrong entry when a manual log shares both.
   *
   * Always null for `manual`/`nfc` entries (no PrintHistory record exists).
   */
  jobId: mongoose.Types.ObjectId | null;
  /**
   * GH #1074: grams ACTUALLY removed from the spool when this entry was
   * created by `POST /api/print-history` — `min(spool.totalWeight, grams)`
   * at debit time (the debit clamps at zero). Mirrors the same field on
   * the PrintHistory usage row, which is what the DELETE refund reads.
   * Null for manual/nfc entries and for job entries created before the
   * field existed.
   */
  debitedGrams?: number | null;
}

export interface ISpool {
  _id: mongoose.Types.ObjectId;
  /** #732: per-spool 5-byte hex id (10 hex chars), auto-generated; a
   * Prusa-assigned spool id can be entered manually. This is the spool-level
   * identity used by labels / NFC / match — it supersedes the filament-level
   * instanceId. Labels/tags created before the per-spool migration carry the
   * FILAMENT-level id, so the matcher MUST resolve `spools[].instanceId`
   * first and then FALL BACK to the filament-level `instanceId`; dropping
   * that fallback would orphan every transition-era label/tag. */
  instanceId: string;
  label: string;
  totalWeight: number | null;
  lotNumber: string | null;
  purchaseDate: Date | null;
  openedDate: Date | null;
  createdAt: Date;
  /** ObjectId of the Location this spool lives in; null = unassigned. */
  locationId: mongoose.Types.ObjectId | null;
  /** Base64 data URL for a user-uploaded photo. Capped client-side at ~200KB. */
  photoDataUrl: string | null;
  /** Retired spools drop out of inventory counts, PrusaSlicer spool-check, and
   * the main spool list, but their history is preserved. */
  retired: boolean;
  /** Log of dry-box cycles. Supports "last dried N days ago" reminders. */
  dryCycles: IDryCycle[];
  /** Ledger of grams consumed, for usage analytics. */
  usageHistory: IUsageEntry[];
}

export interface IBedTypeTemp {
  bedType: string;         // e.g. "Hot Plate", "Textured PEI", "Cool Plate", "Engineering Plate"
  temperature: number | null;
  firstLayerTemperature: number | null;
}

export interface IFilament extends Document {
  name: string;
  syncId: string | null;
  instanceId: string;
  vendor: string;
  type: string;
  /** Primary color hex (#RRGGBB). GH #477: per OpenPrintTag spec key 19
   *  this MAY be null for filaments without a single primary color
   *  (coextruded, rainbow). Most UI surfaces use `displayColor()` from
   *  src/lib/filamentColors.ts to fall back to secondaryColors[0] when
   *  this is null. */
  color: string | null;
  /** GH #477: OpenPrintTag spec keys 20–24 (`secondary_color_0..4`). Max 5
   *  entries, each `#RRGGBB`. Treated as an array-fallback inheritable
   *  field by `resolveFilament`. */
  secondaryColors: string[];
  colorName: string | null;
  cost: number | null;
  density: number | null;
  diameter: number;
  temperatures: {
    nozzle: number | null;
    nozzleFirstLayer: number | null;
    nozzleRangeMin: number | null;
    nozzleRangeMax: number | null;
    bed: number | null;
    bedFirstLayer: number | null;
    standby: number | null;
  };
  bedTypeTemps: IBedTypeTemp[];
  maxVolumetricSpeed: number | null;
  compatibleNozzles: mongoose.Types.ObjectId[];
  calibrations: {
    printer: mongoose.Types.ObjectId | null;
    nozzle: mongoose.Types.ObjectId;
    bedType: mongoose.Types.ObjectId | null;
    extrusionMultiplier: number | null;
    maxVolumetricSpeed: number | null;
    pressureAdvance: number | null;
    retractLength: number | null;
    retractSpeed: number | null;
    retractLift: number | null;
    nozzleTemp: number | null;
    nozzleTempFirstLayer: number | null;
    bedTemp: number | null;
    bedTempFirstLayer: number | null;
    chamberTemp: number | null;
    fanMinSpeed: number | null;
    fanMaxSpeed: number | null;
    fanBridgeSpeed: number | null;
  }[];
  presets: {
    label: string;
    extrusionMultiplier: number | null;
    temperatures: {
      nozzle: number | null;
      nozzleFirstLayer: number | null;
      bed: number | null;
      bedFirstLayer: number | null;
    };
  }[];
  spools: ISpool[];
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  totalWeight: number | null;
  /** Grams remaining across all non-retired spools below which this filament
   * shows a low-stock indicator on the dashboard and list. Null = disabled. */
  lowStockThreshold: number | null;
  dryingTemperature: number | null;
  /** Drying time in MINUTES (480 = 8 hours). The form input, CSV export header,
   * and NfcReadDialog all assume minutes; TDS extractor converts hours→minutes
   * at the boundary. Rendering this with an "h" suffix is a display bug
   * against this canonical unit. */
  dryingTime: number | null;
  transmissionDistance: number | null;
  glassTempTransition: number | null;
  heatDeflectionTemp: number | null;
  shoreHardnessA: number | null;
  shoreHardnessD: number | null;
  shrinkageXY: number | null;
  shrinkageZ: number | null;
  minPrintSpeed: number | null;
  maxPrintSpeed: number | null;
  spoolType: string | null;
  optTags: number[];
  tdsUrl: string | null;
  inherits: string | null;
  parentId: mongoose.Types.ObjectId | null;
  settings: Record<string, string | string[] | null>;
  /**
   * GH #605: the durable parent-side promotion marker. A parent promotion
   * (performParentPromotion in src/lib/promoteParent.ts) stamps
   * `{ token, at }` here as its FIRST, non-destructive step; the final
   * parent write clears it atomically with the moved fields. A resume of an
   * interrupted promotion requires PROOF — this marker plus a live variant
   * whose `promotedByToken` equals `token` — never inference from names or
   * value equality (which could adopt a legitimate lookalike child and lose
   * an inventory record). Server-owned: every client-facing write path
   * strips it (like `syncId` / `openprinttagSnapshot`); only the promotion
   * protocol writes it. Whole-doc copies (hybrid sync, snapshot
   * backup/restore) carry it verbatim like `syncId` — the next gate or
   * /promote pass completes or lazily clears it.
   */
  promotionInFlight: { token: string; at: Date } | null;
  /**
   * GH #605: the copy-side half of the promotion marker — stamped at
   * create time on the variant that receives a promoted parent's carried
   * state, with the token from the parent's `promotionInFlight`. Stays on
   * the copy after completion (harmless: resume detection also requires
   * the parent marker, which the completing write clears). Server-owned,
   * stripped from client bodies like `promotionInFlight`.
   */
  promotedByToken: string | null;
  /**
   * GH #607: provenance for the OpenPrintTag re-sync feature — a flat map of
   * the OPT-offered value per managed field (dot-free keys, e.g.
   * `temperatures_nozzle`) captured at import / last sync. Stored OUTSIDE
   * the `settings` scalar bag on purpose: settings entries are rendered
   * directly as React children in the detail page's settings table and ride
   * verbatim into slicer exports, neither of which tolerates a structured
   * object.
   */
  openprinttagSnapshot: Record<string, unknown> | null;
  _deletedAt: Date | null;
  /**
   * Trash-tombstone flag for "delete forever". When true, the document is a
   * permanent purge marker — the trash UI hides it, the regular list hides
   * it (because `_deletedAt` is also set), and the hybrid sync engine
   * propagates the flag to the peer so the row stays gone on both sides.
   *
   * We can't physically `deleteOne` the row: the sync engine pairs docs by
   * `syncId` and treats "remote has it, local doesn't" as a fresh insert
   * from remote, resurrecting the deleted row.
   */
  _purged: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FilamentSchema = new Schema<IFilament>(
  {
    // GH #1116: `trim: true` makes the stored name the identity key every
    // lookup already assumes it is. Mongoose applies this setter on
    // create/save, updateOne, findOneAndUpdate and insertMany, but NOT on
    // raw driver writes, so the hybrid-sync engine (which copies whole
    // documents through the driver) bypasses it: the invariant is
    // per-instance, not global.
    name: { type: String, required: true, trim: true },
    syncId: { type: String, unique: true, sparse: true, index: true },
    // GH #302: NOT a field-level `unique: true` — a plain unique index
    // collides with soft-delete / `_purged` tombstone rows (a snapshot
    // restore / re-import can E11000 against a hidden tombstone). The
    // partial-unique index registered below scopes uniqueness to
    // non-deleted documents, matching the `name` index.
    instanceId: { type: String, default: generateInstanceId },
    vendor: { type: String, required: true, index: true },
    type: { type: String, required: true, index: true },
    // Default stays "#808080" so existing rows + every single-color
    // filament keep current behavior; null is only written when the user
    // opts into the multi-color "Coextruded" arrangement. Null is allowed
    // per the OPT spec; otherwise enforce `#RRGGBB`.
    color: {
      type: String,
      default: "#808080",
      validate: {
        validator: isValidColor,
        message: "color must be a #RRGGBB hex string or null",
      },
    },
    // Per-entry hex validation; max-5 cap matches the spec. Defaulting to
    // an empty array (vs undefined) so the read path never needs a null
    // guard.
    secondaryColors: {
      type: [String],
      default: () => [],
      validate: [
        {
          validator: (arr: string[]) => Array.isArray(arr) && arr.length <= 5,
          message: "secondaryColors may not exceed 5 entries (OpenPrintTag spec limit)",
        },
        {
          validator: (arr: string[]) =>
            arr.every((c) => typeof c === "string" && HEX_COLOR_RE.test(c)),
          message: "Each secondaryColors entry must be a #RRGGBB hex string",
        },
      ],
    },
    colorName: { type: String, default: null },
    // GH #337: `min`/`max` validators keep physically nonsensical values
    // (negative diameter / density / cost, out-of-range temperatures) out
    // of slicer bundles — the API rejects with 400. `null` is still allowed
    // for the optional fields.
    cost: { type: Number, default: null, min: [0, "cost must be >= 0"] },
    density: { type: Number, default: null, min: [0, "density must be >= 0"] },
    diameter: { type: Number, default: 1.75, min: [0.01, "diameter must be > 0"] },
    temperatures: {
      nozzle: { type: Number, default: null, min: [0, "temperature must be >= 0"], max: [600, "temperature must be <= 600"] },
      nozzleFirstLayer: { type: Number, default: null, min: [0, "temperature must be >= 0"], max: [600, "temperature must be <= 600"] },
      nozzleRangeMin: { type: Number, default: null, min: [0, "temperature must be >= 0"], max: [600, "temperature must be <= 600"] },
      nozzleRangeMax: { type: Number, default: null, min: [0, "temperature must be >= 0"], max: [600, "temperature must be <= 600"] },
      bed: { type: Number, default: null, min: [0, "temperature must be >= 0"], max: [300, "temperature must be <= 300"] },
      bedFirstLayer: { type: Number, default: null, min: [0, "temperature must be >= 0"], max: [300, "temperature must be <= 300"] },
      standby: { type: Number, default: null, min: [0, "temperature must be >= 0"], max: [600, "temperature must be <= 600"] },
    },
    // GH #281: `bedTypeTemps[].bedType` is deliberately free text, NOT a
    // BedType ObjectId ref. It holds a slicer bed-surface *key* (e.g.
    // PrusaSlicer's "Textured PEI") that round-trips through INI export —
    // a slicer-export concern with no DB identity. `calibrations[].bedType`
    // below is the separate, ref-counted pointer into the shared BedType
    // catalog. The two are intentionally distinct; do not conflate them.
    bedTypeTemps: [
      {
        bedType: { type: String, required: true },
        temperature: { type: Number, default: null, min: 0, max: 300 },
        firstLayerTemperature: { type: Number, default: null, min: 0, max: 300 },
      },
    ],
    maxVolumetricSpeed: { type: Number, default: null, min: 0 },
    compatibleNozzles: [{ type: Schema.Types.ObjectId, ref: "Nozzle" }],
    calibrations: [
      {
        printer: { type: Schema.Types.ObjectId, ref: "Printer", default: null },
        nozzle: { type: Schema.Types.ObjectId, ref: "Nozzle", required: true },
        bedType: { type: Schema.Types.ObjectId, ref: "BedType", default: null },
        extrusionMultiplier: { type: Number, default: null, min: 0 },
        maxVolumetricSpeed: { type: Number, default: null, min: 0 },
        pressureAdvance: { type: Number, default: null, min: 0 },
        retractLength: { type: Number, default: null, min: 0 },
        retractSpeed: { type: Number, default: null, min: 0 },
        retractLift: { type: Number, default: null, min: 0 },
        nozzleTemp: { type: Number, default: null, min: 0, max: 600 },
        nozzleTempFirstLayer: { type: Number, default: null, min: 0, max: 600 },
        bedTemp: { type: Number, default: null, min: 0, max: 300 },
        bedTempFirstLayer: { type: Number, default: null, min: 0, max: 300 },
        chamberTemp: { type: Number, default: null, min: 0, max: 300 },
        fanMinSpeed: { type: Number, default: null, min: 0, max: 100 },
        fanMaxSpeed: { type: Number, default: null, min: 0, max: 100 },
        fanBridgeSpeed: { type: Number, default: null, min: 0, max: 100 },
      },
    ],
    presets: [
      {
        label: { type: String, required: true },
        extrusionMultiplier: { type: Number, default: null, min: 0 },
        temperatures: {
          nozzle: { type: Number, default: null, min: 0, max: 600 },
          nozzleFirstLayer: { type: Number, default: null, min: 0, max: 600 },
          bed: { type: Number, default: null, min: 0, max: 300 },
          bedFirstLayer: { type: Number, default: null, min: 0, max: 300 },
        },
      },
    ],
    spools: [
      {
        instanceId: { type: String, default: generateInstanceId },
        // GH #953: the spool routes cap these via validateSpoolBody, but that
        // runs only on the API surface; this schema `maxlength` is the
        // backstop for every path that reaches Mongoose validation
        // (embedded-spool create, CSV import save, snapshot restore).
        label: {
          type: String,
          default: "",
          maxlength: [
            MAX_SPOOL_TEXT_LENGTH,
            `label must be ${MAX_SPOOL_TEXT_LENGTH} characters or fewer`,
          ],
        },
        totalWeight: { type: Number, default: null, min: 0 },
        lotNumber: {
          type: String,
          default: null,
          maxlength: [
            MAX_SPOOL_TEXT_LENGTH,
            `lotNumber must be ${MAX_SPOOL_TEXT_LENGTH} characters or fewer`,
          ],
        },
        purchaseDate: { type: Date, default: null },
        openedDate: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now },
        locationId: { type: Schema.Types.ObjectId, ref: "Location", default: null },
        photoDataUrl: { type: String, default: null },
        retired: { type: Boolean, default: false },
        dryCycles: [
          {
            date: { type: Date, required: true },
            tempC: { type: Number, default: null, min: 0, max: 300 },
            durationMin: { type: Number, default: null, min: 0 },
            notes: { type: String, default: "" },
          },
        ],
        usageHistory: [
          {
            grams: { type: Number, required: true, min: 0 },
            jobLabel: { type: String, default: "" },
            date: { type: Date, required: true, default: Date.now },
            source: {
              type: String,
              enum: ["manual", "slicer", "job", "nfc"],
              default: "manual",
            },
            // Index so the undo path's `usageHistory.jobId === entry._id`
            // filter doesn't full-scan every spool's array.
            jobId: { type: Schema.Types.ObjectId, ref: "PrintHistory", default: null, index: true },
            // GH #1074: grams actually removed from the spool at debit time
            // (see IUsageEntry). No `min: 0` on purpose — server-computed,
            // and a validator would brick later saves of docs that acquired
            // unexpected values through sync/restore paths.
            debitedGrams: { type: Number, default: null },
          },
        ],
      },
    ],
    spoolWeight: { type: Number, default: null, min: 0 },
    netFilamentWeight: { type: Number, default: null, min: 0 },
    totalWeight: { type: Number, default: null, min: 0 },
    lowStockThreshold: { type: Number, default: null, min: 0 },
    dryingTemperature: { type: Number, default: null, min: 0, max: 300 },
    // GH #634: cap at one week of minutes — the OpenPrintTag encoder writes
    // this as a CBOR uint, and values ≥ 2^32 wrap in its `>>>` arithmetic.
    dryingTime: { type: Number, default: null, min: 0, max: [10080, "dryingTime must be <= 10080 minutes (7 days)"] },
    transmissionDistance: { type: Number, default: null, min: 0 },
    glassTempTransition: { type: Number, default: null, min: -50, max: 500 },
    heatDeflectionTemp: { type: Number, default: null, min: -50, max: 500 },
    shoreHardnessA: { type: Number, default: null, min: 0, max: 100 },
    shoreHardnessD: { type: Number, default: null, min: 0, max: 100 },
    shrinkageXY: { type: Number, default: null, min: 0, max: 100 },
    shrinkageZ: { type: Number, default: null, min: 0, max: 100 },
    minPrintSpeed: { type: Number, default: null, min: 0 },
    maxPrintSpeed: { type: Number, default: null, min: 0 },
    spoolType: { type: String, default: null },
    // GH #634: sanitized on assignment — see sanitizeOptTags above.
    optTags: {
      type: [Number],
      default: [],
      set: sanitizeOptTags,
    },
    tdsUrl: {
      type: String,
      default: null,
      validate: {
        validator: isValidTdsUrl,
        message: "tdsUrl must be a valid http(s) URL",
      },
    },
    inherits: { type: String, default: null },
    parentId: { type: Schema.Types.ObjectId, ref: "Filament", default: null, index: true },
    settings: { type: Schema.Types.Mixed, default: {} },
    // GH #605: durable promotion marker pair (see the IFilament docblocks).
    // Declared as real schema paths — strict mode strips unknown keys, so
    // an undeclared $set would silently no-op — but server-owned: the
    // POST/PUT handlers strip both from client bodies and the atlas
    // import's allow-list never carries them. Only src/lib/promoteParent.ts
    // writes them. No dedicated index: resume lookups filter on the
    // already-indexed `parentId` first.
    promotionInFlight: {
      type: new Schema(
        {
          token: { type: String, required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    promotedByToken: { type: String, default: null },
    // GH #607: OpenPrintTag re-sync provenance (see the IFilament docblock).
    openprinttagSnapshot: { type: Schema.Types.Mixed, default: null },
    _deletedAt: { type: Date, default: null },
    _purged: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    // GH #224: optimistic concurrency so the print-history POST path
    // detects two near-simultaneous jobs racing on the same filament's
    // spool debits — the second save throws VersionError and the route
    // surfaces 409 for retry (without it, last-writer-wins silently loses
    // one job's grams debit). Affects every doc-level `save()` (refuses if
    // the in-memory version is stale); lean updates (`updateOne`,
    // `findOneAndUpdate`) are unaffected.
    optimisticConcurrency: true,
  }
);

// Partial unique index: enforce unique names only among non-deleted documents
FilamentSchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { _deletedAt: null } }
);

// GH #302: instanceId unique only among non-deleted documents, so a
// re-imported / restored filament can't collide with a tombstone row
// that still carries the same instanceId.
FilamentSchema.index(
  { instanceId: 1 },
  { unique: true, partialFilterExpression: { _deletedAt: null } }
);

// Composite index for common filter queries (vendor + type)
FilamentSchema.index({ vendor: 1, type: 1 });

// The QR/NFC match path resolves a scanned id against spools[].instanceId
// BEFORE the top-level instanceId fallback; this multikey index keeps that
// lookup from collection-scanning. Non-unique (the matcher handles
// collisions) and not scoped to non-deleted, so a trashed filament's spool
// tag still resolves for restore/awareness.
FilamentSchema.index({ "spools.instanceId": 1 });

// Ensure instanceId is always set before saving
FilamentSchema.pre("save", function () {
  if (!this.instanceId) {
    this.instanceId = generateInstanceId();
  }
});

// Validate tdsUrl on every update path. Mongoose skips schema validators
// on bare updateOne / findOneAndUpdate (used by the CSV import path in
// src/lib/importFilaments.ts) unless the caller passes
// `runValidators: true`, so these hooks are what keep an imported
// javascript:/file: URL out of storage.
function validateTdsUrlInUpdate(this: mongoose.Query<unknown, unknown>) {
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (!update) return;
  const $set = (update.$set ?? {}) as Record<string, unknown>;
  // tdsUrl can appear as either a top-level key (replacement-style update)
  // or under $set (the form import / CSV import / atlas import paths use)
  for (const candidate of [update.tdsUrl, $set.tdsUrl]) {
    if (candidate === undefined) continue;
    if (!isValidTdsUrl(candidate as string | null)) {
      throw new Error("tdsUrl must be a valid http(s) URL");
    }
  }
}
FilamentSchema.pre("updateOne", validateTdsUrlInUpdate);
FilamentSchema.pre("updateMany", validateTdsUrlInUpdate);
FilamentSchema.pre("findOneAndUpdate", validateTdsUrlInUpdate);

// GH #632: same treatment for the hex validators on color /
// secondaryColors — bare update queries (e.g. the OPT import's
// conditional-set path) skip schema validators. Mirrors
// validateTdsUrlInUpdate: covers both the top-level and `$set` shapes.
// `null` color stays valid — coextruded materials have a null primary.
function validateColorsInUpdate(this: mongoose.Query<unknown, unknown>) {
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (!update) return;
  const $set = (update.$set ?? {}) as Record<string, unknown>;
  for (const candidate of [update.color, $set.color]) {
    if (candidate === undefined) continue;
    if (!isValidColor(candidate)) {
      throw new Error("color must be a #RRGGBB hex string or null");
    }
  }
  for (const candidate of [update.secondaryColors, $set.secondaryColors]) {
    if (candidate === undefined) continue;
    if (!Array.isArray(candidate)) {
      throw new Error("secondaryColors must be an array of #RRGGBB hex strings");
    }
    if (candidate.length > 5) {
      throw new Error("secondaryColors may not exceed 5 entries (OpenPrintTag spec limit)");
    }
    if (!candidate.every((c) => typeof c === "string" && HEX_COLOR_RE.test(c))) {
      throw new Error("Each secondaryColors entry must be a #RRGGBB hex string");
    }
  }
}
FilamentSchema.pre("updateOne", validateColorsInUpdate);
FilamentSchema.pre("updateMany", validateColorsInUpdate);
FilamentSchema.pre("findOneAndUpdate", validateColorsInUpdate);

const Filament: Model<IFilament> =
  mongoose.models.Filament || mongoose.model<IFilament>("Filament", FilamentSchema);

/**
 * Backfill instanceId for any existing filaments that don't have one.
 * Safe to call multiple times — only updates documents missing the field.
 */
export async function backfillInstanceIds(): Promise<number> {
  const docs = await Filament.find(
    { $or: [{ instanceId: null }, { instanceId: { $exists: false } }] },
    { _id: 1 },
  ).lean();

  if (docs.length === 0) return 0;

  const ops = docs.map((doc) => ({
    updateOne: {
      filter: { _id: doc._id },
      update: { $set: { instanceId: generateInstanceId() } },
    },
  }));

  const result = await Filament.bulkWrite(ops);
  return result.modifiedCount;
}

/**
 * Backfill a per-spool `instanceId` onto every spool that lacks one.
 * Safe to call repeatedly — only fills missing ids (idempotent).
 *
 * Carry-over rule (preserves identity already on printed labels / written
 * NFC tags): the FIRST spool of a filament that is missing an id adopts the
 * filament's own `instanceId`, the rest get fresh ids. Skipped when the
 * filament's id is already held by one of its spools (avoid a duplicate).
 *
 * Returns the number of spools assigned an id. Uses positional arrayFilters
 * so a spool's other fields and concurrent edits aren't clobbered.
 */
export async function backfillSpoolInstanceIds(): Promise<number> {
  const docs = await Filament.find(
    {
      $or: [
        { spools: { $elemMatch: { instanceId: { $exists: false } } } },
        { spools: { $elemMatch: { instanceId: { $in: [null, ""] } } } },
      ],
    },
    { instanceId: 1, "spools._id": 1, "spools.instanceId": 1 },
  ).lean();

  if (docs.length === 0) return 0;

  const ops: AnyBulkWriteOperation<IFilament>[] = [];
  for (const doc of docs) {
    const spools = doc.spools ?? [];
    // If a spool already carries the filament's id, don't reuse it.
    const filamentIdTaken = spools.some(
      (s) => s.instanceId && s.instanceId === doc.instanceId,
    );
    let carriedOver = false;
    for (const s of spools) {
      if (s.instanceId) continue;
      let newId: string;
      if (!carriedOver && !filamentIdTaken && doc.instanceId) {
        newId = doc.instanceId; // first missing spool adopts the filament id
        carriedOver = true;
      } else {
        newId = generateInstanceId();
      }
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          // The array filter also requires the spool to STILL lack an id, so
          // a concurrent migration or in-process retry can't overwrite an
          // instanceId another run already assigned
          // (`$in: [null, ""]` matches missing, null, and "").
          update: { $set: { "spools.$[s].instanceId": newId } },
          arrayFilters: [{ "s._id": s._id, "s.instanceId": { $in: [null, ""] } }],
        },
      });
    }
  }

  if (ops.length === 0) return 0;
  // Report spools actually filled (modifiedCount), not ops submitted, so the
  // count is accurate when the array-filter guard skips already-filled spools.
  const res = await Filament.bulkWrite(ops);
  return res.modifiedCount ?? 0;
}

/**
 * Is `instanceId` already taken — by another spool OR by another filament's
 * top-level id? Used by the spool create/edit routes to keep a user-entered
 * id unique so `matchFilament` resolves it unambiguously.
 *
 * Both halves matter because `matchFilament` resolves spool ids BEFORE the
 * filament-level fallback: a spool id equal to ANOTHER filament's
 * `instanceId` would shadow that filament's existing labels/tags.
 *
 * Exclusions: `excludeSpoolId` lets a spool keep its own id on edit;
 * `ownFilamentId` permits the legitimate carry-over where a spool's id
 * equals ITS OWN filament's top-level id. Scoped to `_deletedAt: null`
 * (mirrors the partial-unique index — a trashed filament's id may be
 * reused). `$elemMatch` ensures the SAME spool element both carries the id
 * and isn't the excluded one (a dot-path query would match across two
 * elements).
 */
export async function isSpoolInstanceIdTaken(
  instanceId: string,
  excludeSpoolId?: string,
  ownFilamentId?: string,
): Promise<boolean> {
  // 1. Collision with another spool's id.
  const spoolQuery = excludeSpoolId
    ? {
        _deletedAt: null,
        spools: {
          $elemMatch: {
            instanceId,
            _id: { $ne: new mongoose.Types.ObjectId(excludeSpoolId) },
          },
        },
      }
    : { _deletedAt: null, "spools.instanceId": instanceId };
  if (await Filament.findOne(spoolQuery, { _id: 1 }).lean()) return true;

  // 2. Collision with another filament's top-level id (excluding the spool's
  //    own filament, where carry-over legitimately makes them equal).
  const filamentQuery: Record<string, unknown> = { _deletedAt: null, instanceId };
  if (ownFilamentId) {
    filamentQuery._id = { $ne: new mongoose.Types.ObjectId(ownFilamentId) };
  }
  if (await Filament.findOne(filamentQuery, { _id: 1 }).lean()) return true;

  return false;
}

export default Filament;

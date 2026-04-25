import crypto from "crypto";
import mongoose, { Schema, Document, Model } from "mongoose";

/** Generate a random 5-byte hex instance ID (10 hex chars), matching Prusament's format. */
function generateInstanceId(): string {
  return crypto.randomBytes(5).toString("hex");
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
   * Origin of the entry:
   *   - "manual": user logged usage directly on the spool UI (NOT via /api/print-history).
   *   - "slicer": a slicer integration posted through /api/print-history with a slicer source.
   *   - "job":    anything else that went through /api/print-history (including
   *               a user-posted "manual" job). Analytics treats "job" + "slicer" as
   *               already-accounted-for via PrintHistory records, so it only
   *               picks up "manual" entries from the fallback loop.
   *   - "nfc":    written by an NFC read.
   */
  source: "manual" | "slicer" | "job" | "nfc";
}

export interface ISpool {
  _id: mongoose.Types.ObjectId;
  label: string;
  totalWeight: number | null;
  lotNumber: string | null;
  purchaseDate: Date | null;
  openedDate: Date | null;
  createdAt: Date;
  // v1.11 additions
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
  color: string;
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
   * at the boundary. Other code paths (compare page, OpenPrintTag display)
   * historically rendered this value with an "h" suffix — those are display
   * bugs against this canonical unit and should be fixed if they surface. */
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
  settings: Record<string, string | null>;
  _deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const FilamentSchema = new Schema<IFilament>(
  {
    name: { type: String, required: true },
    syncId: { type: String, unique: true, sparse: true, index: true },
    instanceId: { type: String, unique: true, default: generateInstanceId },
    vendor: { type: String, required: true, index: true },
    type: { type: String, required: true, index: true },
    color: { type: String, default: "#808080" },
    colorName: { type: String, default: null },
    cost: { type: Number, default: null },
    density: { type: Number, default: null },
    diameter: { type: Number, default: 1.75 },
    temperatures: {
      nozzle: { type: Number, default: null },
      nozzleFirstLayer: { type: Number, default: null },
      nozzleRangeMin: { type: Number, default: null },
      nozzleRangeMax: { type: Number, default: null },
      bed: { type: Number, default: null },
      bedFirstLayer: { type: Number, default: null },
      standby: { type: Number, default: null },
    },
    bedTypeTemps: [
      {
        bedType: { type: String, required: true },
        temperature: { type: Number, default: null },
        firstLayerTemperature: { type: Number, default: null },
      },
    ],
    maxVolumetricSpeed: { type: Number, default: null },
    compatibleNozzles: [{ type: Schema.Types.ObjectId, ref: "Nozzle" }],
    calibrations: [
      {
        printer: { type: Schema.Types.ObjectId, ref: "Printer", default: null },
        nozzle: { type: Schema.Types.ObjectId, ref: "Nozzle", required: true },
        bedType: { type: Schema.Types.ObjectId, ref: "BedType", default: null },
        extrusionMultiplier: { type: Number, default: null },
        maxVolumetricSpeed: { type: Number, default: null },
        pressureAdvance: { type: Number, default: null },
        retractLength: { type: Number, default: null },
        retractSpeed: { type: Number, default: null },
        retractLift: { type: Number, default: null },
        nozzleTemp: { type: Number, default: null },
        nozzleTempFirstLayer: { type: Number, default: null },
        bedTemp: { type: Number, default: null },
        bedTempFirstLayer: { type: Number, default: null },
        chamberTemp: { type: Number, default: null },
        fanMinSpeed: { type: Number, default: null },
        fanMaxSpeed: { type: Number, default: null },
        fanBridgeSpeed: { type: Number, default: null },
      },
    ],
    presets: [
      {
        label: { type: String, required: true },
        extrusionMultiplier: { type: Number, default: null },
        temperatures: {
          nozzle: { type: Number, default: null },
          nozzleFirstLayer: { type: Number, default: null },
          bed: { type: Number, default: null },
          bedFirstLayer: { type: Number, default: null },
        },
      },
    ],
    spools: [
      {
        label: { type: String, default: "" },
        totalWeight: { type: Number, default: null },
        lotNumber: { type: String, default: null },
        purchaseDate: { type: Date, default: null },
        openedDate: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now },
        // v1.11 additions
        locationId: { type: Schema.Types.ObjectId, ref: "Location", default: null },
        photoDataUrl: { type: String, default: null },
        retired: { type: Boolean, default: false },
        dryCycles: [
          {
            date: { type: Date, required: true },
            tempC: { type: Number, default: null },
            durationMin: { type: Number, default: null },
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
          },
        ],
      },
    ],
    spoolWeight: { type: Number, default: null },
    netFilamentWeight: { type: Number, default: null },
    totalWeight: { type: Number, default: null },
    lowStockThreshold: { type: Number, default: null, min: 0 },
    dryingTemperature: { type: Number, default: null },
    dryingTime: { type: Number, default: null },
    transmissionDistance: { type: Number, default: null },
    glassTempTransition: { type: Number, default: null },
    heatDeflectionTemp: { type: Number, default: null },
    shoreHardnessA: { type: Number, default: null },
    shoreHardnessD: { type: Number, default: null },
    shrinkageXY: { type: Number, default: null },
    shrinkageZ: { type: Number, default: null },
    minPrintSpeed: { type: Number, default: null },
    maxPrintSpeed: { type: Number, default: null },
    spoolType: { type: String, default: null },
    optTags: { type: [Number], default: [] },
    tdsUrl: { type: String, default: null },
    inherits: { type: String, default: null },
    parentId: { type: Schema.Types.ObjectId, ref: "Filament", default: null, index: true },
    settings: { type: Schema.Types.Mixed, default: {} },
    _deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Partial unique index: enforce unique names only among non-deleted documents
FilamentSchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { _deletedAt: null } }
);

// Composite index for common filter queries (vendor + type)
FilamentSchema.index({ vendor: 1, type: 1 });

// Ensure instanceId is always set before saving
FilamentSchema.pre("save", function () {
  if (!this.instanceId) {
    this.instanceId = generateInstanceId();
  }
});

const Filament: Model<IFilament> =
  mongoose.models.Filament || mongoose.model<IFilament>("Filament", FilamentSchema);

/**
 * Backfill instanceId for any existing filaments that don't have one.
 * Safe to call multiple times — only updates documents missing the field.
 * Uses batched bulkWrite for performance instead of one-at-a-time saves.
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

export default Filament;

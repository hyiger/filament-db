import crypto from "crypto";
import mongoose, { Schema, Document, Model } from "mongoose";

/** Generate a random 5-byte hex instance ID (10 hex chars), matching Prusament's format. */
function generateInstanceId(): string {
  return crypto.randomBytes(5).toString("hex");
}

export interface ISpool {
  _id: mongoose.Types.ObjectId;
  label: string;
  totalWeight: number | null;
  lotNumber: string | null;
  purchaseDate: Date | null;
  openedDate: Date | null;
  createdAt: Date;
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
    extrusionMultiplier: number | null;
    maxVolumetricSpeed: number | null;
    pressureAdvance: number | null;
    retractLength: number | null;
    retractSpeed: number | null;
    retractLift: number | null;
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
  dryingTemperature: number | null;
  dryingTime: number | null;
  transmissionDistance: number | null;
  glassTempTransition: number | null;
  heatDeflectionTemp: number | null;
  shoreHardnessA: number | null;
  shoreHardnessD: number | null;
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
        extrusionMultiplier: { type: Number, default: null },
        maxVolumetricSpeed: { type: Number, default: null },
        pressureAdvance: { type: Number, default: null },
        retractLength: { type: Number, default: null },
        retractSpeed: { type: Number, default: null },
        retractLift: { type: Number, default: null },
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
      },
    ],
    spoolWeight: { type: Number, default: null },
    netFilamentWeight: { type: Number, default: null },
    totalWeight: { type: Number, default: null },
    dryingTemperature: { type: Number, default: null },
    dryingTime: { type: Number, default: null },
    transmissionDistance: { type: Number, default: null },
    glassTempTransition: { type: Number, default: null },
    heatDeflectionTemp: { type: Number, default: null },
    shoreHardnessA: { type: Number, default: null },
    shoreHardnessD: { type: Number, default: null },
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
 */
export async function backfillInstanceIds(): Promise<number> {
  const cursor = Filament.find({
    $or: [{ instanceId: null }, { instanceId: { $exists: false } }],
  }).cursor();

  let count = 0;
  for await (const doc of cursor) {
    doc.instanceId = generateInstanceId();
    await doc.save();
    count++;
  }
  return count;
}

export default Filament;

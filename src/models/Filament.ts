import mongoose, { Schema, Document, Model } from "mongoose";

export interface IFilament extends Document {
  name: string;
  vendor: string;
  type: string;
  color: string;
  cost: number | null;
  density: number | null;
  diameter: number;
  temperatures: {
    nozzle: number | null;
    nozzleFirstLayer: number | null;
    bed: number | null;
    bedFirstLayer: number | null;
  };
  maxVolumetricSpeed: number | null;
  compatibleNozzles: mongoose.Types.ObjectId[];
  calibrations: {
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
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  totalWeight: number | null;
  tdsUrl: string | null;
  inherits: string | null;
  parentId: mongoose.Types.ObjectId | null;
  settings: Record<string, string | null>;
  createdAt: Date;
  updatedAt: Date;
}

const FilamentSchema = new Schema<IFilament>(
  {
    name: { type: String, required: true, unique: true, index: true },
    vendor: { type: String, required: true, index: true },
    type: { type: String, required: true, index: true },
    color: { type: String, default: "#808080" },
    cost: { type: Number, default: null },
    density: { type: Number, default: null },
    diameter: { type: Number, default: 1.75 },
    temperatures: {
      nozzle: { type: Number, default: null },
      nozzleFirstLayer: { type: Number, default: null },
      bed: { type: Number, default: null },
      bedFirstLayer: { type: Number, default: null },
    },
    maxVolumetricSpeed: { type: Number, default: null },
    compatibleNozzles: [{ type: Schema.Types.ObjectId, ref: "Nozzle" }],
    calibrations: [
      {
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
    spoolWeight: { type: Number, default: null },
    netFilamentWeight: { type: Number, default: null },
    totalWeight: { type: Number, default: null },
    tdsUrl: { type: String, default: null },
    inherits: { type: String, default: null },
    parentId: { type: Schema.Types.ObjectId, ref: "Filament", default: null, index: true },
    settings: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

const Filament: Model<IFilament> =
  mongoose.models.Filament || mongoose.model<IFilament>("Filament", FilamentSchema);

export default Filament;

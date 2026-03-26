import mongoose, { Schema, Document, Model } from "mongoose";

export interface INozzle extends Document {
  name: string;
  diameter: number;
  type: string;
  highFlow: boolean;
  hardened: boolean;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

const NozzleSchema = new Schema<INozzle>(
  {
    name: { type: String, required: true, unique: true, index: true },
    diameter: { type: Number, required: true, index: true },
    type: { type: String, required: true, index: true },
    highFlow: { type: Boolean, default: false },
    hardened: { type: Boolean, default: false },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

const Nozzle: Model<INozzle> =
  mongoose.models.Nozzle || mongoose.model<INozzle>("Nozzle", NozzleSchema);

export default Nozzle;

import mongoose, { Schema, Document, Model } from "mongoose";

export interface IPrinter extends Document {
  name: string;
  manufacturer: string;
  printerModel: string;
  installedNozzles: mongoose.Types.ObjectId[];
  notes: string;
  _deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const PrinterSchema = new Schema<IPrinter>(
  {
    name: { type: String, required: true, unique: true, index: true },
    manufacturer: { type: String, required: true, index: true },
    printerModel: { type: String, required: true },
    installedNozzles: [{ type: Schema.Types.ObjectId, ref: "Nozzle" }],
    notes: { type: String, default: "" },
    _deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const Printer: Model<IPrinter> =
  mongoose.models.Printer || mongoose.model<IPrinter>("Printer", PrinterSchema);

export default Printer;

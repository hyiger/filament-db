import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * A slot in a multi-material system (Bambu AMS position, Prusa MMU tool head,
 * etc.). Holds a reference to a specific spool of a specific filament. The
 * compound reference lets the UI show "AMS 1 Slot A · PLA Basic Matte · spool 2
 * (410g remaining)" without needing to duplicate data.
 */
export interface IAmsSlot {
  _id?: mongoose.Types.ObjectId;
  slotName: string;
  /** Currently-loaded filament; null = empty slot. */
  filamentId: mongoose.Types.ObjectId | null;
  /** Currently-loaded spool subdocument id; null = no specific spool tracked. */
  spoolId: mongoose.Types.ObjectId | null;
}

export interface IPrinter extends Document {
  name: string;
  syncId: string | null;
  manufacturer: string;
  printerModel: string;
  installedNozzles: mongoose.Types.ObjectId[];
  notes: string;
  // v1.11 additions — expanded printer profile
  /** Build volume in mm. Null means unspecified. */
  buildVolume: { x: number | null; y: number | null; z: number | null };
  /** Rated max volumetric flow rate in mm³/s — useful for validating filament max flow. */
  maxFlow: number | null;
  /** Max travel speed in mm/s. */
  maxSpeed: number | null;
  /** Whether the printer has an enclosure (affects ABS/ASA/PC material compatibility). */
  enclosed: boolean;
  /** Whether the printer has hardware auto bed levelling. */
  autoBedLevel: boolean;
  /** Multi-material system slots. Empty array = no AMS/MMU. */
  amsSlots: IAmsSlot[];
  _deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const PrinterSchema = new Schema<IPrinter>(
  {
    name: { type: String, required: true },
    syncId: { type: String, unique: true, sparse: true, index: true },
    manufacturer: { type: String, required: true, index: true },
    printerModel: { type: String, required: true },
    installedNozzles: [{ type: Schema.Types.ObjectId, ref: "Nozzle" }],
    notes: { type: String, default: "" },
    buildVolume: {
      x: { type: Number, default: null, min: 0 },
      y: { type: Number, default: null, min: 0 },
      z: { type: Number, default: null, min: 0 },
    },
    maxFlow: { type: Number, default: null, min: 0 },
    maxSpeed: { type: Number, default: null, min: 0 },
    enclosed: { type: Boolean, default: false },
    autoBedLevel: { type: Boolean, default: false },
    amsSlots: [
      {
        slotName: { type: String, required: true },
        filamentId: { type: Schema.Types.ObjectId, ref: "Filament", default: null },
        spoolId: { type: Schema.Types.ObjectId, default: null },
      },
    ],
    _deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Partial unique index: enforce unique names only among non-deleted documents
PrinterSchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { _deletedAt: null } }
);

const Printer: Model<IPrinter> =
  mongoose.models.Printer || mongoose.model<IPrinter>("Printer", PrinterSchema);

export default Printer;

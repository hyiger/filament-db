import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * A slot in a multi-material system (Bambu AMS position, Prusa MMU tool
 * head, etc.). Holds a reference to a specific spool of a specific
 * filament.
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
  /** Unlike `installedNozzles`, which are physical instances (one nozzle
   * = one printer, enforced since #232), bed types are a SHARED catalog:
   * a surface spec like "Textured PEI" can legitimately be referenced by
   * many printers at once. No conflict detection applies here. */
  installedBedTypes: mongoose.Types.ObjectId[];
  notes: string;
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
    // GH #1116: `trim: true` makes the stored name the identity key every
    // lookup already assumes it is. Applied on create/save, updateOne,
    // findOneAndUpdate and insertMany, but NOT on raw driver writes, so
    // the hybrid-sync engine bypasses it: per-instance, not global.
    name: { type: String, required: true, trim: true },
    syncId: { type: String, unique: true, sparse: true, index: true },
    manufacturer: { type: String, required: true, index: true },
    printerModel: { type: String, required: true },
    installedNozzles: [{ type: Schema.Types.ObjectId, ref: "Nozzle" }],
    installedBedTypes: [{ type: Schema.Types.ObjectId, ref: "BedType" }],
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
        // `spoolId` is intentionally ref-less: a spool is a *subdocument*
        // of a Filament, so Mongoose `ref`/`populate` cannot resolve it.
        // Slot assignment funnels through `assignSpoolToSlot`
        // (src/lib/spoolSlots.ts) — the enforcement point for the
        // "one spool, one slot" invariant; the spool DELETE / retire
        // routes clear stale ids, and the hybrid-sync engine nulls this
        // on cross-side remap (no stable cross-side spool id).
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

// Index the AMS-slot ref fields — spoolSlots.findSpoolSlot,
// assignSpoolToSlot, clearSpoolsFromOtherPrinters, and the sync-engine
// repair pass all query into amsSlots.spoolId / amsSlots.filamentId on
// hot paths. Sparse so docs without amsSlots entries don't bloat the
// index.
PrinterSchema.index({ "amsSlots.spoolId": 1 }, { sparse: true });
PrinterSchema.index({ "amsSlots.filamentId": 1 }, { sparse: true });

const Printer: Model<IPrinter> =
  mongoose.models.Printer || mongoose.model<IPrinter>("Printer", PrinterSchema);

export default Printer;

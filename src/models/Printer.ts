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
  /** Bed surfaces this printer can use (GH — printer↔bed-type association).
   * Unlike `installedNozzles`, which are physical instances (one nozzle =
   * one printer, enforced since #232), bed types are a SHARED catalog: a
   * surface spec like "Textured PEI" can legitimately be referenced by
   * many printers at once. No conflict detection applies here. */
  installedBedTypes: mongoose.Types.ObjectId[];
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
        // GH #280: `spoolId` is intentionally ref-less. A spool is a
        // *subdocument* of a Filament, not a top-level collection, so
        // Mongoose `ref`/`populate` cannot resolve it. Slot assignment is
        // funnelled through `assignSpoolToSlot` (src/lib/spoolSlots.ts),
        // which is the enforcement point for the "one spool, one slot"
        // invariant; the spool DELETE / retire routes clear stale ids.
        // The hybrid-sync engine additionally nulls this on every
        // cross-side remap (no stable cross-side spool id — see the
        // v1.13 notes in CLAUDE.md), so a dangling id is self-healing.
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

// GH #525.3: index the AMS-slot ref fields. spoolSlots.findSpoolSlot,
// assignSpoolToSlot (clear-everywhere), clearSpoolsFromOtherPrinters,
// and the sync-engine repair pass all query into amsSlots.spoolId /
// amsSlots.filamentId on hot paths (every spool DELETE / retire /
// assignment, every filament DELETE, every Printer save, every sync
// cycle). Sparse so docs without amsSlots entries don't bloat the
// index. Personal-use installs have 1-5 printers so the perf delta
// is small; this is defensive hardening for the maker-space case.
PrinterSchema.index({ "amsSlots.spoolId": 1 }, { sparse: true });
PrinterSchema.index({ "amsSlots.filamentId": 1 }, { sparse: true });

const Printer: Model<IPrinter> =
  mongoose.models.Printer || mongoose.model<IPrinter>("Printer", PrinterSchema);

export default Printer;

import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * Persisted record of a print job reported back by a slicer or manual entry.
 * Kept as a top-level collection (rather than embedded on Filament) because:
 *   - A single print can consume multiple filaments (multi-material).
 *   - History grows unbounded; embedding would bloat every filament fetch.
 *   - Queries like "prints this month" are easier with a dedicated collection.
 *
 * The spool-level usageHistory subdocument is the per-spool projection; this
 * is the job-level record. They're kept in sync by the POST /api/print-history
 * handler.
 */
export interface IPrintHistory extends Document {
  /**
   * Stable cross-DB identifier used by the hybrid-sync engine to pair
   * print-history rows between local + Atlas. Mirrors the same field
   * on every other synced collection (filaments, nozzles, printers,
   * locations, bedtypes, sharedcatalogs). Issue #361: the snapshot
   * restore handler now inserts through Mongoose schemas in strict
   * mode, which silently strips unknown keys — without declaring
   * `syncId` here, a restored row loses the value and the next sync
   * treats it as new/unpaired. Sparse-unique index matches siblings.
   */
  syncId: string | null;
  /** Human-friendly job label — typically the .3mf/.gcode filename. */
  jobLabel: string;
  /** Which printer this ran on, if known. */
  printerId: mongoose.Types.ObjectId | null;
  /** Per-filament consumption entries for this job. */
  usage: {
    filamentId: mongoose.Types.ObjectId;
    spoolId: mongoose.Types.ObjectId | null;
    grams: number;
  }[];
  /** When the job was sliced / started. */
  startedAt: Date;
  /** Originator of this record. */
  source: "manual" | "prusaslicer" | "orcaslicer" | "bambu" | "other";
  /** Optional notes — success/fail, material issues, etc. */
  notes: string;
  _deletedAt: Date | null;
  /** GH #524.5: "delete forever" tombstone, mirroring Filament. A
   * permanent purge marker that the hybrid-sync engine's generic
   * `_purged` branch propagates to the peer so the row stays gone on
   * both sides. Physically deleting instead would let the sync engine
   * treat "remote has it, local doesn't" as a fresh insert and
   * resurrect it. */
  _purged: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PrintHistorySchema = new Schema<IPrintHistory>(
  {
    syncId: { type: String, unique: true, sparse: true, index: true },
    jobLabel: { type: String, required: true },
    printerId: { type: Schema.Types.ObjectId, ref: "Printer", default: null, index: true },
    usage: [
      {
        filamentId: { type: Schema.Types.ObjectId, ref: "Filament", required: true },
        // GH #280: `spoolId` is intentionally ref-less — a spool is a
        // subdocument of a Filament, not a top-level collection, so it
        // cannot be a Mongoose `ref`. Existence is validated at write
        // time by the POST /api/print-history handler (pass 1 confirms
        // an explicit spoolId belongs to the filament before any
        // mutation); the hybrid-sync engine nulls it on cross-side
        // remap. All writes funnel through that route.
        spoolId: { type: Schema.Types.ObjectId, default: null },
        grams: { type: Number, required: true, min: 0 },
      },
    ],
    startedAt: { type: Date, required: true, default: Date.now, index: true },
    source: {
      type: String,
      enum: ["manual", "prusaslicer", "orcaslicer", "bambu", "other"],
      default: "manual",
    },
    notes: { type: String, default: "" },
    _deletedAt: { type: Date, default: null },
    _purged: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// Index for common query patterns: "this printer's prints in the last N days"
PrintHistorySchema.index({ printerId: 1, startedAt: -1 });
// GH #955: back the `?filamentId=` list query (filter on the usage.filamentId
// multikey + the startedAt:-1 sort) with one index. Legal as a compound index
// because only usage.filamentId is an array field (startedAt is scalar).
PrintHistorySchema.index({ "usage.filamentId": 1, startedAt: -1 });

const PrintHistory: Model<IPrintHistory> =
  mongoose.models.PrintHistory || mongoose.model<IPrintHistory>("PrintHistory", PrintHistorySchema);

export default PrintHistory;

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
  createdAt: Date;
  updatedAt: Date;
}

const PrintHistorySchema = new Schema<IPrintHistory>(
  {
    jobLabel: { type: String, required: true },
    printerId: { type: Schema.Types.ObjectId, ref: "Printer", default: null, index: true },
    usage: [
      {
        filamentId: { type: Schema.Types.ObjectId, ref: "Filament", required: true },
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
  },
  { timestamps: true }
);

// Index for common query patterns: "this printer's prints in the last N days"
PrintHistorySchema.index({ printerId: 1, startedAt: -1 });

const PrintHistory: Model<IPrintHistory> =
  mongoose.models.PrintHistory || mongoose.model<IPrintHistory>("PrintHistory", PrintHistorySchema);

export default PrintHistory;

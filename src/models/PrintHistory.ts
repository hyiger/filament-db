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
   * Stable cross-DB identifier the hybrid-sync engine uses to pair rows
   * between local + Atlas; mirrors the same field on every other synced
   * collection. Must be DECLARED: snapshot restore inserts through
   * Mongoose schemas in strict mode, which silently strips unknown keys —
   * an undeclared `syncId` would be lost on restore and the next sync
   * would treat the row as new/unpaired (#361). Sparse-unique index
   * matches siblings.
   */
  syncId: string | null;
  /** Human-friendly job label — typically the .3mf/.gcode filename. */
  jobLabel: string;
  printerId: mongoose.Types.ObjectId | null;
  usage: {
    filamentId: mongoose.Types.ObjectId;
    spoolId: mongoose.Types.ObjectId | null;
    grams: number;
    /**
     * GH #1074: grams ACTUALLY removed from the spool at debit time —
     * `min(spool.totalWeight, grams)` when the spool tracked a weight,
     * else `grams` (the debit clamps at zero). The DELETE refund pays back
     * this value — refunding the full requested `grams` would mint phantom
     * inventory when the spool held less than the job consumed. `grams`
     * stays the requested/consumed amount so analytics totals are
     * unchanged. Null on rows created before the field existed — the
     * refund falls back to `grams` for those.
     */
    debitedGrams?: number | null;
  }[];
  startedAt: Date;
  source: "manual" | "prusaslicer" | "orcaslicer" | "bambu" | "other";
  notes: string;
  _deletedAt: Date | null;
  /** "Delete forever" tombstone, mirroring Filament — the hybrid-sync
   * engine propagates the flag so the row stays gone on both sides.
   * Physically deleting instead would let the sync engine treat "remote
   * has it, local doesn't" as a fresh insert and resurrect it. */
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
        // `spoolId` is intentionally ref-less — a spool is a subdocument
        // of a Filament, not a top-level collection, so it cannot be a
        // Mongoose `ref`. Existence is validated at write time by the
        // POST /api/print-history handler; the hybrid-sync engine nulls
        // it on cross-side remap.
        spoolId: { type: Schema.Types.ObjectId, default: null },
        grams: { type: Number, required: true, min: 0 },
        // See IPrintHistory. Declared for real — strict mode would
        // silently strip it from snapshot-restored rows (same reasoning
        // as syncId). No `min: 0`: server-computed, and a validator would
        // brick saves of legacy docs that arrived through paths bypassing
        // the routes (hybrid sync, restore) — the DELETE refund guards
        // the value at read time instead.
        debitedGrams: { type: Number, default: null },
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

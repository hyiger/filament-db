import mongoose, { Schema, Document, Model } from "mongoose";

export interface IBedType extends Document {
  name: string;
  syncId: string | null;
  material: string;
  notes: string;
  _deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const BedTypeSchema = new Schema<IBedType>(
  {
    // GH #1116: `trim: true` makes the stored name the identity key every
    // lookup already assumes it is. Applied on create/save, updateOne,
    // findOneAndUpdate and insertMany, but NOT on raw driver writes, so
    // the hybrid-sync engine bypasses it: per-instance, not global.
    name: { type: String, required: true, trim: true },
    syncId: { type: String, unique: true, sparse: true, index: true },
    material: { type: String, required: true, index: true },
    notes: { type: String, default: "" },
    _deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Partial unique index: enforce unique names only among non-deleted documents
BedTypeSchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { _deletedAt: null } }
);

const BedType: Model<IBedType> =
  mongoose.models.BedType || mongoose.model<IBedType>("BedType", BedTypeSchema);

export default BedType;

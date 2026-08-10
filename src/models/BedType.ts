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
    // lookup already assumes it is. Nothing normalized a name on write, so
    // `Drybox #1 ` and `Drybox #1` were two distinct rows that render
    // identically — and a CSV round-trip silently created the second one.
    // Mongoose applies this setter on create/save, updateOne,
    // findOneAndUpdate and insertMany, but NOT on raw driver writes, so the
    // hybrid-sync engine (which copies whole documents through the driver)
    // bypasses it: the invariant is per-instance, not global.
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

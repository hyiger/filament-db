import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * Inventory location — where a physical spool lives. Examples:
 * "Drybox #1", "Top shelf", "Garage cabinet", "Printer X1C AMS".
 *
 * Keeping it as its own collection (vs. a free-form string on Spool) lets users
 * rename a location in one place, group spools by location for at-a-glance
 * inventory, and track per-location humidity if they want to later.
 */
export interface ILocation extends Document {
  name: string;
  syncId: string | null;
  /** Free-form category used to group locations in pickers/lists.
   * Common values: "drybox", "shelf", "cabinet", "printer". Not constrained. */
  kind: string;
  /** Optional humidity reading (%RH) for dryboxes the user updates manually. */
  humidity: number | null;
  notes: string;
  _deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const LocationSchema = new Schema<ILocation>(
  {
    name: { type: String, required: true },
    syncId: { type: String, unique: true, sparse: true, index: true },
    kind: { type: String, default: "shelf", index: true },
    humidity: { type: Number, default: null, min: 0, max: 100 },
    notes: { type: String, default: "" },
    _deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Partial unique index: enforce unique names only among non-deleted documents
LocationSchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { _deletedAt: null } }
);

const Location: Model<ILocation> =
  mongoose.models.Location || mongoose.model<ILocation>("Location", LocationSchema);

export default Location;

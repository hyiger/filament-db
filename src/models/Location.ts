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
  /**
   * When the desiccant was last changed. Meaningful for `kind: "drybox"`,
   * where it drives the "DESICCANT CHANGED" line on a printed dry-box label
   * and answers the only question a glance at the box can't: whether the
   * beads are still doing anything. Null on every other kind, and optional
   * even on dryboxes.
   */
  desiccantChangedAt: Date | null;
  notes: string;
  _deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const LocationSchema = new Schema<ILocation>(
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
    kind: { type: String, default: "shelf", index: true },
    humidity: { type: Number, default: null, min: 0, max: 100 },
    desiccantChangedAt: { type: Date, default: null },
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

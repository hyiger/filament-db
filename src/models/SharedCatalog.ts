import crypto from "crypto";
import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * A public, read-only snapshot of selected filament profiles. Lets users share
 * their personal calibrations / tuned profiles with others via a link like
 * `/share/{slug}` without exposing their full catalog or needing an account.
 *
 * Contents are denormalised into `payload` so that later edits to the user's
 * catalog don't retroactively change what someone else downloaded. If the
 * user wants to refresh the share, they re-publish and get a new slug.
 */
export interface ISharedCatalog extends Document {
  /** Short URL-safe identifier used in the share link. */
  slug: string;
  /** Human-readable title shown on the share page. */
  title: string;
  /** Optional description shown on the share page. */
  description: string;
  /** Denormalised filament documents at publish time. */
  payload: {
    version: number;
    createdAt: string;
    filaments: unknown[];
    /** Referenced nozzles, printers, bedTypes — included read-only so the
     * importer can recreate the refs on the destination side. */
    nozzles: unknown[];
    printers: unknown[];
    bedTypes: unknown[];
  };
  expiresAt: Date | null;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function generateSlug(): string {
  // 9 bytes → 12 base64url chars, URL-safe and collision-resistant enough
  // for personal-scale sharing (no auth / no spam risk). Strip padding.
  return crypto.randomBytes(9).toString("base64url").replace(/=+$/, "");
}

const SharedCatalogSchema = new Schema<ISharedCatalog>(
  {
    slug: { type: String, required: true, unique: true, index: true, default: generateSlug },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    payload: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, default: null, index: true },
    viewCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

const SharedCatalog: Model<ISharedCatalog> =
  mongoose.models.SharedCatalog ||
  mongoose.model<ISharedCatalog>("SharedCatalog", SharedCatalogSchema);

export default SharedCatalog;

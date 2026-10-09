import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import FilamentModel from "@/models/Filament";

/**
 * GH #1227 — `optTagsSpec` defaults to true for NEW documents only.
 *
 * A plain `default: true` is also filled into a document LOADED from the
 * database when the field is absent, and the next save() writes it. A
 * pre-v1.83 row (no marker, legacy ids still unreviewed) that a print job,
 * a usage log, a restore or a spool import loaded and saved was therefore
 * stamped as verified without its ids being converted, and dropped out of
 * Data health. These tests pin the model behaviour without a database:
 * hydrate() builds the same document a findById() returns, and
 * $getChanges() is exactly the update save() would send.
 */
describe("Filament.optTagsSpec default (GH #1227)", () => {
  const legacyRow = () => ({
    _id: new mongoose.Types.ObjectId(),
    name: "Legacy PLA",
    vendor: "QA",
    type: "PLA",
    optTags: [2],
    spools: [{ _id: new mongoose.Types.ObjectId(), label: "a", totalWeight: 1000, usageHistory: [] }],
  });

  it("a loaded row without the marker reads as unmarked, not as verified", () => {
    const doc = FilamentModel.hydrate(legacyRow());
    expect(doc.optTagsSpec).toBeUndefined();
  });

  it("saving an unrelated change does not write the marker", () => {
    const doc = FilamentModel.hydrate(legacyRow());
    doc.spools[0].totalWeight = 950;
    doc.name = "Legacy PLA (renamed)";
    const changes = doc.$getChanges() as { $set?: Record<string, unknown> };
    expect(changes.$set ?? {}).not.toHaveProperty("optTagsSpec");
    expect(JSON.stringify(changes)).not.toContain("optTagsSpec");
  });

  it("a stored true or false is kept as stored", () => {
    expect(FilamentModel.hydrate({ ...legacyRow(), optTagsSpec: true }).optTagsSpec).toBe(true);
    expect(FilamentModel.hydrate({ ...legacyRow(), optTagsSpec: false }).optTagsSpec).toBe(false);
  });

  it("a new document still gets the default true", () => {
    const doc = new FilamentModel({ name: "New PLA", vendor: "QA", type: "PLA", optTags: [20] });
    expect(doc.isNew).toBe(true);
    expect(doc.optTagsSpec).toBe(true);
  });

  it("an explicit marker on a new document wins over the default", () => {
    const doc = new FilamentModel({ name: "Shared PLA", vendor: "QA", type: "PLA", optTags: [2], optTagsSpec: false });
    expect(doc.optTagsSpec).toBe(false);
  });
});

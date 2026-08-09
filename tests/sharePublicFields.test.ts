import { describe, it, expect } from "vitest";
import {
  SHARED_FILAMENT_FIELDS,
  SHARED_SETTINGS_KEY_DENYLIST,
  pickSharedFilamentFields,
  sanitizeSharedSettings,
} from "@/lib/sharePublicFields";

describe("pickSharedFilamentFields", () => {
  it("keeps the product-profile fields a recipient needs", () => {
    const doc = {
      _id: "a1",
      name: "Prusament PLA",
      vendor: "Prusa",
      type: "PLA",
      color: "#ff0000",
      density: 1.24,
      temperatures: { nozzle: 215, bed: 60 },
      settings: { filament_notes: "hi" },
      calibrations: [{ nozzle: "n1" }],
    };
    expect(pickSharedFilamentFields(doc)).toEqual(doc);
  });

  it("drops what the user paid", () => {
    // /share/{slug} is unauthenticated; `cost` is this user's purchasing data,
    // not a property of the filament.
    expect(pickSharedFilamentFields({ name: "PLA", cost: 24.99 })).toEqual({ name: "PLA" });
  });

  it("drops inventory and PII", () => {
    const out = pickSharedFilamentFields({
      name: "PLA",
      spools: [{ lotNumber: "L1", photoDataUrl: "data:image/png;base64,AAA" }],
      totalWeight: 900,
      lowStockThreshold: 200,
      instanceId: "a1b2c3d4e5",
    });
    expect(out).toEqual({ name: "PLA" });
  });

  it("drops sync and internal bookkeeping", () => {
    const out = pickSharedFilamentFields({
      name: "PLA",
      syncId: "s1",
      openprinttagSnapshot: { color: "#ff0000" },
      promotionInFlight: { token: "t", at: new Date(0) },
      promotedByToken: "t",
      _purged: true,
      _deletedAt: new Date(0),
      createdAt: new Date(0),
      updatedAt: new Date(0),
      __v: 3,
    });
    expect(out).toEqual({ name: "PLA" });
  });

  it("keeps _id and parentId — the importer's variant remapping needs them", () => {
    // src/lib/shareImport.ts builds its source→local id map from `_id` and
    // reparents variants through `parentId`. Dropping either silently flattens
    // every variant in the catalog.
    const out = pickSharedFilamentFields({ _id: "a1", parentId: "p1", name: "Red" });
    expect(out).toEqual({ _id: "a1", parentId: "p1", name: "Red" });
  });

  it("omits absent keys rather than emitting undefined", () => {
    const out = pickSharedFilamentFields({ name: "PLA" });
    expect(Object.keys(out)).toEqual(["name"]);
    expect("color" in out).toBe(false);
  });

  it("is an allow-list — an unknown future field is private by default", () => {
    // The whole point of the inversion: a field added to the schema later must
    // not become public just because nobody remembered to deny it.
    const out = pickSharedFilamentFields({
      name: "PLA",
      somethingAddedNextRelease: "secret",
    });
    expect(out).toEqual({ name: "PLA" });
  });

  it("does not mutate its input", () => {
    const doc = { name: "PLA", cost: 10 };
    pickSharedFilamentFields(doc);
    expect(doc).toEqual({ name: "PLA", cost: 10 });
  });

  it("lists no field twice", () => {
    expect(new Set(SHARED_FILAMENT_FIELDS).size).toBe(SHARED_FILAMENT_FIELDS.length);
  });

  it("excludes every field the old deny-list stripped", () => {
    // Regression floor: whatever else changes, these must never ship.
    for (const denied of ["spools", "lowStockThreshold", "instanceId", "totalWeight"]) {
      expect(SHARED_FILAMENT_FIELDS).not.toContain(denied);
    }
  });
});

describe("settings-bag sanitising (Codex P1)", () => {
  it("drops the legacy filament_cost shadow", () => {
    // An allow-list on top-level fields alone isn't enough: a filament
    // imported by older INI code carries a `filament_cost` shadow in the
    // passthrough bag, so dropping top-level `cost` while copying the bag
    // verbatim would publish the purchase price anyway.
    const out = pickSharedFilamentFields({
      name: "PLA",
      cost: 24.99,
      settings: { filament_cost: "24.99", filament_notes: "keep me" },
    });
    expect(out).toEqual({ name: "PLA", settings: { filament_notes: "keep me" } });
  });

  it("drops the routing/id hints", () => {
    expect(
      sanitizeSharedSettings({
        filamentdb_id: "6a00",
        filamentdb_nozzle: "0.4 Brass",
        filament_settings_id: "x",
        compatible_printers_condition: "keep",
      }),
    ).toEqual({ compatible_printers_condition: "keep" });
  });

  it("drops every top-level shadow, not just cost", () => {
    const bag: Record<string, string> = {};
    for (const k of SHARED_SETTINGS_KEY_DENYLIST) bag[k] = "x";
    bag.filament_notes = "keep";
    expect(sanitizeSharedSettings(bag)).toEqual({ filament_notes: "keep" });
  });

  it("leaves an ordinary passthrough bag alone", () => {
    const bag = { filament_notes: "n", some_future_slicer_key: "v" };
    expect(sanitizeSharedSettings(bag)).toEqual(bag);
  });

  it("does not throw on a malformed bag", () => {
    // The bag is arbitrary passthrough; a publish must not 500 on a bad shape.
    expect(sanitizeSharedSettings(null)).toBeNull();
    expect(sanitizeSharedSettings("nope")).toBe("nope");
    expect(sanitizeSharedSettings([1, 2])).toEqual([1, 2]);
  });

  it("does not mutate the stored bag", () => {
    const doc = { name: "PLA", settings: { filament_cost: "9", filament_notes: "n" } };
    pickSharedFilamentFields(doc);
    expect(doc.settings).toEqual({ filament_cost: "9", filament_notes: "n" });
  });
});

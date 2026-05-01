import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { getSpoolExportRows, SPOOL_EXPORT_COLUMNS } from "@/lib/exportSpools";

/**
 * GH #139 — bulk CSV export of every spool. The leading column headers must
 * match `/api/spools/import` so the file is round-trippable, and filament-
 * level fields (vendor / type / spoolWeight / netFilamentWeight) must resolve
 * through the parent for variants.
 */
describe("getSpoolExportRows", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Location: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    const locationMod = await import("@/models/Location");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    if (!mongoose.models.Location) {
      mongoose.model("Location", locationMod.default.schema);
    }
    Filament = mongoose.models.Filament;
    Location = mongoose.models.Location;
  });

  it("returns an empty array when no filaments exist", async () => {
    const rows = await getSpoolExportRows();
    expect(rows).toEqual([]);
  });

  it("emits one row per spool with the round-trippable importer headers as leading columns", async () => {
    // The importer's required columns are `filament` + `totalWeight`; optional
    // columns are vendor/label/lotNumber/purchaseDate/openedDate/location.
    // Pin the column order so a future reorder accidentally breaking
    // round-trip parity fails this test loudly.
    const headers = SPOOL_EXPORT_COLUMNS.slice(0, 8).map((c) => c.header);
    expect(headers).toEqual([
      "filament",
      "vendor",
      "label",
      "totalWeight",
      "lotNumber",
      "purchaseDate",
      "openedDate",
      "location",
    ]);
  });

  it("exports per-spool fields including label, totalWeight, lotNumber, purchase/opened dates, retired flag", async () => {
    await Filament.create({
      name: "Test PLA",
      vendor: "TestVendor",
      type: "PLA",
      color: "#ff0000",
      spoolWeight: 230,
      netFilamentWeight: 1000,
      spools: [
        {
          label: "Spool A",
          totalWeight: 850,
          lotNumber: "LOT-42",
          purchaseDate: new Date("2026-01-15T00:00:00Z"),
          openedDate: new Date("2026-02-01T00:00:00Z"),
          retired: false,
        },
        {
          label: "Spool B",
          totalWeight: 0,
          retired: true,
        },
      ],
    });

    const rows = await getSpoolExportRows();
    expect(rows).toHaveLength(2);

    const a = rows.find((r) => r.label === "Spool A")!;
    expect(a.filament).toBe("Test PLA");
    expect(a.vendor).toBe("TestVendor");
    expect(a.type).toBe("PLA");
    expect(a.color).toBe("#ff0000");
    expect(a.totalWeight).toBe(850);
    expect(a.spoolWeight).toBe(230);
    expect(a.netFilamentWeight).toBe(1000);
    expect(a.lotNumber).toBe("LOT-42");
    expect(a.purchaseDate).toBe("2026-01-15");
    expect(a.openedDate).toBe("2026-02-01");
    expect(a.retired).toBe(false);

    const b = rows.find((r) => r.label === "Spool B")!;
    expect(b.totalWeight).toBe(0);
    expect(b.lotNumber).toBeNull();
    expect(b.purchaseDate).toBeNull();
    expect(b.retired).toBe(true);
  });

  it("resolves nullable filament-level fields from the parent for variants (spoolWeight, netFilamentWeight)", async () => {
    // The schema marks vendor/type as required strings, so variants always
    // store concrete copies of those — there's nothing to inherit. The
    // export's inheritance value lives in the *nullable* numeric fields:
    // spoolWeight and netFilamentWeight typically live on the parent and
    // come through as null on each variant.
    const parent = await Filament.create({
      name: "Generic PETG",
      vendor: "ParentVendor",
      type: "PETG",
      spoolWeight: 250,
      netFilamentWeight: 1000,
    });
    await Filament.create({
      name: "Generic PETG — Forest Green",
      vendor: "ParentVendor", // schema requires non-empty
      type: "PETG",
      parentId: parent._id,
      // spoolWeight + netFilamentWeight intentionally unset → must inherit
      spools: [{ label: "V Spool", totalWeight: 950 }],
    });

    const rows = await getSpoolExportRows();
    const variant = rows.find((r) => r.label === "V Spool")!;
    expect(variant.filament).toBe("Generic PETG — Forest Green"); // variant own name
    expect(variant.spoolWeight).toBe(250); // inherited
    expect(variant.netFilamentWeight).toBe(1000); // inherited
  });

  it("resolves location ObjectIds to location names; missing locations come through as null", async () => {
    const drybox = await Location.create({ name: "Drybox #1", kind: "drybox" });
    await Filament.create({
      name: "PETG",
      vendor: "Test",
      type: "PETG",
      spools: [
        { label: "Located", totalWeight: 1000, locationId: drybox._id },
        { label: "Unlocated", totalWeight: 1000 }, // no locationId
      ],
    });

    const rows = await getSpoolExportRows();
    expect(rows.find((r) => r.label === "Located")!.location).toBe("Drybox #1");
    expect(rows.find((r) => r.label === "Unlocated")!.location).toBeNull();
  });

  it("aggregates dry cycles (count + most recent ISO timestamp) and usage history (grams sum)", async () => {
    await Filament.create({
      name: "PA",
      vendor: "Test",
      type: "PA",
      spools: [
        {
          label: "Heavy use",
          totalWeight: 600,
          dryCycles: [
            { date: new Date("2026-03-01T08:00:00Z"), tempC: 80, durationMin: 480, notes: "" },
            { date: new Date("2026-04-15T08:00:00Z"), tempC: 80, durationMin: 480, notes: "" },
            { date: new Date("2026-02-10T08:00:00Z"), tempC: 80, durationMin: 480, notes: "" },
          ],
          usageHistory: [
            { grams: 120, jobLabel: "test job", date: new Date(), source: "manual" },
            { grams: 80, jobLabel: "another", date: new Date(), source: "job" },
          ],
        },
      ],
    });

    const rows = await getSpoolExportRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.dryCyclesCount).toBe(3);
    expect(row.lastDriedAt).toBe("2026-04-15T08:00:00.000Z"); // picks max date even out-of-order
    expect(row.usedGrams).toBe(200);
  });

  it("emits ISO date-only strings for purchase/opened, and null for never-dried spools", async () => {
    await Filament.create({
      name: "PLA",
      vendor: "Test",
      type: "PLA",
      spools: [
        { label: "Untouched", totalWeight: 1000 },
      ],
    });

    const rows = await getSpoolExportRows();
    const row = rows[0];
    expect(row.purchaseDate).toBeNull();
    expect(row.openedDate).toBeNull();
    expect(row.lastDriedAt).toBeNull();
    expect(row.dryCyclesCount).toBe(0);
    expect(row.usedGrams).toBe(0);
    expect(row.retired).toBe(false);
  });

  it("includes filamentId / spoolId / instanceId so exported rows can be cross-referenced back", async () => {
    const filament = await Filament.create({
      name: "Linkable",
      vendor: "Test",
      type: "PLA",
      spools: [{ label: "S", totalWeight: 1000 }],
    });

    const rows = await getSpoolExportRows();
    const row = rows[0];
    expect(row.filamentId).toBe(filament._id.toString());
    expect(row.spoolId).toBe(filament.spools[0]._id.toString());
    expect(row.instanceId).toBe(filament.instanceId);
    expect(row.instanceId.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";

/**
 * GH #389 — Inventory page support route. Covers:
 *   - groups every spool by `locationId`
 *   - "no location" spools land in their own group at the END
 *   - filters by `kind`, `type`, `vendor`, and `includeRetired`
 *   - dryCycle count + lastDryAt projection
 *   - parent inheritance hints (spoolWeight / netFilamentWeight from
 *     a variant's parent come through alongside the variant's own)
 *   - filaments-list-projection caveat (this route deliberately surfaces
 *     spool subfields the list endpoint drops)
 */
describe("GET /api/spools/by-location", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Location: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const locMod = await import("@/models/Location");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Location) mongoose.model("Location", locMod.default.schema);
    Filament = mongoose.models.Filament;
    Location = mongoose.models.Location;
  });

  function req(url = "http://localhost/api/spools/by-location") {
    return new NextRequest(url);
  }

  it("returns an empty result when there are no spools", async () => {
    const { GET } = await import("@/app/api/spools/by-location/route");
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalSpools).toBe(0);
    expect(body.groups).toEqual([]);
  });

  it("groups spools by locationId and includes the location doc on each group", async () => {
    const shelf = await Location.create({ name: "Shelf A", kind: "shelf" });
    const dry = await Location.create({ name: "Drybox 1", kind: "drybox" });

    await Filament.create({
      name: "PLA Black",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      netFilamentWeight: 1000,
      spoolWeight: 200,
      spools: [
        { label: "S1", totalWeight: 1100, locationId: shelf._id },
        { label: "S2", totalWeight: 900, locationId: dry._id },
      ],
    });
    await Filament.create({
      name: "PETG Red",
      vendor: "QA",
      type: "PETG",
      diameter: 1.75,
      spools: [{ label: "S3", totalWeight: 1000, locationId: dry._id }],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const res = await GET(req());
    const body = await res.json();

    expect(body.totalSpools).toBe(3);
    expect(body.groups).toHaveLength(2);

    // Drybox 1 comes first alphabetically.
    const drybox = body.groups[0];
    expect(drybox.location.name).toBe("Drybox 1");
    expect(drybox.location.kind).toBe("drybox");
    expect(drybox.count).toBe(2);
    expect(drybox.totalGrams).toBe(900 + 1000);

    const shelfGroup = body.groups[1];
    expect(shelfGroup.location.name).toBe("Shelf A");
    expect(shelfGroup.count).toBe(1);
  });

  it("puts the synthetic 'no location' group at the END (not BSON-null first)", async () => {
    const shelf = await Location.create({ name: "Shelf Z", kind: "shelf" });
    await Filament.create({
      name: "PLA",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      spools: [
        { label: "S1", totalWeight: 1000, locationId: shelf._id },
        { label: "Orphan", totalWeight: 800 }, // no locationId
      ],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const res = await GET(req());
    const body = await res.json();

    expect(body.groups).toHaveLength(2);
    // Real location first, no-location bucket last so users notice it
    // as a "needs attention" trailer rather than mistaking it for the
    // primary inventory.
    expect(body.groups[0].location.name).toBe("Shelf Z");
    expect(body.groups[1].locationId).toBeNull();
    expect(body.groups[1].location).toBeFalsy();
    expect(body.groups[1].count).toBe(1);
    expect(body.groups[1].spools[0].label).toBe("Orphan");
  });

  it("excludes retired spools by default and includes them with ?includeRetired=1", async () => {
    const shelf = await Location.create({ name: "Shelf A", kind: "shelf" });
    await Filament.create({
      name: "PLA",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      spools: [
        { label: "Active", totalWeight: 1000, locationId: shelf._id },
        { label: "Retired", totalWeight: 0, locationId: shelf._id, retired: true },
      ],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const defaultRes = await (await GET(req())).json();
    expect(defaultRes.totalSpools).toBe(1);
    expect(defaultRes.groups[0].spools[0].label).toBe("Active");

    const withRetired = await (
      await GET(req("http://localhost/api/spools/by-location?includeRetired=1"))
    ).json();
    expect(withRetired.totalSpools).toBe(2);
  });

  it("filters by location kind", async () => {
    const shelf = await Location.create({ name: "Shelf A", kind: "shelf" });
    const dry = await Location.create({ name: "Drybox 1", kind: "drybox" });
    await Filament.create({
      name: "PLA",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      spools: [
        { label: "On shelf", totalWeight: 1000, locationId: shelf._id },
        { label: "In drybox", totalWeight: 900, locationId: dry._id },
      ],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const onlyDry = await (
      await GET(req("http://localhost/api/spools/by-location?kind=drybox"))
    ).json();
    expect(onlyDry.totalSpools).toBe(1);
    expect(onlyDry.groups[0].location.kind).toBe("drybox");
  });

  it("filters by filament type + vendor", async () => {
    const shelf = await Location.create({ name: "Shelf A", kind: "shelf" });
    await Filament.create({
      name: "PLA Black",
      vendor: "Polymaker",
      type: "PLA",
      diameter: 1.75,
      spools: [{ label: "PLA", totalWeight: 1000, locationId: shelf._id }],
    });
    await Filament.create({
      name: "PETG Red",
      vendor: "Overture",
      type: "PETG",
      diameter: 1.75,
      spools: [{ label: "PETG", totalWeight: 1000, locationId: shelf._id }],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const onlyPolymaker = await (
      await GET(req("http://localhost/api/spools/by-location?vendor=Polymaker"))
    ).json();
    expect(onlyPolymaker.totalSpools).toBe(1);
    expect(onlyPolymaker.groups[0].spools[0].filamentVendor).toBe("Polymaker");

    const onlyPETG = await (
      await GET(req("http://localhost/api/spools/by-location?type=PETG"))
    ).json();
    expect(onlyPETG.totalSpools).toBe(1);
    expect(onlyPETG.groups[0].spools[0].filamentType).toBe("PETG");
  });

  it("counts dry cycles + reports lastDryAt", async () => {
    const shelf = await Location.create({ name: "Shelf A", kind: "shelf" });
    const old = new Date("2024-01-01T00:00:00.000Z");
    const recent = new Date("2025-09-15T10:30:00.000Z");
    await Filament.create({
      name: "PLA",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      spools: [
        {
          label: "Dried twice",
          totalWeight: 1000,
          locationId: shelf._id,
          dryCycles: [
            { date: old, tempC: 50, durationMin: 240 },
            { date: recent, tempC: 55, durationMin: 360 },
          ],
        },
        { label: "Never dried", totalWeight: 1000, locationId: shelf._id },
      ],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const body = await (await GET(req())).json();
    const bySource = Object.fromEntries(
      body.groups[0].spools.map((s: { label: string }) => [s.label, s]),
    );
    expect(bySource["Dried twice"].dryCycleCount).toBe(2);
    // lastDryAt is the most-recent date — date order matches
    // chronological insert order so $arrayElemAt -1 returns the recent.
    expect(new Date(bySource["Dried twice"].lastDryAt).toISOString()).toBe(recent.toISOString());
    expect(bySource["Never dried"].dryCycleCount).toBe(0);
    expect(bySource["Never dried"].lastDryAt).toBeNull();
  });

  it("surfaces parent spoolWeight + netFilamentWeight on variant rows for client-side inheritance", async () => {
    const shelf = await Location.create({ name: "Shelf A", kind: "shelf" });
    const parent = await Filament.create({
      name: "Parent",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      spoolWeight: 200,
      netFilamentWeight: 1000,
    });
    await Filament.create({
      name: "Variant",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      parentId: parent._id,
      // variant has neither spoolWeight nor netFilamentWeight — should
      // inherit from parent at read time
      spools: [{ label: "V1", totalWeight: 1100, locationId: shelf._id }],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const body = await (await GET(req())).json();
    const spool = body.groups[0].spools[0];
    expect(spool.filamentName).toBe("Variant");
    expect(spool.spoolWeight).toBeNull(); // variant's own
    expect(spool.netFilamentWeight).toBeNull();
    expect(spool.parentSpoolWeight).toBe(200); // inherited
    expect(spool.parentNetFilamentWeight).toBe(1000);
  });

  it("excludes soft-deleted filaments and their spools", async () => {
    const shelf = await Location.create({ name: "Shelf A", kind: "shelf" });
    await Filament.create({
      name: "Trashed",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      _deletedAt: new Date(),
      spools: [{ label: "S1", totalWeight: 1000, locationId: shelf._id }],
    });
    await Filament.create({
      name: "Active",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      spools: [{ label: "S2", totalWeight: 1000, locationId: shelf._id }],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const body = await (await GET(req())).json();
    expect(body.totalSpools).toBe(1);
    expect(body.groups[0].spools[0].filamentName).toBe("Active");
  });
});

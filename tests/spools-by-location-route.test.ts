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
      spoolWeight: 200, // tare → subtracted from totalGrams
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
      // No `spoolWeight` → tare unknown → falls back to a 0g tare so
      // gross weight survives. Matches the posture of `/api/dashboard`
      // and `/api/locations` for legacy rolls tracked before
      // `spoolWeight` existed (Codex P2 round 4 on PR #400).
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
    // S2 contributes 900 − 200 = 700; S3 has no tare so falls back
    // to a 0g tare and contributes its gross 1000.
    expect(drybox.totalGrams).toBe(1700);

    const shelfGroup = body.groups[1];
    expect(shelfGroup.location.name).toBe("Shelf A");
    expect(shelfGroup.count).toBe(1);
    // S1: 1100 − 200 tare = 900g of filament.
    expect(shelfGroup.totalGrams).toBe(900);
  });

  it("totalGrams subtracts INHERITED parent tare for variant spools (Codex P2 #391)", async () => {
    // Regression test for the over-report: when a variant has no
    // spoolWeight of its own but its parent does, the aggregation
    // must reach through the self-`$lookup` and still subtract the
    // tare. The previous version summed the gross on-scale weight
    // and inflated the total by `N × empty-spool-mass`.
    const shelf = await Location.create({ name: "Shelf X", kind: "shelf" });
    const parent = await Filament.create({
      name: "Parent PLA",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      spoolWeight: 250, // parent has tare
      netFilamentWeight: 1000,
    });
    await Filament.create({
      name: "Variant PLA",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      parentId: parent._id,
      // variant has neither spoolWeight nor netFilamentWeight
      spools: [
        { label: "V1", totalWeight: 1100, locationId: shelf._id },
        { label: "V2", totalWeight: 700, locationId: shelf._id },
      ],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const body = await (await GET(req())).json();
    // V1: 1100 − 250 = 850; V2: 700 − 250 = 450. Total = 1300, NOT
    // 1800 (which was the pre-fix gross sum).
    expect(body.groups[0].totalGrams).toBe(1300);
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

  it("?type= and ?vendor= match variants that INHERIT those fields from a parent (Codex P2 #391 r2)", async () => {
    // `type` and `vendor` are listed in `INHERITABLE_FIELDS` — pre-fix
    // the server filtered on the variant's raw value, so a variant
    // that left either blank to inherit was dropped from filtered
    // results even though the rest of the app treats it as that
    // type / vendor.
    //
    // The schema marks both as required, so we have to bypass
    // Mongoose validation to seed the inheriting-variant case. Real
    // data in this shape exists when CSV imports or hand-crafted docs
    // leave the fields off, and it's exactly the case Codex flagged.
    const shelf = await Location.create({ name: "Shelf A", kind: "shelf" });
    const parent = await Filament.create({
      name: "Polymaker PLA Parent",
      vendor: "Polymaker",
      type: "PLA",
      diameter: 1.75,
    });
    await Filament.collection.insertOne({
      name: "Polymaker PLA Black",
      // vendor + type intentionally OMITTED — inherits from parent.
      parentId: parent._id,
      diameter: 1.75,
      _deletedAt: null,
      spools: [
        {
          _id: new mongoose.Types.ObjectId(),
          label: "S1",
          totalWeight: 1000,
          retired: false,
          locationId: shelf._id,
        },
      ],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const byType = await (
      await GET(req("http://localhost/api/spools/by-location?type=PLA"))
    ).json();
    expect(byType.totalSpools).toBe(1);
    expect(byType.groups[0].spools[0].filamentName).toBe("Polymaker PLA Black");
    // Response carries the EFFECTIVE (inherited) type/vendor so the
    // page's chips don't render blank.
    expect(byType.groups[0].spools[0].filamentType).toBe("PLA");
    expect(byType.groups[0].spools[0].filamentVendor).toBe("Polymaker");

    const byVendor = await (
      await GET(req("http://localhost/api/spools/by-location?vendor=Polymaker"))
    ).json();
    expect(byVendor.totalSpools).toBe(1);
  });

  it("?type= and ?vendor= treat EMPTY-STRING inherited values as missing (Codex P2 #400)", async () => {
    // The case Codex specifically flagged: a variant with explicit
    // empty-string `type`/`vendor` should still fall back to the
    // parent's values, because `resolveFilament` treats `""` the same
    // way it treats null/missing for INHERITABLE_FIELDS
    // (src/lib/resolveFilament.ts:67-72). A naïve `$ifNull` would keep
    // the `""` and exclude the row from `?type=PLA`.
    const shelf = await Location.create({ name: "Shelf B", kind: "shelf" });
    const parent = await Filament.create({
      name: "EmptyParent",
      vendor: "Polymaker",
      type: "PLA",
      diameter: 1.75,
    });
    await Filament.collection.insertOne({
      name: "EmptyVariant",
      // Explicit empty strings instead of missing/null — the case
      // Codex called out.
      type: "",
      vendor: "",
      parentId: parent._id,
      diameter: 1.75,
      _deletedAt: null,
      spools: [
        {
          _id: new mongoose.Types.ObjectId(),
          label: "S1",
          totalWeight: 1000,
          retired: false,
          locationId: shelf._id,
        },
      ],
    });

    const { GET } = await import("@/app/api/spools/by-location/route");
    const byType = await (
      await GET(req("http://localhost/api/spools/by-location?type=PLA"))
    ).json();
    expect(byType.totalSpools).toBe(1);
    expect(byType.groups[0].spools[0].filamentName).toBe("EmptyVariant");
    expect(byType.groups[0].spools[0].filamentType).toBe("PLA");
    expect(byType.groups[0].spools[0].filamentVendor).toBe("Polymaker");
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

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as importSpools } from "@/app/api/spools/import/route";

/**
 * Tests for the CSV bulk spool import route. parseCsv itself is covered
 * in parseCsv.test.ts; this file validates the glue between the parser,
 * the Filament lookup (with optional vendor disambiguation), and the
 * location-rehydration cache that auto-creates missing locations.
 */
describe("/api/spools/import", () => {
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

  function csvRequest(csv: string, contentType = "text/csv") {
    return new NextRequest("http://localhost/api/spools/import", {
      method: "POST",
      headers: { "content-type": contentType },
      body: csv,
    });
  }

  function jsonRequest(csv: string) {
    return new NextRequest("http://localhost/api/spools/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv }),
    });
  }

  it("imports a matching filament's spool", async () => {
    const f = await Filament.create({
      name: "Prusament PLA Galaxy Black",
      vendor: "Prusa Polymers",
      type: "PLA",
    });

    const csv =
      "filament,totalWeight\n" +
      `Prusament PLA Galaxy Black,950\n`;
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(0);

    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].totalWeight).toBe(950);
  });

  it("disambiguates by vendor when two filaments share a name", async () => {
    await Filament.create({ name: "PLA Black", vendor: "Vendor A", type: "PLA" });
    const b = await Filament.create({ name: "PLA Black", vendor: "Vendor B", type: "PLA" });

    const csv =
      "filament,vendor,totalWeight\n" +
      `PLA Black,Vendor B,800\n`;
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);

    const fresh = await Filament.findById(b._id);
    expect(fresh.spools[0].totalWeight).toBe(800);
  });

  it("auto-creates referenced locations by name", async () => {
    const f = await Filament.create({ name: "Loc Test", vendor: "Test", type: "PLA" });
    const csv =
      "filament,totalWeight,location\n" +
      `Loc Test,500,Drybox 1\n` +
      `Loc Test,600,Drybox 2\n` +
      `Loc Test,700,Drybox 1\n`;

    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(3);

    const locs = await Location.find({ _deletedAt: null }).sort({ name: 1 });
    expect(locs.map((l: { name: string }) => l.name)).toEqual(["Drybox 1", "Drybox 2"]);

    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(3);
    // Both Drybox 1 rows should share the same locationId.
    const locIds = fresh.spools.map((s: { locationId: unknown }) => String(s.locationId));
    expect(locIds[0]).toBe(locIds[2]);
    expect(locIds[0]).not.toBe(locIds[1]);
  });

  it("reports per-row errors without aborting the batch", async () => {
    await Filament.create({ name: "Known", vendor: "Test", type: "PLA" });
    const csv =
      "filament,totalWeight\n" +
      `Known,800\n` +
      `Unknown,500\n` +
      `Known,-10\n` +
      `,100\n`;
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(3);
    expect(body.results[1].error).toMatch(/No filament named "Unknown"/);
    expect(body.results[2].error).toMatch(/non-negative/);
    expect(body.results[3].error).toMatch(/filament is required/);
  });

  it("accepts the alternate JSON body shape", async () => {
    await Filament.create({ name: "JSON Path", vendor: "Test", type: "PLA" });
    const csv = "filament,totalWeight\nJSON Path,250\n";
    const res = await importSpools(jsonRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);
  });

  it("rejects an empty body with 400", async () => {
    const res = await importSpools(csvRequest(""));
    expect(res.status).toBe(400);
  });

  it("rejects a CSV missing required columns", async () => {
    const res = await importSpools(csvRequest("filament\nOnly-Name\n"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/totalWeight/);
  });

  it("strips a UTF-8 BOM from the start of the body", async () => {
    await Filament.create({ name: "BOM Test", vendor: "Test", type: "PLA" });
    const csv = "\uFEFFfilament,totalWeight\nBOM Test,100\n";
    const res = await importSpools(csvRequest(csv));
    const body = await res.json();
    expect(body.imported).toBe(1);
  });
});

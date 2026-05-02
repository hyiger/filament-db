import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listFilaments } from "@/app/api/filaments/route";

/**
 * Verify the list endpoint projects to FilamentSummary shape (no
 * heavy spool subfields, presence of `hasCalibrations`) instead of
 * returning every field on every doc.
 *
 * Coupled to the noCalibration quick filter on the list page: the
 * page reads `hasCalibrations` to decide whether to count/show a
 * filament under that filter. Before this projection landed the field
 * didn't exist and the filter was a no-op.
 */
describe("GET /api/filaments — projection to FilamentSummary", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  async function seed() {
    const noCalNoSpools = await Filament.create({
      name: "Bare PLA",
      vendor: "Test",
      type: "PLA",
    });
    const withCalibration = await Filament.create({
      name: "Calibrated PLA",
      vendor: "Test",
      type: "PLA",
      calibrations: [
        { nozzle: new mongoose.Types.ObjectId(), extrusionMultiplier: 0.95 },
      ],
    });
    const withSpoolPhoto = await Filament.create({
      name: "Photo PLA",
      vendor: "Test",
      type: "PLA",
      spools: [
        {
          totalWeight: 800,
          // The big-blob field that should NOT make it into list output.
          photoDataUrl: "data:image/png;base64,AAAA",
        },
      ],
    });
    return { noCalNoSpools, withCalibration, withSpoolPhoto };
  }

  it("strips spool.photoDataUrl and other heavy subfields from the list payload", async () => {
    await seed();
    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const photoEntry = body.find((f: { name: string }) => f.name === "Photo PLA");
    expect(photoEntry).toBeDefined();
    expect(photoEntry.spools).toHaveLength(1);
    // Only summary fields per FilamentSummary
    expect(photoEntry.spools[0]).not.toHaveProperty("photoDataUrl");
    expect(photoEntry.spools[0]).not.toHaveProperty("usageHistory");
    expect(photoEntry.spools[0]).not.toHaveProperty("dryCycles");
    expect(photoEntry.spools[0]).toHaveProperty("totalWeight", 800);
    expect(photoEntry.spools[0]).toHaveProperty("_id");
  });

  it("includes spools[].label so PrinterForm's AMS slot picker doesn't degrade to short IDs", async () => {
    // PrinterForm renders each spool choice as `s.label || s._id.slice(-4)`,
    // so the projection must keep label even though the list page itself
    // doesn't render it.
    const Filament = (await import("@/models/Filament")).default;
    await Filament.create({
      name: "Labeled Spools",
      vendor: "Test",
      type: "PLA",
      spools: [
        { label: "AMS slot 1", totalWeight: 800 },
        { label: "Backup", totalWeight: 1000 },
      ],
    });

    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();
    const entry = body.find((f: { name: string }) => f.name === "Labeled Spools");
    expect(entry.spools).toHaveLength(2);
    expect(entry.spools[0].label).toBe("AMS slot 1");
    expect(entry.spools[1].label).toBe("Backup");
  });

  it("computes hasCalibrations true/false per row", async () => {
    await seed();
    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();

    const bare = body.find((f: { name: string }) => f.name === "Bare PLA");
    const cal = body.find((f: { name: string }) => f.name === "Calibrated PLA");
    expect(bare.hasCalibrations).toBe(false);
    expect(cal.hasCalibrations).toBe(true);
  });

  it("does not include the full calibrations array (only the boolean)", async () => {
    await seed();
    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();
    const cal = body.find((f: { name: string }) => f.name === "Calibrated PLA");
    // Verify the heavy field isn't in the list payload — detail endpoint
    // remains the source of truth for the array.
    expect(cal).not.toHaveProperty("calibrations");
  });

  it("includes tdsUrl in the projection so FilamentForm vendor suggestions still work", async () => {
    // FilamentForm calls /api/filaments?vendor=... and reads tdsUrl off
    // each row to populate vendor-keyed TDS suggestions. Codex flagged
    // that dropping the field silently empties the suggestion list.
    const Filament = (await import("@/models/Filament")).default;
    await Filament.create({
      name: "Has TDS",
      vendor: "Test",
      type: "PLA",
      tdsUrl: "https://example.com/tds.pdf",
    });
    await Filament.create({
      name: "No TDS",
      vendor: "Test",
      type: "PLA",
    });

    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments?vendor=Test"),
    );
    const body = await res.json();
    const withTds = body.find((f: { name: string }) => f.name === "Has TDS");
    const withoutTds = body.find((f: { name: string }) => f.name === "No TDS");
    expect(withTds.tdsUrl).toBe("https://example.com/tds.pdf");
    expect(withoutTds.tdsUrl).toBeNull();
  });

  it("preserves type/vendor filters across the projection", async () => {
    await seed();
    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments?vendor=Test&type=PLA"),
    );
    const body = await res.json();
    expect(body).toHaveLength(3);
  });
});

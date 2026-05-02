import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { GET as getDashboard } from "@/app/api/dashboard/route";

/**
 * GH #133 regression guard.
 *
 * The dashboard's "Dry Cycle Due" list filters spools by whether their
 * filament has a `dryingTemperature` set. Before v1.12.5, that check
 * looked only at the variant's own field — so a child filament that
 * inherited drying values from its parent never appeared in the list,
 * even with a brand-new (never-dried) spool. The fix resolves the
 * inherited value via `resolveFilament` before the gate.
 */
describe("/api/dashboard — dry-cycle inheritance", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    // Re-register models after setup.ts's afterEach wipes mongoose.models.
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  it("includes a never-dried spool whose filament inherits dryingTemperature from its parent (GH #133)", async () => {
    const parent = await Filament.create({
      name: "Generic PETG",
      vendor: "Test",
      type: "PETG",
      dryingTemperature: 60,
      dryingTime: 360,
    });
    const variant = await Filament.create({
      name: "Generic PETG — Forest Green",
      vendor: "Test",
      type: "PETG",
      parentId: parent._id,
      // No dryingTemperature / dryingTime — must inherit from parent.
      spools: [{ label: "Spool A", totalWeight: 1000 }],
    });

    const res = await getDashboard();
    const body = await res.json();

    const variantSpoolIds = (body.dryDue as { filamentId: string; spoolId: string }[])
      .filter((d) => d.filamentId === String(variant._id))
      .map((d) => d.spoolId);
    expect(variantSpoolIds).toHaveLength(1);
    expect(variantSpoolIds[0]).toBe(String(variant.spools[0]._id));
  });

  it("includes a never-dried spool on a standalone filament with its own dryingTemperature (positive baseline)", async () => {
    const f = await Filament.create({
      name: "Standalone PETG",
      vendor: "Test",
      type: "PETG",
      dryingTemperature: 60,
      dryingTime: 360,
      spools: [{ label: "Spool", totalWeight: 1000 }],
    });

    const res = await getDashboard();
    const body = await res.json();

    const ids = (body.dryDue as { filamentId: string }[])
      .map((d) => d.filamentId);
    expect(ids).toContain(String(f._id));
  });

  it("excludes spools whose filament has no dryingTemperature (own or inherited)", async () => {
    const f = await Filament.create({
      name: "Plain PLA",
      vendor: "Test",
      type: "PLA",
      // No dryingTemperature anywhere.
      spools: [{ label: "Spool", totalWeight: 1000 }],
    });

    const res = await getDashboard();
    const body = await res.json();

    const ids = (body.dryDue as { filamentId: string }[])
      .map((d) => d.filamentId);
    expect(ids).not.toContain(String(f._id));
  });

  it("excludes a spool dried within the 30-day threshold even when the filament inherits drying temp", async () => {
    const parent = await Filament.create({
      name: "Generic PA-CF",
      vendor: "Test",
      type: "PA",
      dryingTemperature: 80,
      dryingTime: 480,
    });
    const variant = await Filament.create({
      name: "Generic PA-CF — Black",
      vendor: "Test",
      type: "PA",
      parentId: parent._id,
      spools: [
        {
          label: "Recently dried",
          totalWeight: 1000,
          dryCycles: [
            { date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), tempC: 80, durationMin: 480, notes: "" },
          ],
        },
      ],
    });

    const res = await getDashboard();
    const body = await res.json();

    const ids = (body.dryDue as { filamentId: string }[])
      .map((d) => d.filamentId);
    expect(ids).not.toContain(String(variant._id));
  });
});

/**
 * GH #166 regression guard.
 *
 * The "ACTIVE SPOOLS" tile renders `data.counts.spools` against a label
 * that says "Active". If `counts.spools` doesn't match the dashboard's
 * own definition of "active" (i.e. excludes retired), the tile lies the
 * moment any spool is retired. The fix returns both the active count
 * and a separate `totalSpools` so the API surface is unambiguous and a
 * future tile / tooltip can render the breakdown.
 */
describe("/api/dashboard — counts.spools is active-only (excludes retired)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  it("excludes retired spools from counts.spools and surfaces them in counts.retiredSpools", async () => {
    await Filament.create({
      name: "PLA Active",
      vendor: "Test",
      type: "PLA",
      spools: [
        { label: "A1", totalWeight: 1000 },
        { label: "A2", totalWeight: 1000 },
      ],
    });
    await Filament.create({
      name: "PLA Mixed",
      vendor: "Test",
      type: "PLA",
      spools: [
        { label: "B1", totalWeight: 1000 },
        { label: "B2-retired", totalWeight: 50, retired: true },
      ],
    });

    const res = await getDashboard();
    const body = await res.json();

    expect(body.counts.spools).toBe(3);          // A1, A2, B1
    expect(body.counts.retiredSpools).toBe(1);   // B2-retired
    expect(body.counts.totalSpools).toBe(4);     // breakdown for tooltips / future tiles
  });

  it("counts.spools is 0 when every spool is retired", async () => {
    await Filament.create({
      name: "All Retired PLA",
      vendor: "Test",
      type: "PLA",
      spools: [
        { label: "old1", totalWeight: 0, retired: true },
        { label: "old2", totalWeight: 0, retired: true },
      ],
    });

    const res = await getDashboard();
    const body = await res.json();

    expect(body.counts.spools).toBe(0);
    expect(body.counts.retiredSpools).toBe(2);
    expect(body.counts.totalSpools).toBe(2);
  });
});

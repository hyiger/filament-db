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

/**
 * GH #182 regression guard.
 *
 * `spool.totalWeight` is the live scale reading (filament + empty spool),
 * not remaining filament. Pre-fix the dashboard's `totalGrams` and
 * low-stock check summed the raw scale value, which inflated inventory
 * by one empty-spool mass per tracked spool and let low-stock alerts
 * hide while the gross weight still cleared the threshold.
 */
describe("/api/dashboard — totalGrams + low-stock subtract empty-spool mass (GH #182)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  it("totalGrams sums (totalWeight − spoolWeight) per spool, clamped at 0", async () => {
    // Two spools at 1000g scale, 250g empty-spool mass → 750g remaining each
    // ⇒ totalGrams should be 1500, NOT the raw 2000.
    await Filament.create({
      name: "PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 250,
      netFilamentWeight: 1000,
      spools: [
        { label: "A", totalWeight: 1000 },
        { label: "B", totalWeight: 1000 },
      ],
    });

    const res = await getDashboard();
    const body = await res.json();
    expect(body.totalGrams).toBe(1500);
  });

  it("a spool whose scale reading is below the empty-spool weight clamps to 0 (no negative)", async () => {
    // totalWeight=200 with spoolWeight=250 means the scale is below the
    // empty mass — should contribute 0 (not -50) to totalGrams.
    await Filament.create({
      name: "Empty PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 250,
      netFilamentWeight: 1000,
      spools: [{ label: "almost-empty", totalWeight: 200 }],
    });

    const res = await getDashboard();
    const body = await res.json();
    expect(body.totalGrams).toBe(0);
  });

  it("low-stock check uses remaining filament, so a high-gross / low-net spool surfaces", async () => {
    // 600g gross with 500g empty-spool mass = 100g remaining. Threshold
    // 200 → should be flagged as low stock. Pre-fix the check compared
    // 600 < 200 (false) and the warning was hidden.
    const f = await Filament.create({
      name: "Almost Empty PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 500,
      netFilamentWeight: 1000,
      lowStockThreshold: 200,
      spools: [{ label: "low", totalWeight: 600 }],
    });

    const res = await getDashboard();
    const body = await res.json();
    const ids = (body.lowStock as { _id: string }[]).map((x) => x._id);
    expect(ids).toContain(String(f._id));
    const entry = (body.lowStock as { _id: string; remainingGrams: number }[]).find((x) => x._id === String(f._id));
    expect(entry?.remainingGrams).toBe(100);
  });

  it("a filament with no spoolWeight defaults to subtracting 0 (back-compat for legacy docs)", async () => {
    await Filament.create({
      name: "Legacy",
      vendor: "Test",
      type: "PLA",
      // spoolWeight intentionally omitted (undefined / null)
      spools: [{ label: "X", totalWeight: 1000 }],
    });

    const res = await getDashboard();
    const body = await res.json();
    expect(body.totalGrams).toBe(1000);
  });

  it("a variant inherits spoolWeight from its parent (Codex P1 PR #190)", async () => {
    // Parent has spoolWeight=250; variant leaves it null. Pre-Codex-fix the
    // dashboard treated the variant's null as 0 and contributed the full
    // gross weight (1000) to totalGrams, re-introducing the original bug.
    const parent = await Filament.create({
      name: "Parent PLA",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 250,
      netFilamentWeight: 1000,
    });
    await Filament.create({
      name: "Variant Galaxy Black",
      vendor: "Test",
      type: "PLA",
      color: "#1a1a2e",
      parentId: parent._id,
      // spoolWeight + netFilamentWeight intentionally omitted — inherit.
      spools: [{ label: "v1", totalWeight: 1000 }],
    });

    const res = await getDashboard();
    const body = await res.json();
    // Variant should contribute (1000 - 250) = 750, NOT 1000.
    expect(body.totalGrams).toBe(750);
  });

  it("low-stock alert fires for a variant whose remaining (after inherited spoolWeight) is below threshold", async () => {
    const parent = await Filament.create({
      name: "LS Parent",
      vendor: "Test",
      type: "PLA",
      spoolWeight: 500,
      netFilamentWeight: 1000,
    });
    const variant = await Filament.create({
      name: "LS Variant",
      vendor: "Test",
      type: "PLA",
      color: "#fff",
      parentId: parent._id,
      lowStockThreshold: 200,
      // 600 - inherited 500 = 100 remaining → below threshold 200.
      spools: [{ label: "low", totalWeight: 600 }],
    });

    const res = await getDashboard();
    const body = await res.json();
    const ids = (body.lowStock as { _id: string }[]).map((x) => x._id);
    expect(ids).toContain(String(variant._id));
  });
});

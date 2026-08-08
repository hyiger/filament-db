import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { firstVariantGateInfo } from "@/lib/firstVariantGate";

/**
 * GH #1073 — direct unit coverage of the shared bulk-import first-variant
 * adoption gate, extracted from src/lib/importFilaments.ts so the INI and
 * Bambu bulk phase-2 resurrect paths share the identical decision. Every
 * branch is pinned here (the module is coverage-gated); the importer /
 * route suites cover the integration wiring.
 */
describe("firstVariantGateInfo (GH #605 / #1073)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    Filament = (await import("@/models/Filament")).default;
  });

  it("missing/trashed parent (dangling ref) → no gate, no threshold flag", async () => {
    const gone = new mongoose.Types.ObjectId();
    expect(await firstVariantGateInfo(Filament, gone)).toEqual({
      reason: null,
      orphanedThreshold: false,
    });

    const trashed = await Filament.create({
      name: "Trashed Gate Parent",
      vendor: "V",
      type: "PLA",
      spools: [{ label: "roll", totalWeight: 500 }],
      _deletedAt: new Date(),
    });
    expect(await firstVariantGateInfo(Filament, trashed._id)).toEqual({
      reason: null,
      orphanedThreshold: false,
    });
  });

  it("parent with no inventory and no threshold → write proceeds", async () => {
    const parent = await Filament.create({
      name: "Clean Gate Parent",
      vendor: "V",
      type: "PLA",
    });
    expect(await firstVariantGateInfo(Filament, parent._id)).toEqual({
      reason: null,
      orphanedThreshold: false,
    });
  });

  it("parent already a TEMPLATE (≥1 live variant) → nothing left to gate, even with inventory", async () => {
    const parent = await Filament.create({
      name: "Legacy Template Parent",
      vendor: "V",
      type: "PLA",
      spools: [{ label: "legacy roll", totalWeight: 500 }],
    });
    await Filament.create({
      name: "Legacy Template Parent — Red",
      vendor: "V",
      type: "PLA",
      parentId: parent._id,
    });
    expect(await firstVariantGateInfo(Filament, parent._id)).toEqual({
      reason: null,
      orphanedThreshold: false,
    });
  });

  it("threshold-ONLY parent → proceeds with orphanedThreshold: true", async () => {
    const parent = await Filament.create({
      name: "Threshold Only Gate Parent",
      vendor: "V",
      type: "PLA",
      color: null,
      lowStockThreshold: 100,
    });
    expect(await firstVariantGateInfo(Filament, parent._id)).toEqual({
      reason: null,
      orphanedThreshold: true,
    });
  });

  it("spool-carrying parent → gates, naming the spool count", async () => {
    const parent = await Filament.create({
      name: "Spooled Gate Parent",
      vendor: "V",
      type: "PLA",
      spools: [
        { label: "roll 1", totalWeight: 500 },
        { label: "roll 2", totalWeight: 750 },
      ],
    });
    const gate = await firstVariantGateInfo(Filament, parent._id);
    expect(gate.orphanedThreshold).toBe(false);
    expect(gate.reason).toMatch(/2 spool\(s\)/);
    expect(gate.reason).toMatch(/Convert to\s+template/);
  });

  it("totalWeight-only parent → gates on the tracked total weight", async () => {
    const parent = await Filament.create({
      name: "Weighted Gate Parent",
      vendor: "V",
      type: "PLA",
      totalWeight: 750,
    });
    const gate = await firstVariantGateInfo(Filament, parent._id);
    expect(gate.orphanedThreshold).toBe(false);
    expect(gate.reason).toMatch(/a tracked total weight/);
  });

  it("COLOR-carrying parent does NOT gate (schema default would break round-trips) and keeps its threshold flag off", async () => {
    const parent = await Filament.create({
      name: "Colored Gate Parent",
      vendor: "V",
      type: "PLA",
      color: "#ff0000",
      lowStockThreshold: 100,
    });
    // Color-carrying = the tolerated enforce-forward legacy shape; and the
    // threshold stays because the later "Convert to template" promotion
    // MOVES it with the rest (orphansThresholdOnFirstVariant reads false).
    expect(await firstVariantGateInfo(Filament, parent._id)).toEqual({
      reason: null,
      orphanedThreshold: false,
    });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import { stripLegacyMachineCondition } from "@/lib/stripLegacyNozzleCondition";

/**
 * GH #1021 — the INGESTION half: pre-upgrade fork presets /
 * INIs keep re-sending the stamped machine condition after the one-shot DB
 * cleanup; the write boundaries strip a provenance-matching incoming value.
 */
describe("stripLegacyMachineCondition", () => {
  beforeEach(async () => {
    await dbConnect();
    await Filament.deleteMany({ name: /^SLC / });
    await Nozzle.deleteMany({ name: /^SLC / });
  });

  const nozzle = (diameter: number) =>
    Nozzle.create({ name: `SLC ${diameter} ${Math.floor(diameter * 100)}`, diameter, type: "Brass" });

  it("strips a value that provenance-matches the target's own ticks (refs resolved)", async () => {
    const n4 = await nozzle(0.4);
    const n6 = await nozzle(0.6);
    const settings = {
      compatible_printers_condition: "nozzle_diameter[0]==0.4 or nozzle_diameter[0]==0.6",
      cooling: "1",
    };
    await stripLegacyMachineCondition(settings, { compatibleNozzles: [n6._id, n4._id] });
    expect(settings.compatible_printers_condition).toBe("");
    expect(settings.cooling).toBe("1"); // untouched sibling
  });

  it("preserves a pure nozzle pin that does NOT match the ticks' derivation", async () => {
    const n6 = await nozzle(0.6);
    const settings = { compatible_printers_condition: "nozzle_diameter[0]==0.4" };
    await stripLegacyMachineCondition(settings, { compatibleNozzles: [n6._id] });
    expect(settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
  });

  it("resolves a variant's ticks through its parent", async () => {
    const n4 = await nozzle(0.4);
    const parent = await Filament.create({
      name: "SLC Parent",
      vendor: "X",
      type: "PLA",
      compatibleNozzles: [n4._id],
    });
    const settings = { compatible_printers_condition: "nozzle_diameter[0]==0.4" };
    await stripLegacyMachineCondition(settings, { compatibleNozzles: [], parentId: parent._id });
    expect(settings.compatible_printers_condition).toBe("");
  });

  it("keeps the value when neither the target nor its parent has ticks (nothing provable)", async () => {
    const settings = { compatible_printers_condition: "nozzle_diameter[0]==0.4" };
    await stripLegacyMachineCondition(settings, { compatibleNozzles: [] });
    expect(settings.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");

    // A parentId that resolves to no active row behaves the same.
    const trashedParent = await Filament.create({
      name: "SLC Trashed",
      vendor: "X",
      type: "PLA",
      compatibleNozzles: [(await nozzle(0.4))._id],
    });
    await Filament.updateOne({ _id: trashedParent._id }, { $set: { _deletedAt: new Date() } });
    const settings2 = { compatible_printers_condition: "nozzle_diameter[0]==0.4" };
    await stripLegacyMachineCondition(settings2, {
      compatibleNozzles: [],
      parentId: trashedParent._id,
    });
    expect(settings2.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");

    // …as does a parent whose own ticks are empty.
    const emptyParent = await Filament.create({
      name: "SLC EmptyParent",
      vendor: "X",
      type: "PLA",
      compatibleNozzles: [],
    });
    const settings3 = { compatible_printers_condition: "nozzle_diameter[0]==0.4" };
    await stripLegacyMachineCondition(settings3, {
      compatibleNozzles: [],
      parentId: emptyParent._id,
    });
    expect(settings3.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
  });

  it("accepts populated-doc entries and dangling refs (normalized to ids; dangles contribute nothing)", async () => {
    const n4 = await nozzle(0.4);
    const populatedDoc = { _id: n4._id, diameter: 0.4 };
    const dangling = (await nozzle(9.9))._id;
    await Nozzle.deleteOne({ _id: dangling });
    const settings = { compatible_printers_condition: "nozzle_diameter[0]==0.4" };
    await stripLegacyMachineCondition(settings, {
      compatibleNozzles: [populatedDoc, dangling, null],
    });
    expect(settings.compatible_printers_condition).toBe("");

    // ALL refs dangling → no diameters → nothing provable → kept.
    const settings2 = { compatible_printers_condition: "nozzle_diameter[0]==0.4" };
    await stripLegacyMachineCondition(settings2, { compatibleNozzles: [dangling] });
    expect(settings2.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");

    // Only null-ish entries → no ids at all → kept without querying.
    const settings3 = { compatible_printers_condition: "nozzle_diameter[0]==0.4" };
    await stripLegacyMachineCondition(settings3, { compatibleNozzles: [null, undefined] });
    expect(settings3.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4");
  });

  it("no-ops on absent settings, absent key, non-string, and non-machine-grammar values", async () => {
    await expect(
      stripLegacyMachineCondition(null, { compatibleNozzles: [] }),
    ).resolves.toBeUndefined();
    await expect(
      stripLegacyMachineCondition(undefined, { compatibleNozzles: [] }),
    ).resolves.toBeUndefined();

    const noKey: Record<string, unknown> = { cooling: "1" };
    await stripLegacyMachineCondition(noKey, { compatibleNozzles: [] });
    expect(noKey).toEqual({ cooling: "1" });

    const n4 = await nozzle(0.4);
    for (const value of [
      null,
      "", // round-trip "no restriction"
      "printer_model==MK4 and nozzle_diameter[0]==0.4",
      "nozzle_diameter[0]>=0.4",
    ]) {
      const settings = { compatible_printers_condition: value };
      await stripLegacyMachineCondition(settings, { compatibleNozzles: [n4._id] });
      expect(settings.compatible_printers_condition).toBe(value);
    }
  });
});

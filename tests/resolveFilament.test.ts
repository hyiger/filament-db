import { describe, it, expect } from "vitest";
import { resolveFilament } from "@/lib/resolveFilament";

const makeParent = (overrides = {}) => ({
  _id: "parent-id",
  name: "Prusament PC Blend",
  vendor: "Prusament",
  type: "PC",
  color: "#333333",
  cost: 35,
  density: 1.22,
  diameter: 1.75,
  temperatures: {
    nozzle: 275,
    nozzleFirstLayer: 280,
    bed: 110,
    bedFirstLayer: 115,
  },
  maxVolumetricSpeed: 8,
  compatibleNozzles: ["nozzle-1", "nozzle-2"],
  calibrations: [
    { nozzle: "nozzle-1", extrusionMultiplier: 0.95, maxVolumetricSpeed: null, pressureAdvance: 0.05, retractLength: null, retractSpeed: null, retractLift: null },
  ],
  tdsUrl: "https://example.com/tds.pdf",
  inherits: "Generic PC",
  parentId: null,
  settings: { chamber_temperature: "40", filament_retract_length: "0.8" },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeVariant = (overrides = {}) => ({
  _id: "variant-id",
  name: "Prusament PC Blend - Galaxy Black",
  vendor: "",
  type: "",
  color: "#1a1a2e",
  cost: null,
  density: null,
  diameter: null,
  temperatures: {
    nozzle: null,
    nozzleFirstLayer: null,
    bed: null,
    bedFirstLayer: null,
  },
  maxVolumetricSpeed: null,
  compatibleNozzles: [],
  calibrations: [],
  tdsUrl: null,
  inherits: null,
  parentId: "parent-id",
  settings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("resolveFilament", () => {
  it("returns standalone filament unchanged with empty _inherited", () => {
    const standalone = makeParent();
    const result = resolveFilament(standalone, null);
    expect(result._inherited).toEqual([]);
    expect(result.name).toBe("Prusament PC Blend");
    expect(result.vendor).toBe("Prusament");
  });

  it("inherits vendor and type from parent when variant has empty values", () => {
    const parent = makeParent();
    const variant = makeVariant();
    const result = resolveFilament(variant, parent);
    expect(result.vendor).toBe("Prusament");
    expect(result.type).toBe("PC");
    expect(result._inherited).toContain("vendor");
    expect(result._inherited).toContain("type");
  });

  it("keeps variant name and color (never inherited)", () => {
    const parent = makeParent();
    const variant = makeVariant();
    const result = resolveFilament(variant, parent);
    expect(result.name).toBe("Prusament PC Blend - Galaxy Black");
    expect(result.color).toBe("#1a1a2e");
    expect(result._inherited).not.toContain("name");
    expect(result._inherited).not.toContain("color");
  });

  it("inherits temperatures from parent", () => {
    const parent = makeParent();
    const variant = makeVariant();
    const result = resolveFilament(variant, parent);
    expect(result.temperatures.nozzle).toBe(275);
    expect(result.temperatures.bed).toBe(110);
    expect(result._inherited).toContain("temperatures.nozzle");
    expect(result._inherited).toContain("temperatures.bed");
  });

  it("variant can override individual temperature fields", () => {
    const parent = makeParent();
    const variant = makeVariant({
      temperatures: { nozzle: 270, nozzleFirstLayer: null, bed: null, bedFirstLayer: null },
    });
    const result = resolveFilament(variant, parent);
    expect(result.temperatures.nozzle).toBe(270);
    expect(result.temperatures.bed).toBe(110); // inherited
    expect(result._inherited).not.toContain("temperatures.nozzle");
    expect(result._inherited).toContain("temperatures.bed");
  });

  it("inherits density and diameter from parent", () => {
    const parent = makeParent();
    const variant = makeVariant();
    const result = resolveFilament(variant, parent);
    expect(result.density).toBe(1.22);
    expect(result._inherited).toContain("density");
  });

  it("variant can override cost", () => {
    const parent = makeParent();
    const variant = makeVariant({ cost: 40 });
    const result = resolveFilament(variant, parent);
    expect(result.cost).toBe(40);
    expect(result._inherited).not.toContain("cost");
  });

  it("inherits compatibleNozzles when variant has none", () => {
    const parent = makeParent();
    const variant = makeVariant();
    const result = resolveFilament(variant, parent);
    expect(result.compatibleNozzles).toEqual(["nozzle-1", "nozzle-2"]);
    expect(result._inherited).toContain("compatibleNozzles");
  });

  it("variant can override compatibleNozzles", () => {
    const parent = makeParent();
    const variant = makeVariant({ compatibleNozzles: ["nozzle-3"] });
    const result = resolveFilament(variant, parent);
    expect(result.compatibleNozzles).toEqual(["nozzle-3"]);
    expect(result._inherited).not.toContain("compatibleNozzles");
  });

  it("inherits calibrations when variant has none", () => {
    const parent = makeParent();
    const variant = makeVariant();
    const result = resolveFilament(variant, parent);
    expect(result.calibrations).toHaveLength(1);
    expect(result._inherited).toContain("calibrations");
  });

  it("merges settings — parent base with variant overrides", () => {
    const parent = makeParent();
    const variant = makeVariant({
      settings: { chamber_temperature: "50" },
    });
    const result = resolveFilament(variant, parent);
    expect(result.settings.chamber_temperature).toBe("50"); // variant override
    expect(result.settings.filament_retract_length).toBe("0.8"); // from parent
  });

  it("inherits tdsUrl from parent", () => {
    const parent = makeParent();
    const variant = makeVariant();
    const result = resolveFilament(variant, parent);
    expect(result.tdsUrl).toBe("https://example.com/tds.pdf");
    expect(result._inherited).toContain("tdsUrl");
  });

  it("variant can override tdsUrl", () => {
    const parent = makeParent();
    const variant = makeVariant({ tdsUrl: "https://example.com/variant-tds.pdf" });
    const result = resolveFilament(variant, parent);
    expect(result.tdsUrl).toBe("https://example.com/variant-tds.pdf");
    expect(result._inherited).not.toContain("tdsUrl");
  });

  it("handles missing parent gracefully (no parentId)", () => {
    const variant = makeVariant({ parentId: null });
    const result = resolveFilament(variant, null);
    expect(result._inherited).toEqual([]);
    expect(result.vendor).toBe("");
  });

  it("does not inherit spools from parent (variant-only field)", () => {
    const parent = makeParent({
      spools: [{ _id: "spool-1", label: "Parent Spool", totalWeight: 800 }],
    });
    const variant = makeVariant({
      spools: [{ _id: "spool-2", label: "Variant Spool", totalWeight: 500 }],
    });
    const result = resolveFilament(variant, parent);
    expect(result.spools).toHaveLength(1);
    expect(result.spools[0].label).toBe("Variant Spool");
  });

  it("variant with empty spools does not get parent spools", () => {
    const parent = makeParent({
      spools: [{ _id: "spool-1", label: "Parent Spool", totalWeight: 800 }],
    });
    const variant = makeVariant({ spools: [] });
    const result = resolveFilament(variant, parent);
    expect(result.spools).toEqual([]);
  });

  it("inherits spoolWeight and netFilamentWeight from parent", () => {
    const parent = makeParent({ spoolWeight: 200, netFilamentWeight: 1000 });
    const variant = makeVariant({ spoolWeight: null, netFilamentWeight: null });
    const result = resolveFilament(variant, parent);
    expect(result.spoolWeight).toBe(200);
    expect(result.netFilamentWeight).toBe(1000);
    expect(result._inherited).toContain("spoolWeight");
    expect(result._inherited).toContain("netFilamentWeight");
  });

  it("inherits presets when variant has none", () => {
    const parent = makeParent({
      presets: [{ label: "Default", extrusionMultiplier: 0.95, temperatures: { nozzle: 275, nozzleFirstLayer: null, bed: null, bedFirstLayer: null } }],
    });
    const variant = makeVariant({ presets: [] });
    const result = resolveFilament(variant, parent);
    expect(result.presets).toHaveLength(1);
    expect(result._inherited).toContain("presets");
  });

  it("inherits settings fully when variant has none", () => {
    const parent = makeParent();
    const variant = makeVariant({ settings: {} });
    const result = resolveFilament(variant, parent);
    expect(result.settings.chamber_temperature).toBe("40");
    expect(result._inherited).toContain("settings");
  });
});

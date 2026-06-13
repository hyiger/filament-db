import { describe, expect, it } from "vitest";
import { decodedTagToFilamentPayload } from "@/lib/decodedTagToFilament";
import type { DecodedOpenPrintTag } from "@/lib/openprinttag-decode";

function tag(overrides: Partial<DecodedOpenPrintTag> = {}): DecodedOpenPrintTag {
  return { meta: {}, main: {}, ...overrides };
}

describe("decodedTagToFilamentPayload", () => {
  it("maps a typical OpenPrintTag into a creation payload", () => {
    const p = decodedTagToFilamentPayload(
      tag({
        brandName: "Prusament",
        materialName: "PLA Galaxy Black",
        materialType: "PLA",
        color: "#1a1a2e",
        density: 1.24,
        diameter: 1.75,
        nozzleTemp: 215,
        nozzleTempMin: 205,
        bedTemp: 60,
        preheatTemp: 170,
        dryingTemperature: 45,
        dryingTime: 480,
        transmissionDistance: 3,
        tags: [4, 12],
      }),
    );
    expect(p.name).toBe("Prusament PLA Galaxy Black");
    expect(p.vendor).toBe("Prusament");
    expect(p.type).toBe("PLA");
    expect(p.color).toBe("#1a1a2e");
    expect(p.density).toBe(1.24);
    expect(p.diameter).toBe(1.75);
    expect(p.temperatures).toEqual({
      nozzle: 215,
      nozzleFirstLayer: null,
      nozzleRangeMin: 205,
      nozzleRangeMax: 215,
      bed: 60,
      bedFirstLayer: null,
      standby: 170,
    });
    expect(p.dryingTemperature).toBe(45);
    expect(p.dryingTime).toBe(480);
    expect(p.transmissionDistance).toBe(3);
    // Decoded `tags` are already numeric OPT_TAG enum values — passed through.
    expect(p.optTags).toEqual([4, 12]);
  });

  it("derives a name from whatever the tag carries", () => {
    expect(decodedTagToFilamentPayload(tag({ brandName: "X", materialName: "Y" })).name).toBe("X Y");
    expect(decodedTagToFilamentPayload(tag({ materialName: "Only Material" })).name).toBe("Only Material");
    expect(decodedTagToFilamentPayload(tag({ brandName: "Only Brand" })).name).toBe("Only Brand");
    expect(decodedTagToFilamentPayload(tag({ materialType: "PETG" })).name).toBe("PETG");
    expect(decodedTagToFilamentPayload(tag()).name).toBe("Scanned filament");
  });

  it("does not duplicate the brand when materialName already includes it", () => {
    // FDB-written tags store the FULL filament name in materialName.
    expect(
      decodedTagToFilamentPayload(tag({ brandName: "Prusament", materialName: "Prusament PLA Galaxy Black" })).name,
    ).toBe("Prusament PLA Galaxy Black");
    // Community tags carry the bare material → the brand is still prefixed.
    expect(
      decodedTagToFilamentPayload(tag({ brandName: "Prusament", materialName: "PLA Galaxy Black" })).name,
    ).toBe("Prusament PLA Galaxy Black");
  });

  it("maps the tag's roll weight + tare to filament-level fields (no spool subdoc)", () => {
    const p = decodedTagToFilamentPayload(tag({ weightGrams: 1000, emptySpoolWeight: 215 }));
    expect(p.netFilamentWeight).toBe(1000);
    expect(p.spoolWeight).toBe(215);
    expect("spools" in p).toBe(false);
  });

  it("defaults weight fields to null when the tag omits them", () => {
    const p = decodedTagToFilamentPayload(tag({ brandName: "B", materialName: "M", materialType: "PLA" }));
    expect(p.netFilamentWeight).toBeNull();
    expect(p.spoolWeight).toBeNull();
  });

  it("preserves a null primary for coextruded/multi-color tags", () => {
    const p = decodedTagToFilamentPayload(
      tag({ color: undefined, secondaryColors: ["#ff0000", "#00ff00"] }),
    );
    expect(p.color).toBeNull();
    expect(p.secondaryColors).toEqual(["#ff0000", "#00ff00"]);
  });

  it("falls back to gray only when the tag has no colors at all", () => {
    const p = decodedTagToFilamentPayload(tag({ color: undefined, secondaryColors: [] }));
    expect(p.color).toBe("#808080");
    expect(p.secondaryColors).toEqual([]);
  });

  it("prefers the tag's own diameter (2.85mm) over the 1.75 default", () => {
    expect(decodedTagToFilamentPayload(tag({ diameter: 2.85 })).diameter).toBe(2.85);
    expect(decodedTagToFilamentPayload(tag({ diameter: undefined })).diameter).toBe(1.75);
  });

  it("captures shore hardness A and D (a physical tag carries both)", () => {
    const p = decodedTagToFilamentPayload(tag({ shoreHardnessA: 95, shoreHardnessD: 40 }));
    expect(p.shoreHardnessA).toBe(95);
    expect(p.shoreHardnessD).toBe(40);
  });

  it("never adopts the tag's spool_uid as instanceId (stays system-assigned)", () => {
    // Adopting an unsigned tag's spool_uid would make instanceId client-writable
    // (a forgeable scan-match target) and could 409 against the partial-unique
    // index — so the mapper must not emit instanceId at all.
    expect("instanceId" in decodedTagToFilamentPayload(tag({ spoolUid: "0a1b2c3d4e" }))).toBe(false);
    expect("instanceId" in decodedTagToFilamentPayload(tag())).toBe(false);
  });

  it("emits null for absent required identity fields (caller must override)", () => {
    const p = decodedTagToFilamentPayload(tag({ materialName: "Mystery" }));
    expect(p.vendor).toBeNull();
    expect(p.type).toBeNull();
  });

  it("defaults missing numeric fields to null and tags to an empty array", () => {
    const p = decodedTagToFilamentPayload(tag({ brandName: "B", materialName: "M", materialType: "PLA" }));
    expect(p.density).toBeNull();
    expect(p.transmissionDistance).toBeNull();
    expect(p.optTags).toEqual([]);
    expect(p.temperatures).toEqual({
      nozzle: null,
      nozzleFirstLayer: null,
      nozzleRangeMin: null,
      nozzleRangeMax: null,
      bed: null,
      bedFirstLayer: null,
      standby: null,
    });
  });
});

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
    // OpenPrintTag carries neither → null (no-op).
    expect(p.colorName).toBeNull();
    expect(p.maxVolumetricSpeed).toBeNull();
  });

  it("#864: carries OpenTag3D colorName + maxVolumetricSpeed onto the create payload", () => {
    const p = decodedTagToFilamentPayload(
      tag({
        tagSource: "opentag3d",
        materialName: "PETG",
        materialType: "PETG",
        brandName: "Polar Filament",
        colorName: "Electric Watermelon",
        maxVolumetricSpeed: 15,
      }),
    );
    expect(p.colorName).toBe("Electric Watermelon");
    expect(p.maxVolumetricSpeed).toBe(15);
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

  // ── GH #1008 F6: for a RANGED OpenTag3D tag, decoded.nozzleTemp is the
  //    Extended range MAX; the Core RECOMMENDED print_temp survives only in
  //    aux.opentag3d_recommended_print_temp_c (stashed exactly when a distinct
  //    max exists). The create payload must map the recommended value to the
  //    everyday temp, keeping the max on nozzleRangeMax — otherwise a filament
  //    written with nozzle=215/rangeMax=230 scans back and creates with 230. ──

  it("#1008 F6: OpenTag3D ranged tag — everyday nozzle/bed = the Core RECOMMENDED, max stays on nozzleRangeMax", () => {
    const p = decodedTagToFilamentPayload(
      tag({
        tagSource: "opentag3d",
        brandName: "Polar Filament",
        materialName: "PETG",
        materialType: "PETG",
        nozzleTemp: 230, // = Extended max_print_temp
        nozzleTempMin: 190,
        bedTemp: 70, // = Extended max_bed_temp
        aux: {
          opentag3d_recommended_print_temp_c: 215,
          opentag3d_recommended_bed_temp_c: 60,
        },
      }),
    );
    expect(p.temperatures).toEqual({
      nozzle: 215, // everyday = recommended, NOT the range max
      nozzleFirstLayer: null,
      nozzleRangeMin: 190,
      nozzleRangeMax: 230, // the max survives on the range field
      bed: 60, // bed likewise prefers the recommended value
      bedFirstLayer: null,
      standby: null,
    });
  });

  it("#1008 F6: falls back to decoded.nozzleTemp/bedTemp when no recommended aux key exists", () => {
    // A Core-only OpenTag3D image (no Extended max): nozzleTemp IS the
    // recommended value and no aux key is stashed. Unrelated aux keys must not
    // interfere; OpenPrintTag / Bambu decodes (no opentag3d_* aux) take this
    // same path — pinned by the OPT test at the top of this file too.
    const p = decodedTagToFilamentPayload(
      tag({
        tagSource: "opentag3d",
        nozzleTemp: 215,
        bedTemp: 60,
        aux: { opentag3d_serial: "abc123" },
      }),
    );
    const temps = p.temperatures as Record<string, number | null>;
    expect(temps.nozzle).toBe(215);
    expect(temps.nozzleRangeMax).toBe(215);
    expect(temps.bed).toBe(60);
  });

  it("#1008 F6: coerces numeric-string aux temps; an empty string falls back", () => {
    const p = decodedTagToFilamentPayload(
      tag({
        tagSource: "opentag3d",
        nozzleTemp: 230,
        bedTemp: 70,
        aux: {
          opentag3d_recommended_print_temp_c: "215", // string → coerced
          opentag3d_recommended_bed_temp_c: "  ", // blank → ignored
        },
      }),
    );
    const temps = p.temperatures as Record<string, number | null>;
    expect(temps.nozzle).toBe(215);
    expect(temps.bed).toBe(70); // fell back to the decoded bed temp
  });

  it("#1008 F6: ignores non-finite / non-numeric aux junk and falls back to the decoded temps", () => {
    const p = decodedTagToFilamentPayload(
      tag({
        tagSource: "opentag3d",
        nozzleTemp: 230,
        bedTemp: 70,
        aux: {
          opentag3d_recommended_print_temp_c: "not-a-number", // NaN → ignored
          opentag3d_recommended_bed_temp_c: { nested: true }, // object → ignored
        },
      }),
    );
    const temps = p.temperatures as Record<string, number | null>;
    expect(temps.nozzle).toBe(230);
    expect(temps.bed).toBe(70);
  });
});

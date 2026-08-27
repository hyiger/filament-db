import { describe, expect, it } from "vitest";
import { pruneParentEqualPrefill } from "@/lib/nfcVariantPrefill";

// GH #1177 Phase 1 — a variant-from-tag prefill must not seed explicit
// overrides that merely EQUAL the parent's values (they would sever GH #106
// live inheritance). Mirrors the v1.52 pruneOptPayloadAgainstParent rule.

describe("pruneParentEqualPrefill", () => {
  it("drops inheritable scalars equal to the parent's value", () => {
    const out = pruneParentEqualPrefill(
      { density: 1.24, diameter: 1.75, maxVolumetricSpeed: 15, name: "Galaxy Black" },
      { density: 1.24, diameter: 1.75, maxVolumetricSpeed: 15 },
    );
    expect(out).toEqual({ name: "Galaxy Black" });
  });

  it("keeps scalars that differ from the parent as genuine overrides", () => {
    const out = pruneParentEqualPrefill(
      { density: 1.27, shoreHardnessD: 55 },
      { density: 1.24, shoreHardnessD: 60 },
    );
    expect(out).toEqual({ density: 1.27, shoreHardnessD: 55 });
  });

  it("keeps a tag value the parent lacks — nothing to inherit", () => {
    const out = pruneParentEqualPrefill(
      { density: 1.24, netFilamentWeight: 1000 },
      { density: null, netFilamentWeight: undefined },
    );
    expect(out).toEqual({ density: 1.24, netFilamentWeight: 1000 });
  });

  it("prunes spool spec (tare / net) but never totalWeight inventory", () => {
    const out = pruneParentEqualPrefill(
      { spoolWeight: 216, netFilamentWeight: 1000, totalWeight: 750 },
      { spoolWeight: 216, netFilamentWeight: 1000 },
    );
    expect(out).toEqual({ totalWeight: 750 });
  });

  it("preserves the Codex #706 r7/r8 zero-tare pin when the parent's tare differs", () => {
    const out = pruneParentEqualPrefill(
      { spoolWeight: 0, totalWeight: 480 },
      { spoolWeight: 216 },
    );
    expect(out).toEqual({ spoolWeight: 0, totalWeight: 480 });
  });

  it("nulls temperature subfields equal to the parent's, individually", () => {
    const out = pruneParentEqualPrefill(
      {
        temperatures: { nozzle: 215, nozzleFirstLayer: 220, bed: 60, bedFirstLayer: null },
      },
      { temperatures: { nozzle: 215, nozzleFirstLayer: 230, bed: null, bedFirstLayer: 65 } },
    );
    expect(out.temperatures).toEqual({
      nozzle: null, // equal → inherit
      nozzleFirstLayer: 220, // differs → keep
      bed: 60, // parent has none → keep
      bedFirstLayer: null, // tag has none → stays blank
    });
  });

  it("leaves temperatures untouched when either side lacks the object", () => {
    expect(
      pruneParentEqualPrefill({ temperatures: { nozzle: 215 } }, { temperatures: null }),
    ).toEqual({ temperatures: { nozzle: 215 } });
    expect(pruneParentEqualPrefill({ name: "x" }, { temperatures: { nozzle: 215 } })).toEqual({
      name: "x",
    });
  });

  it("prunes optTags on set-equality regardless of order", () => {
    expect(
      pruneParentEqualPrefill({ optTags: [28, 3, 27] }, { optTags: [3, 27, 28] }),
    ).toEqual({});
    expect(
      pruneParentEqualPrefill({ optTags: [28, 3] }, { optTags: [3, 27, 28] }),
    ).toEqual({ optTags: [28, 3] });
  });

  it("prunes secondaryColors POSITIONALLY, case-folded — slots are ordered (Codex P2 #1183)", () => {
    expect(
      pruneParentEqualPrefill(
        { secondaryColors: ["#AABBCC", "#112233"] },
        { secondaryColors: ["#aabbcc", "#112233"] },
      ),
    ).toEqual({});
    // Same colors, different order: gradients render in slot order and slot 0
    // is the representative export color — the tag's ordering is real data.
    expect(
      pruneParentEqualPrefill(
        { secondaryColors: ["#AABBCC", "#112233"] },
        { secondaryColors: ["#112233", "#aabbcc"] },
      ),
    ).toEqual({ secondaryColors: ["#AABBCC", "#112233"] });
    expect(
      pruneParentEqualPrefill(
        { secondaryColors: ["#AABBCC"] },
        { secondaryColors: ["#112233"] },
      ),
    ).toEqual({ secondaryColors: ["#AABBCC"] });
    expect(
      pruneParentEqualPrefill(
        { secondaryColors: ["#AABBCC"] },
        { secondaryColors: ["#112233", "#aabbcc"] },
      ),
    ).toEqual({ secondaryColors: ["#AABBCC"] });
  });

  it("prunes parent-equal settings-bag strings, keeps differing/missing ones (Codex P2 #1183)", () => {
    const out = pruneParentEqualPrefill(
      { settings: { chamber_temperature: "45", filament_notes: '"Origin: CZ"' } },
      { settings: { chamber_temperature: "45", filament_notes: '"Origin: DE"' } },
    );
    expect(out.settings).toEqual({ filament_notes: '"Origin: CZ"' });
    // No parent bag at all → untouched.
    expect(
      pruneParentEqualPrefill({ settings: { chamber_temperature: "45" } }, {}),
    ).toEqual({ settings: { chamber_temperature: "45" } });
    // Non-string parent value (array/nil) never matches.
    expect(
      pruneParentEqualPrefill(
        { settings: { chamber_temperature: "45" } },
        { settings: { chamber_temperature: ["45"] } },
      ),
    ).toEqual({ settings: { chamber_temperature: "45" } });
  });

  it("never prunes an empty prefill array — empty already means inherit (GH #477)", () => {
    const out = pruneParentEqualPrefill(
      { optTags: [], secondaryColors: [] },
      { optTags: [27], secondaryColors: ["#112233"] },
    );
    expect(out).toEqual({ optTags: [], secondaryColors: [] });
  });

  it("does not mutate its input", () => {
    const prefill = { density: 1.24, temperatures: { nozzle: 215 } };
    pruneParentEqualPrefill(prefill, { density: 1.24, temperatures: { nozzle: 215 } });
    expect(prefill).toEqual({ density: 1.24, temperatures: { nozzle: 215 } });
  });
});

import { describe, it, expect } from "vitest";
import {
  buildOptSnapshot,
  diffOptFields,
  buildOptSyncUpdate,
  optSnapshotKey,
  OPT_MANAGED_FIELD_KEYS,
} from "@/lib/optResync";

/**
 * GH #607 Phase 1 — pure diff + provenance classification.
 *
 * The "payload" arguments below mirror what `mapToFilamentPayload` emits
 * (verified by tests/openprinttagBrowser.test.ts), so this file can stay
 * DB-free and fast.
 */

// A realistic mapped-OPT payload for a single-color PLA.
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Prusament PLA Galaxy Black",
    vendor: "Prusament",
    type: "PLA",
    color: "#3d3e3d",
    secondaryColors: [],
    density: 1.24,
    diameter: 1.75,
    temperatures: {
      nozzle: 225,
      nozzleFirstLayer: null,
      nozzleRangeMin: 205,
      nozzleRangeMax: 225,
      bed: 60,
      bedFirstLayer: null,
      standby: 170,
    },
    dryingTemperature: null,
    dryingTime: null,
    shoreHardnessD: 81,
    transmissionDistance: 0.2,
    optTags: [],
    ...overrides,
  };
}

describe("optSnapshotKey", () => {
  it("replaces dots so nested temp paths are Mongo-safe", () => {
    expect(optSnapshotKey("temperatures.nozzle")).toBe("temperatures_nozzle");
    expect(optSnapshotKey("density")).toBe("density");
  });
});

describe("buildOptSnapshot", () => {
  it("captures every OPT-offered managed field, dot-free, skipping null/empty", () => {
    const snap = buildOptSnapshot(payload());
    expect(snap).toEqual({
      color: "#3d3e3d",
      density: 1.24,
      temperatures_nozzle: 225,
      temperatures_nozzleRangeMin: 205,
      temperatures_nozzleRangeMax: 225,
      temperatures_bed: 60,
      temperatures_standby: 170,
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    });
  });

  it("omits fields OPT doesn't carry (null + empty array)", () => {
    const snap = buildOptSnapshot(
      payload({ dryingTemperature: null, dryingTime: null, secondaryColors: [], optTags: [] }),
    );
    expect(snap).not.toHaveProperty("dryingTemperature");
    expect(snap).not.toHaveProperty("dryingTime");
    expect(snap).not.toHaveProperty("secondaryColors");
    expect(snap).not.toHaveProperty("optTags");
    // shoreHardnessD IS present (81) under its dotted-free key.
    expect(snap.shoreHardnessD).toBe(81);
  });

  it("includes secondaryColors + optTags when populated, preserving numeric tags", () => {
    const snap = buildOptSnapshot(
      payload({ color: null, secondaryColors: ["#000000", "#98282f"], optTags: [17, 27] }),
    );
    expect(snap.secondaryColors).toEqual(["#000000", "#98282f"]);
    // GH #607 (Codex P2): tags stay numbers so a sync writes the [Number]
    // schema, not strings.
    expect(snap.optTags).toEqual([17, 27]);
    // A coextruded material's null primary isn't recorded (null = no offer);
    // valuesEqual treats null ≈ [] so the diff still compares correctly.
    expect(snap).not.toHaveProperty("color");
  });

  it("records the gray sentinel color as absent (not a real offer)", () => {
    const snap = buildOptSnapshot(payload({ color: "#808080" }));
    expect(snap).not.toHaveProperty("color");
  });
});

describe("diffOptFields", () => {
  it("returns no changes when the row already matches OPT", () => {
    const stored = {
      color: "#3d3e3d",
      secondaryColors: [],
      density: 1.24,
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    };
    expect(diffOptFields(stored, payload(), null)).toEqual([]);
  });

  it("classifies a null local field as adopt (gap-fill)", () => {
    const stored = { color: "#3d3e3d", density: null, temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 }, shoreHardnessD: 81, transmissionDistance: 0.2 };
    const changes = diffOptFields(stored, payload(), null);
    const d = changes.find((c) => c.field === "density");
    expect(d).toBeDefined();
    expect(d!.kind).toBe("adopt");
    expect(d!.current).toBeNull();
    expect(d!.incoming).toBe(1.24);
  });

  it("classifies the #808080 color sentinel as adopt", () => {
    const stored = { color: "#808080", density: 1.24, temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 }, shoreHardnessD: 81, transmissionDistance: 0.2 };
    const changes = diffOptFields(stored, payload(), null);
    const c = changes.find((x) => x.field === "color");
    expect(c).toBeDefined();
    expect(c!.kind).toBe("adopt");
  });

  it("classifies an edited field with no snapshot as conflict", () => {
    // User set nozzle 215; OPT says 225; no provenance to prove safe.
    const stored = { color: "#3d3e3d", density: 1.24, temperatures: { nozzle: 215, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 }, shoreHardnessD: 81, transmissionDistance: 0.2 };
    const changes = diffOptFields(stored, payload(), null);
    const n = changes.find((c) => c.field === "temperatures.nozzle");
    expect(n).toBeDefined();
    expect(n!.kind).toBe("conflict");
    expect(n!.current).toBe(215);
    expect(n!.incoming).toBe(225);
  });

  it("classifies an unedited OPT-owned field as adopt when upstream changed", () => {
    // Snapshot says OPT last wrote 220 and local is still 220 → unedited.
    // OPT now offers 225 → safe to adopt.
    const stored = { color: "#3d3e3d", density: 1.24, temperatures: { nozzle: 220, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 }, shoreHardnessD: 81, transmissionDistance: 0.2 };
    const snapshot = { temperatures_nozzle: 220 };
    const changes = diffOptFields(stored, payload(), snapshot);
    const n = changes.find((c) => c.field === "temperatures.nozzle");
    expect(n).toBeDefined();
    expect(n!.kind).toBe("adopt");
  });

  it("classifies an edited field as conflict when local diverged from the snapshot", () => {
    // OPT last wrote 220 (snapshot), user changed local to 215, OPT now 225.
    const stored = { color: "#3d3e3d", density: 1.24, temperatures: { nozzle: 215, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 }, shoreHardnessD: 81, transmissionDistance: 0.2 };
    const snapshot = { temperatures_nozzle: 220 };
    const changes = diffOptFields(stored, payload(), snapshot);
    const n = changes.find((c) => c.field === "temperatures.nozzle");
    expect(n!.kind).toBe("conflict");
  });

  it("skips fields OPT doesn't carry even when the local value is set", () => {
    // OPT has no dryingTemperature; local has one. Nothing to offer → omit.
    const stored = { color: "#3d3e3d", density: 1.24, temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 }, shoreHardnessD: 81, transmissionDistance: 0.2, dryingTemperature: 55 };
    const changes = diffOptFields(stored, payload({ dryingTemperature: null }), null);
    expect(changes.find((c) => c.field === "dryingTemperature")).toBeUndefined();
  });

  it("surfaces an explicit upstream clear: single-color → coextruded (GH #607 Codex P2)", () => {
    // Local is single-color (#3d3e3d, no secondaries). OPT changed the
    // material to coextruded: primary null + secondaries populated. Both the
    // primary clear AND the new secondaries must show.
    const stored = {
      color: "#3d3e3d",
      secondaryColors: [],
      density: 1.24,
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    };
    const changes = diffOptFields(
      stored,
      payload({ color: null, secondaryColors: ["#000000", "#98282f"] }),
      null,
    );
    const color = changes.find((c) => c.field === "color");
    expect(color).toBeDefined();
    expect(color!.current).toBe("#3d3e3d");
    expect(color!.incoming).toBeNull(); // the clear is offered
    expect(color!.kind).toBe("conflict"); // user had a real color, no snapshot

    const sec = changes.find((c) => c.field === "secondaryColors");
    expect(sec).toBeDefined();
    expect(sec!.kind).toBe("adopt"); // local secondaries were empty → gap-fill
    expect(sec!.incoming).toEqual(["#000000", "#98282f"]);
  });

  it("surfaces an upstream clear of secondaryColors / optTags", () => {
    const stored = {
      color: "#3d3e3d",
      secondaryColors: ["#000000", "#98282f"],
      optTags: [17, 27],
      density: 1.24,
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    };
    // OPT dropped both arrays (back to a plain single color).
    const changes = diffOptFields(
      stored,
      payload({ color: "#3d3e3d", secondaryColors: [], optTags: [] }),
      null,
    );
    expect(changes.find((c) => c.field === "secondaryColors")?.incoming).toEqual([]);
    expect(changes.find((c) => c.field === "optTags")?.incoming).toEqual([]);
  });

  it("never offers to push the gray sentinel onto a user's real color", () => {
    const stored = {
      color: "#ff0000",
      density: 1.24,
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    };
    // OPT has no real color → mapToFilamentPayload emits the #808080 sentinel.
    const changes = diffOptFields(stored, payload({ color: "#808080" }), null);
    expect(changes.find((c) => c.field === "color")).toBeUndefined();
  });

  it("does NOT offer to clear a non-clearable field OPT simply lacks", () => {
    // OPT material has no density (null incoming). Local density 1.5 must be
    // left alone — a sparse upstream entry shouldn't wipe good local data.
    const stored = {
      color: "#3d3e3d",
      density: 1.5,
      temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 },
      shoreHardnessD: 81,
      transmissionDistance: 0.2,
    };
    const changes = diffOptFields(stored, payload({ density: null }), null);
    expect(changes.find((c) => c.field === "density")).toBeUndefined();
  });

  it("diffs secondaryColors order-sensitively", () => {
    const stored = { color: null, secondaryColors: ["#000000", "#98282f"], density: 1.24, temperatures: { nozzle: 225, nozzleRangeMin: 205, nozzleRangeMax: 225, bed: 60, standby: 170 }, shoreHardnessD: 81, transmissionDistance: 0.2 };
    // OPT reordered the two colors → a real change.
    const changes = diffOptFields(
      stored,
      payload({ color: null, secondaryColors: ["#98282f", "#000000"] }),
      null,
    );
    const s = changes.find((c) => c.field === "secondaryColors");
    expect(s).toBeDefined();
    expect(s!.incoming).toEqual(["#98282f", "#000000"]);
  });
});

describe("buildOptSyncUpdate", () => {
  it("builds a $set patch only for selected, whitelisted fields", () => {
    const update = buildOptSyncUpdate(["density", "temperatures.nozzle"], payload());
    expect(update).toEqual({ density: 1.24, "temperatures.nozzle": 225 });
  });

  it("ignores fields not in the managed whitelist (no arbitrary $set)", () => {
    const update = buildOptSyncUpdate(["density", "name", "settings.openprinttag_slug", "__proto__"], payload());
    expect(update).toEqual({ density: 1.24 });
    expect(OPT_MANAGED_FIELD_KEYS.has("name")).toBe(false);
  });

  it("writes a null color when adopting a coextruded material's null primary", () => {
    const update = buildOptSyncUpdate(["color", "secondaryColors"], payload({ color: null, secondaryColors: ["#000000", "#98282f"] }));
    expect(update.color).toBeNull();
    expect(update.secondaryColors).toEqual(["#000000", "#98282f"]);
  });

  it("returns an empty patch when nothing valid is selected", () => {
    expect(buildOptSyncUpdate([], payload())).toEqual({});
    expect(buildOptSyncUpdate(["bogus"], payload())).toEqual({});
  });
});

import { describe, it, expect } from "vitest";
import { deriveFinish } from "@/lib/filamentFinish";

/**
 * deriveFinish() is the single source of truth for the texture treatment
 * on `<FilamentSwatch>` and the label on `<FinishChip>`. Two invariants:
 *
 *   1. Only specific optTag IDs map to a finish. Anything else (abrasive,
 *      water-soluble, blend, carbon-fiber, …) is ignored. The IDs are the
 *      OpenPrintTag SPEC enum (GH #1227): 20 transparent, 19 translucent,
 *      16 matte, 17 silk, 23 glitter (= "sparkle"), 24 glow_in_the_dark.
 *   2. When multiple finishes coexist, a fixed priority order chooses
 *      one: transparent → translucent → sparkle → silk → glow → matte.
 */
describe("deriveFinish", () => {
  it("returns null for empty / nullish input", () => {
    expect(deriveFinish(undefined)).toBeNull();
    expect(deriveFinish(null)).toBeNull();
    expect(deriveFinish([])).toBeNull();
  });

  it("returns null when no recognised finish tag is present", () => {
    // 4=abrasive, 9=high_temperature, 31=carbon fiber, 60=recycled — none map to a finish.
    expect(deriveFinish([4, 9, 31, 60])).toBeNull();
    // GH #1227: the PRE-#1227 app ids for transparent/translucent/sparkle
    // (2/3/22) are antibacterial/air_filtering/pearlescent on the wire — not finishes.
    expect(deriveFinish([2, 3, 22])).toBeNull();
  });

  it("maps each individual finish tag to its canonical string", () => {
    expect(deriveFinish([16])).toBe("matte");
    expect(deriveFinish([17])).toBe("silk");
    expect(deriveFinish([23])).toBe("sparkle");
    expect(deriveFinish([24])).toBe("glow");
    expect(deriveFinish([19])).toBe("translucent");
    expect(deriveFinish([20])).toBe("transparent");
  });

  it("ignores non-finish tags around a real finish tag", () => {
    expect(deriveFinish([4, 16, 71])).toBe("matte"); // matte sandwiched between abrasive + highSpeed
    expect(deriveFinish([23, 9])).toBe("sparkle");
  });

  it("transparent beats every other finish", () => {
    expect(deriveFinish([20, 19, 16, 17, 23, 24])).toBe("transparent");
  });

  it("translucent beats silk/sparkle/glow/matte when transparent is absent", () => {
    expect(deriveFinish([19, 23])).toBe("translucent");
    expect(deriveFinish([19, 17])).toBe("translucent");
    expect(deriveFinish([19, 16, 24])).toBe("translucent");
  });

  it("sparkle outranks silk/glow/matte", () => {
    // Realistic case: sparkle PLA that's also marketed as 'matte sparkle'
    expect(deriveFinish([16, 23])).toBe("sparkle");
    // Glow + sparkle (rare but possible)
    expect(deriveFinish([23, 24])).toBe("sparkle");
  });

  it("silk outranks glow + matte", () => {
    expect(deriveFinish([16, 17, 24])).toBe("silk");
  });

  it("glow outranks matte", () => {
    expect(deriveFinish([16, 24])).toBe("glow");
  });

  it("matte is the lowest-priority finish", () => {
    // Only matte present — it wins by default.
    expect(deriveFinish([16, 4, 13])).toBe("matte");
  });

  // GH #1227 (Codex P2 r11): an unreviewed array has two readings. Legacy 20
  // is METAL_FILL, so no see-through texture may be derived from it until the
  // user has said which numbering the row is in; the fixed points still read.
  it("derives only from ids both numberings agree on while the row awaits review", () => {
    expect(deriveFinish([20], true)).toBeNull();
    expect(deriveFinish([19], true)).toBeNull();
    expect(deriveFinish([23], true)).toBeNull(); // glitter vs PHOSPHORESCENT
    expect(deriveFinish([20, 16], true)).toBe("matte");
    expect(deriveFinish([17, 24], true)).toBe("silk");
    // A verified row is unchanged.
    expect(deriveFinish([20], false)).toBe("transparent");
    expect(deriveFinish([20], undefined)).toBe("transparent");
  });
});

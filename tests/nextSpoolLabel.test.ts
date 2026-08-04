import { describe, it, expect } from "vitest";
import { computeNextSpoolLabel } from "@/lib/nextSpoolLabel";

/**
 * Coverage for the next-roll-number suggestion (GH #1060). The labels are
 * physical roll numbers (many hand-written on spools), so the parse rules
 * matter: half-parsing "12a" as 12 or letting a 200-digit string poison the
 * max would produce suggestions that collide with or leap past the real
 * sequence.
 */
describe("computeNextSpoolLabel", () => {
  it("suggests 1 when no numeric labels exist", () => {
    expect(computeNextSpoolLabel([])).toEqual({ next: 1, max: null });
    expect(computeNextSpoolLabel(["", "  ", "Blue roll", "A12"])).toEqual({ next: 1, max: null });
  });

  it("suggests max + 1 over plain integers, ties included", () => {
    expect(computeNextSpoolLabel(["1", "2", "3"])).toEqual({ next: 4, max: 3 });
    expect(computeNextSpoolLabel(["7", "7", "7"])).toEqual({ next: 8, max: 7 });
    expect(computeNextSpoolLabel(["204", "17", "9"])).toEqual({ next: 205, max: 204 });
  });

  it("ignores anything that is not ALL digits — no half-parsing", () => {
    // parseInt would read "12a" as 12 and "1e3" as 1; both must be ignored
    // outright so a decorative label can't shift the sequence.
    for (const junk of ["A12", "12a", "1.5", "-3", "1e3", "0x10", "#42", "4 2"]) {
      expect(computeNextSpoolLabel([junk, "10"])).toEqual({ next: 11, max: 10 });
    }
  });

  it("trims whitespace before judging", () => {
    expect(computeNextSpoolLabel([" 42 ", "\t7\n"])).toEqual({ next: 43, max: 42 });
  });

  it("strips leading zeros — '0042' is the number 42 and suggests unpadded 43", () => {
    expect(computeNextSpoolLabel(["0042"])).toEqual({ next: 43, max: 42 });
    expect(computeNextSpoolLabel(["000"])).toEqual({ next: 1, max: 0 });
  });

  it("skips digit strings past the safe-integer guard, keeping smaller labels in play", () => {
    // The label field allows 200 characters; a 200-digit "number" must not
    // poison the max or emit a next that can't round-trip through JSON.
    const huge = "9".repeat(16);
    expect(computeNextSpoolLabel([huge, "42"])).toEqual({ next: 43, max: 42 });
    // Zero-padding does not trip the guard — the VALUE is what's measured.
    const padded = "0".repeat(50) + "42";
    expect(computeNextSpoolLabel([padded])).toEqual({ next: 43, max: 42 });
    // Fifteen digits is still accepted exactly.
    const fifteen = "1" + "0".repeat(14);
    expect(computeNextSpoolLabel([fifteen])).toEqual({ next: 10 ** 14 + 1, max: 10 ** 14 });
  });

  it("tolerates null and undefined entries", () => {
    expect(computeNextSpoolLabel([null, undefined, "5"])).toEqual({ next: 6, max: 5 });
    expect(computeNextSpoolLabel([null, undefined])).toEqual({ next: 1, max: null });
  });
});

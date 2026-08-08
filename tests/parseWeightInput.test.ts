import { describe, it, expect } from "vitest";
import { parseWeightInput } from "@/lib/parseWeightInput";

describe("parseWeightInput", () => {
  it("rejects an empty field instead of reading it as 0 g", () => {
    // GH #1105: `Number("")` is 0, so the old `!Number.isFinite(n) || n < 0`
    // guard accepted a cleared field and wrote totalWeight: 0 — dropping the
    // remaining bar to 0% and removing that spool's weight from the location
    // and library totals, with no validation error.
    expect(parseWeightInput("")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects whitespace-only input, which Number() also reads as 0", () => {
    for (const raw of [" ", "   ", "\t", "\n"]) {
      expect(parseWeightInput(raw)).toEqual({ ok: false, reason: "empty" });
    }
  });

  it("accepts a plain integer reading", () => {
    expect(parseWeightInput("842")).toEqual({ ok: true, grams: 842 });
  });

  it("accepts a decimal reading from a scale", () => {
    expect(parseWeightInput("842.5")).toEqual({ ok: true, grams: 842.5 });
  });

  it("tolerates surrounding whitespace on an otherwise valid value", () => {
    expect(parseWeightInput("  842.5  ")).toEqual({ ok: true, grams: 842.5 });
  });

  it("accepts a real zero — that is a legitimate reading, not an empty field", () => {
    // This is the case that triggers the retire prompt, so it must parse.
    expect(parseWeightInput("0")).toEqual({ ok: true, grams: 0 });
    expect(parseWeightInput("0.0")).toEqual({ ok: true, grams: 0 });
  });

  it("rejects a negative weight", () => {
    expect(parseWeightInput("-1")).toEqual({ ok: false, reason: "negative" });
    expect(parseWeightInput("-0.5")).toEqual({ ok: false, reason: "negative" });
  });

  it("rejects trailing garbage rather than silently truncating it", () => {
    // parseFloat("12abc") is 12 — a typo would have been accepted as a real
    // reading. Number() returns NaN, which is why this module uses it.
    expect(parseWeightInput("12abc")).toEqual({ ok: false, reason: "invalid" });
    expect(parseWeightInput("abc")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects the non-finite literals", () => {
    expect(parseWeightInput("Infinity")).toEqual({ ok: false, reason: "invalid" });
    expect(parseWeightInput("NaN")).toEqual({ ok: false, reason: "invalid" });
    // -Infinity is non-finite, so it must be reported as invalid rather than
    // reaching the negative branch.
    expect(parseWeightInput("-Infinity")).toEqual({ ok: false, reason: "invalid" });
  });
});

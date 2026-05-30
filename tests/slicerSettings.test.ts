import { describe, it, expect } from "vitest";
import {
  mergeSlicerSettings,
  MAX_SETTINGS_KEYS,
  MAX_SETTING_VALUE_LENGTH,
} from "@/lib/slicerSettings";

/**
 * GH #422 — dedicated unit tests for `mergeSlicerSettings`. The route
 * tests (PrusaSlicer / OrcaSlicer / Bambu Studio import) exercise the
 * happy path but never push enough keys / large enough values to
 * cross the size-cap branches; these tests pin those edges directly so
 * the coverage threshold on `src/lib/**` can't regress silently.
 */
describe("mergeSlicerSettings", () => {
  const STRUCTURED = new Set(["temperature_max", "compatible_printers"]);

  it("merges incoming non-structured keys into a copy of existing", () => {
    const result = mergeSlicerSettings(
      { keep: "alpha" },
      { add_a: 1, add_b: "two" },
      STRUCTURED,
    );
    expect(result.error).toBeNull();
    expect(result.settings).toEqual({ keep: "alpha", add_a: 1, add_b: "two" });
    expect(result.added.sort()).toEqual(["add_a", "add_b"]);
  });

  it("skips keys that map to first-class structured fields", () => {
    const result = mergeSlicerSettings(
      {},
      { temperature_max: 230, custom: "ok", compatible_printers: "Prusa Core One" },
      STRUCTURED,
    );
    expect(result.error).toBeNull();
    expect(result.settings).toEqual({ custom: "ok" });
    expect(result.added).toEqual(["custom"]);
  });

  it("does not mutate the existing object", () => {
    const existing: Record<string, unknown> = { keep: "alpha" };
    mergeSlicerSettings(existing, { add: "value" }, STRUCTURED);
    expect(existing).toEqual({ keep: "alpha" });
  });

  it("preserves an incoming key over an existing key with the same name (last write wins)", () => {
    const result = mergeSlicerSettings(
      { shared: "old" },
      { shared: "new" },
      STRUCTURED,
    );
    expect(result.settings.shared).toBe("new");
    expect(result.added).toEqual(["shared"]);
  });

  it("rejects when a single value exceeds MAX_SETTING_VALUE_LENGTH (named in error)", () => {
    const huge = "x".repeat(MAX_SETTING_VALUE_LENGTH + 1);
    const result = mergeSlicerSettings(
      {},
      { bloater: huge },
      STRUCTURED,
    );
    expect(result.error).toMatch(/settings\.bloater/);
    expect(result.error).toMatch(new RegExp(String(MAX_SETTING_VALUE_LENGTH)));
    expect(result.settings.bloater).toBeUndefined();
  });

  it("counts JSON-serialized length, not raw value length", () => {
    // A 9000-char string serialises to ~9002 with quotes; an array of
    // strings serialises to its full JSON. This pins the policy.
    const arr = ["a".repeat(MAX_SETTING_VALUE_LENGTH - 10)];
    const result = mergeSlicerSettings({}, { arr }, STRUCTURED);
    expect(result.error).toBeNull();
    const reject = ["a".repeat(MAX_SETTING_VALUE_LENGTH)]; // square brackets + quotes push over
    const result2 = mergeSlicerSettings({}, { reject }, STRUCTURED);
    expect(result2.error).not.toBeNull();
  });

  it("rejects when the merged bag exceeds MAX_SETTINGS_KEYS", () => {
    const existing: Record<string, unknown> = {};
    for (let i = 0; i < MAX_SETTINGS_KEYS - 1; i++) {
      existing[`existing_${i}`] = i;
    }
    // Add 2 → existing.length + 2 > MAX
    const incoming: Record<string, unknown> = { add_a: 1, add_b: 2 };
    const result = mergeSlicerSettings(existing, incoming, STRUCTURED);
    expect(result.error).toMatch(new RegExp(`${MAX_SETTINGS_KEYS}-key`));
  });

  it("accepts incoming keys that overwrite existing without pushing the total over the cap", () => {
    const existing: Record<string, unknown> = {};
    for (let i = 0; i < MAX_SETTINGS_KEYS; i++) {
      existing[`k_${i}`] = i;
    }
    const result = mergeSlicerSettings(existing, { k_0: 999 }, STRUCTURED);
    expect(result.error).toBeNull();
    expect(result.settings.k_0).toBe(999);
    expect(Object.keys(result.settings)).toHaveLength(MAX_SETTINGS_KEYS);
  });

  it("treats null / undefined values as null in the serialised length check", () => {
    const result = mergeSlicerSettings(
      {},
      { nullable: null, undef: undefined },
      STRUCTURED,
    );
    expect(result.error).toBeNull();
    expect(result.settings.nullable).toBeNull();
    expect("undef" in result.settings).toBe(true);
  });
});

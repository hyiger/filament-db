import { describe, it, expect } from "vitest";
import {
  mergeSlicerSettings,
  normalizeSettingsToWire,
  bodyHasRawMultilineSettings,
  validateSettingsBag,
  validateDottedSettingsPaths,
  MAX_SETTINGS_KEYS,
  MAX_SETTING_VALUE_LENGTH,
  settingFlagIsOn,
  settingValuesEqual,
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

  it("#950: purges a never-baggable key (filament_settings_id) already sitting in existing", () => {
    // filament_settings_id is re-derived from the filament name on export, so a
    // stale copy in the bag shadows it. It must be purged from the seeded existing
    // bag regardless of the caller's structuredKeys (NEVER_BAGGED_KEYS).
    const result = mergeSlicerSettings(
      { filament_settings_id: "Stale Name", keep: "alpha" },
      { add: "value" },
      STRUCTURED,
    );
    expect(result.error).toBeNull();
    expect("filament_settings_id" in result.settings).toBe(false); // purged from existing
    expect(result.settings).toEqual({ keep: "alpha", add: "value" });
    // Purging a stale existing key is not counted as an "added" incoming key.
    expect(result.added).toEqual(["add"]);
    // …but it IS reported in `removed` so a conditional-writing caller persists it.
    expect(result.removed).toEqual(["filament_settings_id"]);
  });

  it("#950 (Codex r9): skips a never-baggable key from INCOMING even when the caller's structuredKeys omits it", () => {
    // The OrcaSlicer per-id route's structured set does not include
    // filament_settings_id, so without this the incoming copy would be added to the
    // bag and shadow the re-derived export value. Never-baggable keys stay out of
    // the bag regardless of source.
    const result = mergeSlicerSettings(
      { keep: "alpha" },
      { filament_settings_id: "Incoming Name", add: "value" },
      new Set(), // caller lists NO structured keys
    );
    expect(result.error).toBeNull();
    expect("filament_settings_id" in result.settings).toBe(false); // not added from incoming
    expect(result.settings).toEqual({ keep: "alpha", add: "value" });
    expect(result.added).toEqual(["add"]); // filament_settings_id not counted as added
  });

  it("#950 (Codex r8): does NOT purge a structuredKey that is not never-baggable — shared bag defaults survive", () => {
    // The per-id calibration sync lists context keys (extrusion_multiplier,
    // retraction, fans) in structuredKeys, but those have no top-level home and can
    // be legit shared filament-wide defaults in the bag — they must NOT be purged.
    const result = mergeSlicerSettings(
      { compatible_printers: "MK4", extrusion_multiplier: "0.98", keep: "alpha" },
      { add: "value" },
      new Set(["compatible_printers", "extrusion_multiplier"]),
    );
    expect(result.error).toBeNull();
    expect(result.settings.compatible_printers).toBe("MK4"); // preserved
    expect(result.settings.extrusion_multiplier).toBe("0.98"); // preserved (shared default)
    expect(result.removed).toEqual([]); // nothing never-baggable was present
  });

  it("#950: reports an empty `removed` when existing carried no never-baggable key", () => {
    const result = mergeSlicerSettings({ keep: "alpha" }, { add: "value" }, STRUCTURED);
    expect(result.removed).toEqual([]);
  });

  it("#950: does not mutate the existing object when purging a never-baggable key", () => {
    const existing: Record<string, unknown> = { filament_settings_id: "Stale", keep: "alpha" };
    mergeSlicerSettings(existing, {}, STRUCTURED);
    expect(existing).toEqual({ filament_settings_id: "Stale", keep: "alpha" }); // untouched
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

  it("wraps a raw multi-line string into wire form at the bag boundary (#1070 r6)", () => {
    // A JSON-sourced sync (the Orca per-id route) can carry real newlines —
    // the bag is wire-canonical, so they wrap; single-line strings and
    // already-wire values (escapes, not raw terminators) stay byte-identical.
    const result = mergeSlicerSettings(
      {},
      {
        multi: "line one\nline two",
        cr: "a\rb",
        single: "one line",
        wire: '"line one\\nline two"',
        num: 42,
      },
      new Set(),
    );
    expect(result.error).toBeNull();
    expect(result.settings.multi).toBe('"line one\\nline two"');
    expect(result.settings.cr).toBe('"a\\rb"');
    expect(result.settings.single).toBe("one line");
    expect(result.settings.wire).toBe('"line one\\nline two"'); // no double-wrap
    expect(result.settings.num).toBe(42);
  });

  it("applies the per-value length cap to the WRAPPED value", () => {
    const big = "x\n".repeat(10_500); // wraps to > 20k serialized
    const result = mergeSlicerSettings({}, { big }, new Set());
    expect(result.error).toContain("settings.big");
  });
});

describe("normalizeSettingsToWire (#1070 r7)", () => {
  it("wraps raw multi-line strings in the whole bag AND dotted paths, in place", () => {
    const body: Record<string, unknown> = {
      name: "n",
      settings: {
        multi: '"first\nlast"',
        single: "one line",
        wire: '"a\\nb"',
        num: 7,
      },
      "settings.dotted": "x\r\ny",
      "settings.dottedSingle": "plain",
      notSettings: "a\nb", // non-settings top-level key untouched
    };
    normalizeSettingsToWire(body);
    const bag = body.settings as Record<string, unknown>;
    expect(bag.multi).toBe('"\\"first\\nlast\\""'); // content quotes escaped, preserved
    expect(bag.single).toBe("one line");
    expect(bag.wire).toBe('"a\\nb"'); // already wire — untouched
    expect(bag.num).toBe(7);
    expect(body["settings.dotted"]).toBe('"x\\r\\ny"');
    expect(body["settings.dottedSingle"]).toBe("plain");
    expect(body.notSettings).toBe("a\nb");
    // Idempotent: a second pass changes nothing.
    const snapshot = JSON.stringify(body);
    normalizeSettingsToWire(body);
    expect(JSON.stringify(body)).toBe(snapshot);
  });

  it("heals a STORED-BYTE ECHO on a form key; treats fresh content's quotes as content (r10/r11)", () => {
    // Echo detection is stored-byte equality: the form's wireOrEdited is
    // the only writer that echoes stored bytes verbatim, so equality is
    // proof of a legacy-wrap echo (strip wrapper, heal to canonical wire).
    const stored = {
      filament_notes: '"line one\nline two"',
      start_filament_gcode: '"; start\nM572"',
    };
    const body: Record<string, unknown> = {
      settings: {
        filament_notes: '"line one\nline two"', // echo → heal
        end_filament_gcode: '"fresh\ncontent"', // fresh → quotes are content
      },
      "settings.start_filament_gcode": '"; start\nM572"', // dotted echo → heal
    };
    normalizeSettingsToWire(body, stored);
    const bag = body.settings as Record<string, unknown>;
    expect(bag.filament_notes).toBe('"line one\\nline two"');
    expect(bag.end_filament_gcode).toBe('"\\"fresh\\ncontent\\""');
    expect(body["settings.start_filament_gcode"]).toBe('"; start\\nM572"');
  });

  it("without a stored bag (create) NOTHING strips — quotes are always content (r11)", () => {
    const body: Record<string, unknown> = {
      settings: { filament_notes: '"first\nlast"' },
    };
    normalizeSettingsToWire(body); // no stored bag
    expect((body.settings as Record<string, unknown>).filament_notes).toBe(
      '"\\"first\\nlast\\""',
    );
  });

  it("bodyHasRawMultilineSettings detects both shapes and nothing else", () => {
    expect(bodyHasRawMultilineSettings({ settings: { a: "x\ny" } })).toBe(true);
    expect(bodyHasRawMultilineSettings({ "settings.a": "x\r y" })).toBe(true);
    expect(bodyHasRawMultilineSettings({ settings: { a: "flat" }, other: "x\ny" })).toBe(
      false,
    );
    expect(bodyHasRawMultilineSettings({ settings: ["x\ny"] })).toBe(false);
    expect(bodyHasRawMultilineSettings({})).toBe(false);
  });

  it("tolerates absent / non-object settings", () => {
    const a: Record<string, unknown> = { name: "n" };
    normalizeSettingsToWire(a);
    expect(a).toEqual({ name: "n" });
    const b: Record<string, unknown> = { settings: "junk" };
    normalizeSettingsToWire(b);
    expect(b.settings).toBe("junk"); // validators reject it downstream
    const c: Record<string, unknown> = { settings: ["arr\nay"] };
    normalizeSettingsToWire(c);
    expect(c.settings).toEqual(["arr\nay"]);
  });
});

/**
 * GH #1072 (item 2) — the generic-route companions to mergeSlicerSettings.
 * The generic POST/PUT filament routes forward `body.settings` (Mixed, so
 * runValidators is a no-op) straight into create/findOneAndUpdate; these
 * helpers apply the same GH #266 caps there, including the dotted
 * `settings.<key>` update-path form.
 */
describe("validateSettingsBag (#1072)", () => {
  it("passes undefined (field absent)", () => {
    expect(validateSettingsBag(undefined)).toBeNull();
  });

  it("passes null (explicit bag clear)", () => {
    expect(validateSettingsBag(null)).toBeNull();
  });

  it("rejects a non-object bag (string)", () => {
    expect(validateSettingsBag("not-a-bag")).toBe("settings must be an object");
  });

  it("rejects an array bag", () => {
    expect(validateSettingsBag(["a", "b"])).toBe("settings must be an object");
  });

  it("rejects a bag exceeding MAX_SETTINGS_KEYS", () => {
    const bag: Record<string, unknown> = {};
    for (let i = 0; i < MAX_SETTINGS_KEYS + 1; i++) bag[`k_${i}`] = i;
    expect(validateSettingsBag(bag)).toMatch(new RegExp(`${MAX_SETTINGS_KEYS}-key`));
  });

  it("accepts a bag at exactly MAX_SETTINGS_KEYS", () => {
    const bag: Record<string, unknown> = {};
    for (let i = 0; i < MAX_SETTINGS_KEYS; i++) bag[`k_${i}`] = i;
    expect(validateSettingsBag(bag)).toBeNull();
  });

  it("rejects a single oversize value, naming the key", () => {
    const err = validateSettingsBag({ blob: "x".repeat(MAX_SETTING_VALUE_LENGTH + 1) });
    expect(err).toMatch(/settings\.blob/);
    expect(err).toMatch(new RegExp(String(MAX_SETTING_VALUE_LENGTH)));
  });

  it("counts JSON-serialized length and treats undefined values as null", () => {
    // A nested object's whole JSON counts toward the cap.
    const nested = { deep: "y".repeat(MAX_SETTING_VALUE_LENGTH) };
    expect(validateSettingsBag({ nested })).not.toBeNull();
    // undefined serialises as null (4 chars) rather than throwing.
    expect(validateSettingsBag({ undef: undefined })).toBeNull();
  });

  it("accepts a normal slicer-shaped bag", () => {
    expect(
      validateSettingsBag({ filament_notes: "PLA", nozzle_temperature: "215", nil_key: null }),
    ).toBeNull();
  });
});

describe("validateDottedSettingsPaths (#1072)", () => {
  it("returns null when the body carries no dotted settings keys", () => {
    expect(
      validateDottedSettingsPaths({ name: "X", settings: { a: 1 } }, ["a"]),
    ).toBeNull();
  });

  it("rejects an oversize dotted value, naming the dotted key", () => {
    const err = validateDottedSettingsPaths(
      { "settings.blob": "x".repeat(MAX_SETTING_VALUE_LENGTH + 1) },
      [],
    );
    expect(err).toMatch(/settings\.blob/);
    expect(err).toMatch(new RegExp(String(MAX_SETTING_VALUE_LENGTH)));
  });

  it("bounds the merged key count against the stored bag's keys", () => {
    const existing = Array.from({ length: MAX_SETTINGS_KEYS }, (_, i) => `k_${i}`);
    // A NEW top-level key on a full bag pushes the merge over the cap.
    expect(
      validateDottedSettingsPaths({ "settings.newkey": 1 }, existing),
    ).toMatch(new RegExp(`${MAX_SETTINGS_KEYS}-key`));
    // Overwriting an EXISTING key does not grow the bag → allowed.
    expect(validateDottedSettingsPaths({ "settings.k_0": 2 }, existing)).toBeNull();
  });

  it("rejects NESTED dotted paths outright (Codex P1 — the flat-bag contract)", () => {
    // Counting settings.bucket.k1, .k2, … as one top-level "bucket" key while
    // each small leaf passes the per-value cap would let repeated merging
    // requests grow "bucket" into an arbitrarily large object — the exact
    // document-bloat bypass this validator exists to prevent. The bag is
    // flat by contract, so any second dot is invalid regardless of bag state.
    expect(validateDottedSettingsPaths({ "settings.k_0.sub": 1 }, ["k_0"])).toMatch(
      /nested settings paths/,
    );
    expect(validateDottedSettingsPaths({ "settings.new.sub": 1 }, [])).toMatch(
      /nested settings paths/,
    );
    // Deeper nesting is just as invalid.
    expect(validateDottedSettingsPaths({ "settings.a.b.c": "x" }, [])).toMatch(
      /nested settings paths/,
    );
  });

  it("treats an undefined dotted value as null in the length check", () => {
    expect(validateDottedSettingsPaths({ "settings.a": undefined }, [])).toBeNull();
  });
});

describe("settingFlagIsOn (GH #678 r4)", () => {
  it("reads scalars as before", () => {
    expect(settingFlagIsOn("1")).toBe(true);
    expect(settingFlagIsOn("0")).toBe(false);
    expect(settingFlagIsOn(null)).toBe(false);
    expect(settingFlagIsOn(undefined)).toBe(false);
    expect(settingFlagIsOn("nil")).toBe(false);
  });

  it("derives a multi-element array from its FIRST element — the pre-#678 read", () => {
    expect(settingFlagIsOn(["1", "1"])).toBe(true);
    expect(settingFlagIsOn(["1", "0"])).toBe(true);
    expect(settingFlagIsOn(["0", "1"])).toBe(false);
    expect(settingFlagIsOn([])).toBe(false);
  });
});

describe("settingValuesEqual (GH #678 r7)", () => {
  it("equates arrays element-wise and scalars by identity", () => {
    expect(settingValuesEqual(["A", "B"], ["A", "B"])).toBe(true);
    expect(settingValuesEqual(["A", "B"], ["A", "C"])).toBe(false);
    expect(settingValuesEqual(["A"], "A")).toBe(false);
    expect(settingValuesEqual("x", "x")).toBe(true);
    expect(settingValuesEqual(null, null)).toBe(true);
  });
});

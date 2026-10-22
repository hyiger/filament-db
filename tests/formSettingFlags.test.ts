import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  applyFormSettingFlags,
  FORM_FLAG_SETTING_KEYS,
  PARENT_FLAG_SETTINGS_PROJECTION,
  seedFormSettingFlags,
  type FormSettingFlags,
} from "@/lib/formSettingFlags";
import { resolveFilament } from "@/lib/resolveFilament";

/**
 * The four settings-bag checkboxes on FilamentForm (audit N016). A variant
 * fetched with ?raw=true carries none of these keys in its own bag; it
 * inherits them from the template. Seeding from the own bag read them as
 * off, and writing all four on every save pinned "0" over the template's
 * "1": one notes-only save made a glass-fiber color export
 * filament_abrasive = 0.
 */

const ALL_OFF: FormSettingFlags = {
  filament_abrasive: false,
  filament_soluble: false,
  activate_air_filtration: false,
  filament_wipe: false,
};

/** Exactly what the form does on submit when the user touched no checkbox:
 *  seed, submit the seed back unchanged, apply. */
function untouchedSave(
  own: Record<string, unknown>,
  parent: Record<string, unknown> | undefined,
  savesAsVariant: boolean,
): Record<string, unknown> {
  const seed = seedFormSettingFlags(own, parent);
  const settings = { ...own };
  applyFormSettingFlags(settings, { ...seed }, seed, savesAsVariant);
  return settings;
}

describe("seedFormSettingFlags", () => {
  it("seeds a variant with no own flag keys from its parent's bag", () => {
    expect(
      seedFormSettingFlags(
        { openprinttag_slug: "fiberon-pet-gf-black" },
        { filament_abrasive: "1", filament_wipe: "1", filament_soluble: "0" },
      ),
    ).toEqual({ ...ALL_OFF, filament_abrasive: true, filament_wipe: true });
  });

  it("lets an own key win over the parent's, whatever its value", () => {
    const parent = {
      filament_abrasive: "1",
      filament_soluble: "1",
      activate_air_filtration: "1",
      filament_wipe: "0",
    };
    expect(
      seedFormSettingFlags(
        {
          filament_abrasive: "0",
          // null is the nil marker; resolveFilament's spread copies it over
          // the parent's value, so the row exports nil, not the parent's 1.
          filament_soluble: null,
          filament_wipe: "1",
        },
        parent,
      ),
    ).toEqual({
      filament_abrasive: false,
      filament_soluble: false,
      activate_air_filtration: true,
      filament_wipe: true,
    });
  });

  it("agrees with resolveFilament's merged bag key for key", () => {
    // The seed must show what the row EXPORTS. The exporters read the
    // resolved bag, so compare against the real merge.
    const parentSettings = {
      filament_abrasive: "1",
      filament_soluble: ["1", "0"],
      activate_air_filtration: 1,
      filament_wipe: "1",
    };
    const ownSettings = { filament_wipe: null, filament_notes: "note" };
    const resolved = resolveFilament(
      { _id: "v", parentId: "p", settings: ownSettings } as never,
      { _id: "p", settings: parentSettings } as never,
    ) as unknown as { settings: Record<string, unknown> };
    const seed = seedFormSettingFlags(ownSettings, parentSettings);
    expect(seed).toEqual(seedFormSettingFlags(resolved.settings));
    expect(seed).toEqual({
      filament_abrasive: true,
      filament_soluble: true,
      activate_air_filtration: true,
      filament_wipe: false,
    });
  });

  it("seeds a standalone or template from its own bag alone", () => {
    expect(seedFormSettingFlags({ filament_abrasive: "1" })).toEqual({
      ...ALL_OFF,
      filament_abrasive: true,
    });
    expect(seedFormSettingFlags(undefined)).toEqual(ALL_OFF);
  });

  it("reads a malformed bag on either side as no bag", () => {
    expect(seedFormSettingFlags(["1"], { filament_abrasive: "1" })).toEqual({
      ...ALL_OFF,
      filament_abrasive: true,
    });
    expect(seedFormSettingFlags(null, [{ filament_abrasive: "1" }])).toEqual(ALL_OFF);
    expect(seedFormSettingFlags("1", "1")).toEqual(ALL_OFF);
  });
});

describe("applyFormSettingFlags", () => {
  const PARENT = { filament_abrasive: "1", filament_wipe: "1" };

  it("writes no flag key for a variant saved without touching the checkboxes", () => {
    const own = { openprinttag_slug: "fiberon-pet-gf-black", filament_notes: "x" };
    const saved = untouchedSave(own, PARENT, true);
    expect(saved).toEqual(own);
    for (const key of FORM_FLAG_SETTING_KEYS) expect(saved).not.toHaveProperty(key);
  });

  it("leaves a variant's existing own flag pins exactly as stored", () => {
    // An array is an Orca per-extruder value; an untouched one must survive
    // as the array, not collapse to "1".
    const own = { filament_abrasive: "1", filament_wipe: ["0", "0"] };
    expect(untouchedSave(own, PARENT, true)).toEqual(own);
  });

  it("writes only the key the user toggled on a variant", () => {
    const own = { filament_notes: "x" };
    const seed = seedFormSettingFlags(own, PARENT);
    const settings: Record<string, unknown> = { ...own };
    applyFormSettingFlags(
      settings,
      { ...seed, filament_wipe: false },
      seed,
      true,
    );
    expect(settings).toEqual({ filament_notes: "x", filament_wipe: "0" });
  });

  it("writes nothing when a toggle is undone before saving", () => {
    const seed = seedFormSettingFlags({}, PARENT);
    const settings: Record<string, unknown> = {};
    applyFormSettingFlags(settings, { ...seed }, seed, true);
    expect(settings).toEqual({});
  });

  it("still writes all four on a standalone, as before", () => {
    expect(untouchedSave({ filament_abrasive: "1" }, undefined, false)).toEqual({
      filament_abrasive: "1",
      filament_soluble: "0",
      activate_air_filtration: "0",
      filament_wipe: "0",
    });
  });

  it("writes all four with the values shown when a variant is unlinked", () => {
    // The row saves as a standalone with no parent to inherit from, so the
    // checkboxes' inherited state becomes its own.
    expect(untouchedSave({}, PARENT, false)).toEqual({
      filament_abrasive: "1",
      filament_soluble: "0",
      activate_air_filtration: "0",
      filament_wipe: "1",
    });
  });
});

describe("PARENT_FLAG_SETTINGS_PROJECTION", () => {
  it("projects exactly the four flag keys of the parent's bag", () => {
    expect(PARENT_FLAG_SETTINGS_PROJECTION.split(" ")).toEqual([
      "settings.filament_abrasive",
      "settings.filament_soluble",
      "settings.activate_air_filtration",
      "settings.filament_wipe",
    ]);
  });
});

describe("FilamentForm wiring", () => {
  // Source-pinned like GH #1148: the helpers only help if the form routes
  // every seed and every write through them.
  const form = readFileSync("src/app/filaments/FilamentForm.tsx", "utf8");

  it("writes no flag key directly into the settings bag", () => {
    for (const key of FORM_FLAG_SETTING_KEYS) {
      expect(form).not.toMatch(new RegExp(`settings\\.${key}\\s*=`));
      expect(form).not.toMatch(new RegExp(`settings\\[["']${key}["']\\]\\s*=`));
    }
    expect(form).toMatch(/applyFormSettingFlags\(\s*settings,/);
    expect(form).toMatch(/flagSeed,\s*Boolean\(form\.parentId\),?\s*\)/);
  });

  it("seeds every flag checkbox from the shared seed", () => {
    expect(form).toMatch(/abrasive: flagSeed\.filament_abrasive,/);
    expect(form).toMatch(/soluble: flagSeed\.filament_soluble,/);
    expect(form).toMatch(/activateAirFiltration: flagSeed\.activate_air_filtration,/);
    expect(form).toMatch(/wipe: flagSeed\.filament_wipe,/);
    // The parent's bag is consulted only for a row that loaded as a variant.
    expect(form).toMatch(/seedFormSettingFlags\(\s*initialData\?\.settings,\s*initialData\?\.parentId\s*\?/);
  });
});

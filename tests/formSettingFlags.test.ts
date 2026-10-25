import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  applyFormSettingFlags,
  changedFormSettingFlagEdits,
  FORM_FLAG_SETTING_KEYS,
  knownParentFlagBag,
  PARENT_FLAG_SETTINGS_PROJECTION,
  seedFormSettingFlags,
  shownFormSettingFlags,
  type FormFlagSettingKey,
  type FormSettingFlagEdits,
  type FormSettingFlags,
  type ParentFlagBag,
  type ParentFlagSources,
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

/** Exactly what the form does on submit when the user touched no checkbox. */
function untouchedSave(
  own: Record<string, unknown>,
  parent: Record<string, unknown> | undefined,
  savesAsVariant: boolean,
): Record<string, unknown> {
  const seed = seedFormSettingFlags(own, parent);
  const settings = { ...own };
  applyFormSettingFlags(
    settings,
    seed,
    {},
    parent ? { settings: parent } : null,
    savesAsVariant,
  );
  return settings;
}

/**
 * The form's flag state, composed from the helpers exactly as
 * FilamentForm composes them (the wiring is source-pinned below): the
 * parent is looked up by the CURRENT parentId, the seed is the own bag over
 * it, and edits record the boxes the user touched.
 */
class FlagForm {
  parentId: string;
  edits: FormSettingFlagEdits = {};
  unlinkedParent: ParentFlagBag | null = null;
  options: ParentFlagSources["options"] = [];

  constructor(
    readonly own: Record<string, unknown> | undefined,
    readonly initialParentId = "",
    readonly initialParent: unknown = undefined,
  ) {
    this.parentId = initialParentId;
  }

  get parent(): ParentFlagBag | null {
    return this.parentId
      ? knownParentFlagBag(this.parentId, {
          initialParentId: this.initialParentId,
          initialParent: this.initialParent,
          options: this.options,
        })
      : this.unlinkedParent;
  }

  get seed(): FormSettingFlags {
    return seedFormSettingFlags(this.own, this.parent?.settings);
  }

  get shown(): FormSettingFlags {
    return shownFormSettingFlags(this.seed, this.edits);
  }

  /** The user clicks the box: it flips what it currently shows. */
  toggle(key: FormFlagSettingKey): this {
    this.edits = { ...this.edits, [key]: !this.shown[key] };
    return this;
  }

  pick(parentId: string): this {
    this.parentId = parentId;
    return this;
  }

  unlink(): this {
    this.unlinkedParent = this.parent;
    this.parentId = "";
    return this;
  }

  save(): Record<string, unknown> {
    const settings: Record<string, unknown> = { ...(this.own ?? {}) };
    applyFormSettingFlags(
      settings,
      this.seed,
      this.edits,
      this.parentId ? this.parent : null,
      Boolean(this.parentId),
    );
    return settings;
  }
}

const TEMPLATE_ID = "6a1a7bef0000000000000001";
const OTHER_ID = "6a1a7bef0000000000000002";
const TEMPLATE_OPTION = {
  _id: TEMPLATE_ID,
  settings: { filament_abrasive: "1", filament_wipe: "1" },
};
const OTHER_OPTION = { _id: OTHER_ID, settings: {} };

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

describe("knownParentFlagBag", () => {
  const sources = (over: Partial<ParentFlagSources> = {}): ParentFlagSources => ({
    initialParentId: "",
    initialParent: undefined,
    options: [],
    ...over,
  });

  it("knows no parent when there is no parentId", () => {
    expect(knownParentFlagBag("", sources({ options: [TEMPLATE_OPTION] }))).toBeNull();
  });

  it("answers for the parent the row loaded with from its own _parent", () => {
    // The candidate list may hold a different copy; the row's _parent wins
    // for its own parent and is there from the first render.
    expect(
      knownParentFlagBag(
        TEMPLATE_ID,
        sources({
          initialParentId: TEMPLATE_ID,
          initialParent: { _id: TEMPLATE_ID, settings: { filament_soluble: "1" } },
          options: [TEMPLATE_OPTION],
        }),
      ),
    ).toEqual({ settings: { filament_soluble: "1" } });
  });

  it("knows a parent whose _parent carries no settings as all off, not unknown", () => {
    // The projection omits `settings` when the parent's bag holds none of
    // the four keys or the parent has no bag.
    const bag = knownParentFlagBag(
      TEMPLATE_ID,
      sources({ initialParentId: TEMPLATE_ID, initialParent: { _id: TEMPLATE_ID } }),
    );
    expect(bag).toEqual({ settings: undefined });
    expect(seedFormSettingFlags(bag!.settings)).toEqual(ALL_OFF);
  });

  it("finds any other parent among the picker's candidates", () => {
    const options = [TEMPLATE_OPTION, OTHER_OPTION];
    expect(knownParentFlagBag(OTHER_ID, sources({ options }))).toEqual({ settings: {} });
    // A _parent for a different parent never answers for this one.
    expect(
      knownParentFlagBag(
        TEMPLATE_ID,
        sources({
          initialParentId: OTHER_ID,
          initialParent: { _id: OTHER_ID, settings: { filament_wipe: "0" } },
          options,
        }),
      ),
    ).toEqual({ settings: TEMPLATE_OPTION.settings });
    // Candidate ids compare as strings (an ObjectId-like _id).
    expect(
      knownParentFlagBag(
        TEMPLATE_ID,
        sources({ options: [{ _id: { toString: () => TEMPLATE_ID }, settings: { x: 1 } }] }),
      ),
    ).toEqual({ settings: { x: 1 } });
  });

  it("does not know a parent the candidate list lacks or has not loaded", () => {
    expect(knownParentFlagBag(TEMPLATE_ID, sources())).toBeNull();
    expect(knownParentFlagBag(TEMPLATE_ID, sources({ options: [OTHER_OPTION] }))).toBeNull();
    // A null _parent (the parent is gone) falls through to the candidates.
    expect(
      knownParentFlagBag(
        TEMPLATE_ID,
        sources({ initialParentId: TEMPLATE_ID, initialParent: null, options: [OTHER_OPTION] }),
      ),
    ).toBeNull();
  });
});

describe("shownFormSettingFlags / changedFormSettingFlagEdits", () => {
  const seed: FormSettingFlags = { ...ALL_OFF, filament_abrasive: true };

  it("shows an edit over the seed and the seed elsewhere", () => {
    expect(shownFormSettingFlags(seed, { filament_abrasive: false, filament_wipe: true })).toEqual({
      ...ALL_OFF,
      filament_wipe: true,
    });
    expect(shownFormSettingFlags(seed, {})).toEqual(seed);
  });

  it("counts only edits that change what a box shows", () => {
    expect(
      changedFormSettingFlagEdits(seed, { filament_abrasive: true, filament_wipe: true }),
    ).toEqual({ filament_wipe: true });
    expect(changedFormSettingFlagEdits(seed, {})).toEqual({});
    expect(changedFormSettingFlagEdits(seed, { filament_abrasive: false })).toEqual({
      filament_abrasive: false,
    });
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
    // as the array, not collapse to "1". null is the nil marker.
    const own = { filament_abrasive: "1", filament_wipe: ["0", "0"], filament_soluble: null };
    expect(untouchedSave(own, PARENT, true)).toEqual(own);
  });

  it("writes only the touched key that differs from the parent", () => {
    const own = { filament_notes: "x" };
    const seed = seedFormSettingFlags(own, PARENT);
    const settings: Record<string, unknown> = { ...own };
    applyFormSettingFlags(settings, seed, { filament_wipe: false }, { settings: PARENT }, true);
    expect(settings).toEqual({ filament_notes: "x", filament_wipe: "0" });
  });

  it("drops a touched key set back to the parent's value, own pin included", () => {
    // The row then inherits what the box shows instead of pinning it.
    const own = { filament_abrasive: "0", filament_notes: "x" };
    const seed = seedFormSettingFlags(own, PARENT);
    expect(seed.filament_abrasive).toBe(false);
    const settings: Record<string, unknown> = { ...own };
    applyFormSettingFlags(settings, seed, { filament_abrasive: true }, { settings: PARENT }, true);
    expect(settings).toEqual({ filament_notes: "x" });
  });

  it("reads a key absent from the parent's bag as off", () => {
    const parent = { settings: { filament_abrasive: "1" } };
    const seed = seedFormSettingFlags({}, parent.settings);
    const on: Record<string, unknown> = {};
    applyFormSettingFlags(on, seed, { activate_air_filtration: true }, parent, true);
    expect(on).toEqual({ activate_air_filtration: "1" });
    // Toggled back to off with no own value: nothing is pinned.
    const back: Record<string, unknown> = {};
    applyFormSettingFlags(back, seed, { activate_air_filtration: false }, parent, true);
    expect(back).toEqual({});
    // A parent with no bag at all is known and all off.
    const none: Record<string, unknown> = {};
    applyFormSettingFlags(none, ALL_OFF, { filament_soluble: false }, { settings: undefined }, true);
    expect(none).toEqual({});
  });

  it("writes a cleared pin as 0 when the parent's bag lacks the key", () => {
    // Absent is not off to the slicer: the key is not emitted at all and
    // the preset falls back to its system preset's (or the printer's)
    // value. So an own "1" turned off is written, never dropped.
    const parent = { settings: { filament_abrasive: "1" } };
    const own = { activate_air_filtration: "1", filament_wipe: "1" };
    const seed = seedFormSettingFlags(own, parent.settings);
    const settings: Record<string, unknown> = { ...own };
    applyFormSettingFlags(
      settings,
      seed,
      { activate_air_filtration: false, filament_wipe: false },
      parent,
      true,
    );
    expect(settings).toEqual({ activate_air_filtration: "0", filament_wipe: "0" });
    // Same for a parent with no bag at all.
    const bare: Record<string, unknown> = { filament_wipe: "1" };
    applyFormSettingFlags(
      bare,
      { ...ALL_OFF, filament_wipe: true },
      { filament_wipe: false },
      { settings: undefined },
      true,
    );
    expect(bare).toEqual({ filament_wipe: "0" });
  });

  it("leaves a touched box put back where it started exactly as stored", () => {
    // Audit-era echo pins: an explicit "0", the nil marker and a
    // per-extruder array, under a template whose bag lacks every key (an
    // imported template never saved through the form) and under one that
    // holds the opposite value.
    const own = { filament_wipe: "0", filament_soluble: null, filament_abrasive: ["0", "0"] };
    const opposite = { filament_wipe: "1", filament_soluble: "1", filament_abrasive: "1" };
    for (const parentSettings of [{}, opposite]) {
      const form = new FlagForm(own, TEMPLATE_ID, { _id: TEMPLATE_ID, settings: parentSettings });
      for (const key of ["filament_wipe", "filament_soluble", "filament_abrasive"] as const) {
        form.toggle(key).toggle(key);
      }
      expect(form.edits).toEqual({
        filament_wipe: false,
        filament_soluble: false,
        filament_abrasive: false,
      });
      expect(form.save()).toEqual(own);
    }
  });

  it("keeps an own value that already reads as the shown state, parent unknown", () => {
    // The nil marker reads as off: put back to off, it is not rewritten "0".
    const own = { filament_wipe: null, filament_abrasive: "0" };
    const settings: Record<string, unknown> = { ...own };
    applyFormSettingFlags(
      settings,
      ALL_OFF,
      { filament_wipe: false, filament_abrasive: false },
      null,
      true,
    );
    expect(settings).toEqual(own);
  });

  it("writes a touched key explicitly when the parent's flags are unknown", () => {
    const settings: Record<string, unknown> = { filament_notes: "x" };
    applyFormSettingFlags(settings, ALL_OFF, { filament_abrasive: false }, null, true);
    // The saved value is what the box showed; untouched keys still inherit.
    expect(settings).toEqual({ filament_notes: "x", filament_abrasive: "0" });
  });

  it("still writes all four on a standalone, as before", () => {
    expect(untouchedSave({ filament_abrasive: "1" }, undefined, false)).toEqual({
      filament_abrasive: "1",
      filament_soluble: "0",
      activate_air_filtration: "0",
      filament_wipe: "0",
    });
    const settings: Record<string, unknown> = {};
    applyFormSettingFlags(settings, ALL_OFF, { filament_wipe: true }, null, false);
    expect(settings).toEqual({ ...untouchedSave({}, undefined, false), filament_wipe: "1" });
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

describe("the form's flag state across parent changes (Codex P2 on PR #1235)", () => {
  it("Duplicate flow: seeds from the template once the candidates arrive", () => {
    // ?cloneId= hands the form a parentId and no _parent.
    const form = new FlagForm({}, TEMPLATE_ID);
    expect(form.parent).toBeNull();
    expect(form.shown).toEqual(ALL_OFF);
    form.options = [TEMPLATE_OPTION, OTHER_OPTION];
    expect(form.shown).toEqual({ ...ALL_OFF, filament_abrasive: true, filament_wipe: true });
    // Untouched: nothing written, the variant inherits the template's "1".
    expect(form.save()).toEqual({});
  });

  it("Duplicate flow: a variant toggled off persists an explicit 0", () => {
    const form = new FlagForm({}, TEMPLATE_ID);
    form.options = [TEMPLATE_OPTION];
    expect(form.toggle("filament_abrasive").save()).toEqual({ filament_abrasive: "0" });
  });

  it("toggled on and back off against a 1 parent persists 0, even from a stale seed", () => {
    // The reported case: the seed read the template's "1" as off because
    // the parent was not known yet, and on-then-off compared equal to it.
    const form = new FlagForm({}, TEMPLATE_ID);
    form.toggle("filament_abrasive").toggle("filament_abrasive");
    expect(form.edits).toEqual({ filament_abrasive: false });
    // Saved before the parent's flags are known: written as shown.
    expect(form.save()).toEqual({ filament_abrasive: "0" });
    // Saved once they are known: still the explicit off override.
    form.options = [TEMPLATE_OPTION];
    expect(form.shown.filament_abrasive).toBe(false);
    expect(form.save()).toEqual({ filament_abrasive: "0" });
  });

  it("picker: a new filament picking the template shows and keeps its flags", () => {
    const form = new FlagForm(undefined);
    form.options = [TEMPLATE_OPTION, OTHER_OPTION];
    expect(form.shown).toEqual(ALL_OFF);
    form.pick(TEMPLATE_ID);
    expect(form.shown.filament_abrasive).toBe(true);
    expect(form.save()).toEqual({});
    expect(form.toggle("filament_abrasive").save()).toEqual({ filament_abrasive: "0" });
  });

  it("picker: switching parents re-seeds untouched boxes from the current one only", () => {
    const form = new FlagForm(undefined);
    form.options = [TEMPLATE_OPTION, OTHER_OPTION];
    form.pick(TEMPLATE_ID).toggle("filament_soluble");
    form.pick(OTHER_ID);
    // The first parent's "1"s no longer show; the touched box keeps its edit.
    expect(form.shown).toEqual({ ...ALL_OFF, filament_soluble: true });
    expect(form.save()).toEqual({ filament_soluble: "1" });
    // Back on the template, the same edit is still compared with it.
    form.pick(TEMPLATE_ID);
    expect(form.save()).toEqual({ filament_soluble: "1" });
  });

  it("a box touched before a parent is picked inherits when it matches it", () => {
    const form = new FlagForm(undefined);
    form.options = [TEMPLATE_OPTION];
    form.toggle("filament_abrasive");
    form.pick(TEMPLATE_ID);
    expect(form.shown.filament_abrasive).toBe(true);
    expect(form.save()).toEqual({});
  });

  it("unlinking keeps showing the parent's flags and saves them as the row's own", () => {
    const form = new FlagForm({}, TEMPLATE_ID, {
      _id: TEMPLATE_ID,
      settings: TEMPLATE_OPTION.settings,
    });
    expect(form.shown.filament_abrasive).toBe(true);
    form.unlink();
    expect(form.shown.filament_abrasive).toBe(true);
    expect(form.save()).toEqual({
      filament_abrasive: "1",
      filament_soluble: "0",
      activate_air_filtration: "0",
      filament_wipe: "1",
    });
    // Linking again re-seeds from the new parent, with nothing touched.
    form.options = [OTHER_OPTION];
    form.pick(OTHER_ID);
    expect(form.shown).toEqual(ALL_OFF);
    expect(form.save()).toEqual({});
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
  // every seed, every edit and every write through them.
  const form = readFileSync("src/app/filaments/FilamentForm.tsx", "utf8");

  it("writes no flag key directly into the settings bag", () => {
    for (const key of FORM_FLAG_SETTING_KEYS) {
      expect(form).not.toMatch(new RegExp(`settings\\.${key}\\s*=`));
      expect(form).not.toMatch(new RegExp(`settings\\[["']${key}["']\\]\\s*=`));
    }
    expect(form).toMatch(
      /applyFormSettingFlags\(\s*settings,\s*flagSeed,\s*flagEdits,\s*form\.parentId \? flagParent : null,\s*Boolean\(form\.parentId\),?\s*\)/,
    );
  });

  it("looks the parent up by the current parentId and seeds from it", () => {
    expect(form).toMatch(
      /const flagParent = form\.parentId\s*\?\s*knownParentFlagBag\(form\.parentId, \{[\s\S]*?initialParent: initialData\?\._parent,\s*options: parentOptions,\s*\}\)\s*:\s*unlinkedFlagParent;/,
    );
    expect(form).toMatch(
      /const flagSeed = seedFormSettingFlags\(initialData\?\.settings, flagParent\?\.settings\);/,
    );
    expect(form).toMatch(/const flags = shownFormSettingFlags\(flagSeed, flagEdits\);/);
  });

  it("keeps the flags out of form state and every box on the shared state", () => {
    // (The lookbehind skips i18n keys such as "form.activateAirFiltration".)
    expect(form).not.toMatch(/(?<!["'])form\.(abrasive|soluble|activateAirFiltration|wipe)\b/);
    expect(form).toMatch(/checked=\{flags\.activate_air_filtration\}/);
    expect(form).toMatch(/checked=\{flags\.filament_wipe\}/);
    expect(form).toMatch(/OPT_TAG\.ABRASIVE && flags\.filament_abrasive/);
    expect(form).toMatch(/OPT_TAG\.WATER_SOLUBLE && flags\.filament_soluble/);
    for (const key of FORM_FLAG_SETTING_KEYS) {
      expect(form).toMatch(new RegExp(`editFlag\\("${key}", `));
    }
    // Disabled while the linked parent's flags are on their way.
    expect(form.match(/disabled=\{flagsPending\}/g)?.length).toBe(2);
    expect(form).toMatch(
      /const flagsPending = Boolean\(form\.parentId\) && !flagParent && parentsLoading;/,
    );
  });

  it("captures the parent's flags when the parent is removed", () => {
    expect(form).toMatch(
      /setUnlinkedFlagParent\(flagParent\);\s*setForm\(\{ \.\.\.form, parentId: "" \}\);/,
    );
  });

  it("counts only edits that change a box toward dirty", () => {
    expect(form).toMatch(
      /JSON\.stringify\(changedFormSettingFlagEdits\(flagSeed, flagEdits\)\)/,
    );
    expect(form).toMatch(/JSON\.stringify\(\{ form, flagEdits: flagEditsSnapshot, calibrations, presets \}\)/);
  });

  it("re-baselines after a save with the same snapshot the dirty check compares", () => {
    // A baseline rebuilt with a different shape never equals dirtySnapshot
    // again, so the form would stay dirty after every save (GH #286).
    expect(form).toMatch(/useState\(dirtySnapshot\)/);
    expect(form).toMatch(/const dirty = dirtySnapshot !== dirtyBaseline;/);
    const rebaselines = form.match(/setDirtyBaseline\([^)]*\)/g) ?? [];
    expect(rebaselines.length).toBeGreaterThan(0);
    for (const call of rebaselines) expect(call).toBe("setDirtyBaseline(dirtySnapshot)");
    // The snapshot is built in exactly one place.
    expect(form.match(/JSON\.stringify\(\{ form\b/g)?.length).toBe(1);
  });
});

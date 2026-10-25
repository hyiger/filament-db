import { settingFlagIsOn } from "@/lib/slicerSettings";

/**
 * The four FilamentForm checkboxes backed by the slicer settings bag.
 *
 * WHY THIS MODULE EXISTS. The edit page fetches a variant with `?raw=true`,
 * so its `settings` holds only the variant's OWN keys. A variant normally
 * carries none of these four: it inherits them through resolveFilament's
 * shallow `{ ...parent.settings, ...variant.settings }`. The form used to
 * seed each checkbox from the own bag (absent ⇒ unchecked) and write all
 * four as "1"/"0" on every save, so ONE save of a variant, even one that
 * only touched the notes, pinned `filament_abrasive = "0"` over a template's
 * "1". The exporters read only the setting, so that preset then told
 * firmware `M862.1` and Orca/Bambu a glass-fiber grade was non-abrasive.
 * The same save turned `filament_wipe` off on families whose template
 * enables it.
 *
 * The rule now, in two halves that must stay together:
 *  - SEED from the bag the row EXPORTS: own value when the own bag has the
 *    key (even `null`, the nil marker, since the spread copies it), else the
 *    CURRENT parent's. The parent is looked up by the form's current
 *    `parentId` (see knownParentFlagBag), so picking a parent, or opening
 *    the Duplicate flow, seeds from that parent too, not just a row that
 *    loaded as a variant.
 *  - WRITE on a row that saves as a variant only the checkboxes the user
 *    TOUCHED (FormSettingFlagEdits). An untouched key keeps whatever the own
 *    bag held, absent included, so it keeps inheriting. A touched key is
 *    compared with the current parent's value: equal ⇒ the row holds no own
 *    value for it (an own pin is dropped, so the row inherits what the box
 *    shows), different ⇒ written as "1"/"0". A standalone or a template
 *    still writes all four on every save, as before.
 *
 * Touched, not "differs from the seed": a seed computed before the parent
 * was known (the Duplicate flow, the picker) read the parent's "1" as off,
 * so an off box compared equal to it and the explicit "0" was never
 * written. Comparing a touched value with the parent itself cannot be
 * fooled by a stale seed. When the parent's flags are not known at save
 * time (still loading, or the parent list failed), a touched key is written
 * explicitly: the saved value is then exactly what the box showed.
 */
export const FORM_FLAG_SETTING_KEYS = [
  "filament_abrasive",
  "filament_soluble",
  "activate_air_filtration",
  "filament_wipe",
] as const;

export type FormFlagSettingKey = (typeof FORM_FLAG_SETTING_KEYS)[number];

export type FormSettingFlags = Record<FormFlagSettingKey, boolean>;

/** The checkboxes the user changed in this form session, each with the
 *  value it now holds. A key that is absent was never touched. */
export type FormSettingFlagEdits = Partial<Record<FormFlagSettingKey, boolean>>;

/** A parent's settings bag as far as the four flags go. `null` wherever one
 *  is expected means the form does not know the parent's flags. */
export interface ParentFlagBag {
  settings: unknown;
}

/**
 * The Mongo projection that puts exactly these four keys of a parent's bag
 * on the edit page's slim `_parent` and on each GET /api/filaments/parents
 * option (GH #162 keeps the rest of the bag off the wire). Built from the
 * key list so the three cannot drift.
 */
export const PARENT_FLAG_SETTINGS_PROJECTION = FORM_FLAG_SETTING_KEYS.map(
  (key) => `settings.${key}`,
).join(" ");

/** A settings bag is a plain object; anything else (a malformed array or a
 *  scalar from a raw-driver write) reads as no bag at all. */
function asBag(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The checkbox seeds: the own bag over the parent's. Pass `parentSettings`
 * only for the parent the row is currently linked to; with none, the own
 * bag alone (a standalone or template). Called with a parent's bag alone it
 * gives that parent's own flags, which are also its effective ones (a
 * parent is never a variant), with an absent key read as off.
 */
export function seedFormSettingFlags(
  ownSettings: unknown,
  parentSettings?: unknown,
): FormSettingFlags {
  const own = asBag(ownSettings);
  const parent = asBag(parentSettings);
  const seed = {} as FormSettingFlags;
  for (const key of FORM_FLAG_SETTING_KEYS) {
    const value =
      own && Object.prototype.hasOwnProperty.call(own, key) ? own[key] : parent?.[key];
    seed[key] = settingFlagIsOn(value);
  }
  return seed;
}

export interface ParentFlagSources {
  /** The parent the row loaded with, "" for none. */
  initialParentId: string;
  /** `initialData._parent`: the edit page's slim summary or, on the
   *  new-variant page, the whole parent doc. Either carries the four keys. */
  initialParent: unknown;
  /** The picker's candidates from GET /api/filaments/parents, which carry
   *  the four keys too. */
  options: ReadonlyArray<{ _id: unknown; settings?: unknown }>;
}

/**
 * The flag bag of the parent `parentId` names, or null while the form does
 * not know it (no parent, the candidate list still loading or failed, or a
 * parent missing from it). Looked up by the CURRENT parentId on every
 * render, so a parent the user picked and moved away from can never supply
 * the seed or the comparison. The row's own `_parent` answers for the
 * parent it loaded with; every other parent comes from the candidates.
 */
export function knownParentFlagBag(
  parentId: string,
  sources: ParentFlagSources,
): ParentFlagBag | null {
  if (!parentId) return null;
  const initial = asBag(sources.initialParent);
  if (parentId === sources.initialParentId && initial) {
    return { settings: initial.settings };
  }
  const option = sources.options.find((o) => String(o._id) === parentId);
  return option ? { settings: option.settings } : null;
}

/** What each checkbox shows: the user's edit where there is one, else the
 *  seed. */
export function shownFormSettingFlags(
  seed: FormSettingFlags,
  edits: FormSettingFlagEdits,
): FormSettingFlags {
  const shown = {} as FormSettingFlags;
  for (const key of FORM_FLAG_SETTING_KEYS) shown[key] = edits[key] ?? seed[key];
  return shown;
}

/**
 * The edits that change what a box shows, for the form's dirty tracking.
 * An edit put back to the seed drops out, so reverting a checkbox
 * un-dirties the form (GH #286), and the seed moving when the parent's
 * flags arrive never dirties it on its own.
 */
export function changedFormSettingFlagEdits(
  seed: FormSettingFlags,
  edits: FormSettingFlagEdits,
): FormSettingFlagEdits {
  const changed: FormSettingFlagEdits = {};
  for (const key of FORM_FLAG_SETTING_KEYS) {
    const edit = edits[key];
    if (edit !== undefined && edit !== seed[key]) changed[key] = edit;
  }
  return changed;
}

/**
 * Write the checkbox state into the outgoing `settings` (mutated in place;
 * it starts as a copy of the row's own bag).
 *
 * `savesAsVariant` is whether the submitted row has a parent, and `parent`
 * that parent's flag bag (null when unknown). A variant leaves an untouched
 * key exactly as the bag holds it; a touched key equal to the parent's
 * value is removed (the row inherits it), and any other touched key is
 * written. A standalone writes all four from what the boxes show.
 */
export function applyFormSettingFlags(
  settings: Record<string, unknown>,
  seed: FormSettingFlags,
  edits: FormSettingFlagEdits,
  parent: ParentFlagBag | null,
  savesAsVariant: boolean,
): void {
  const shown = shownFormSettingFlags(seed, edits);
  const parentFlags = parent ? seedFormSettingFlags(parent.settings) : null;
  for (const key of FORM_FLAG_SETTING_KEYS) {
    if (savesAsVariant) {
      if (edits[key] === undefined) continue;
      if (parentFlags && shown[key] === parentFlags[key]) {
        delete settings[key];
        continue;
      }
    }
    settings[key] = shown[key] ? "1" : "0";
  }
}

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
 *  - SEED from the bag the row EXPORTS: on a variant, the own value when the
 *    own bag has the key (even `null`, the nil marker, since the spread
 *    copies it), else the parent's. The checkbox then shows what the preset
 *    actually asserts, and the hardened-nozzle filter reads the same truth.
 *  - WRITE on a variant only the keys the user changed from that seed, the
 *    edited-only posture `compatible_printers` already follows (GH #1066).
 *    An untouched key keeps whatever the own bag held, absent included, so
 *    it keeps inheriting. A standalone or a template still writes all four
 *    on every save, as before.
 *
 * "Variant" means different things on the two halves on purpose. The seed
 * asks whether the row LOADED as a variant (its parent's bag is the one it
 * exports). The write asks whether it SAVES as one (`form.parentId`): a
 * variant the user unlinks becomes a standalone with no parent to inherit
 * from, so all four are written with the values the user saw.
 */
export const FORM_FLAG_SETTING_KEYS = [
  "filament_abrasive",
  "filament_soluble",
  "activate_air_filtration",
  "filament_wipe",
] as const;

export type FormFlagSettingKey = (typeof FORM_FLAG_SETTING_KEYS)[number];

export type FormSettingFlags = Record<FormFlagSettingKey, boolean>;

/**
 * The Mongo projection that puts exactly these four keys of the parent's bag
 * on the edit page's slim `_parent` (GH #162 keeps the rest of the bag off
 * the wire). Built from the key list so the two cannot drift.
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
 * The checkbox seeds. Pass `parentSettings` only when the row loaded as a
 * variant; a standalone or template seeds from its own bag alone.
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

/**
 * Write the checkbox state into the outgoing `settings` (mutated in place).
 * `savesAsVariant` is whether the submitted row has a parent; when true, a
 * key whose checkbox still equals its seed is left exactly as the bag holds
 * it.
 */
export function applyFormSettingFlags(
  settings: Record<string, unknown>,
  flags: FormSettingFlags,
  seed: FormSettingFlags,
  savesAsVariant: boolean,
): void {
  for (const key of FORM_FLAG_SETTING_KEYS) {
    if (savesAsVariant && flags[key] === seed[key]) continue;
    settings[key] = flags[key] ? "1" : "0";
  }
}

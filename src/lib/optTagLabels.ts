/**
 * GH #1227 — i18n label keys for OpenPrintTag tag ids.
 *
 * One key per SPEC tag, `optTag.<spec_name>` (e.g. 20 → `optTag.transparent`),
 * so every surface that shows a tag — the form's checkbox list, the NFC read
 * dialog, the Data health review — labels it from the same table and an id
 * can never be spelled two ways. An id the enum does not know gets
 * `optTag.unknown` with `{ id }` interpolated ("Tag 75"): unknown ids stay
 * visible, never silently dropped.
 *
 * Client-safe (no DB, no React) — it only reads the enum.
 */

import { OPT_TAG, OPT_TAG_TO_NAME } from "./openprinttag";
import { LEGACY_TAG_NAME } from "./optTagLegacy";

/** `optTag.<spec_name>` for a known id, else `null`. */
export function optTagLabelKey(id: number): string | null {
  const name = OPT_TAG_TO_NAME[id];
  return name ? `optTag.${name.toLowerCase()}` : null;
}

/** `optTagLegacy.<LEGACY_NAME>` (lowercased) for a pre-#1227 id, else `null`. */
export function legacyOptTagLabelKey(id: number): string | null {
  const name = LEGACY_TAG_NAME[id];
  return name ? `optTagLegacy.${name.toLowerCase()}` : null;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Human label for a spec tag id, falling back to "Tag N" for an unknown one. */
export function optTagLabel(t: Translate, id: number): string {
  const key = optTagLabelKey(id);
  return key ? t(key) : t("optTag.unknown", { id });
}

/** Human label for a legacy (pre-#1227) tag id, falling back to "Tag N". */
export function legacyOptTagLabel(t: Translate, id: number): string {
  const key = legacyOptTagLabelKey(id);
  return key ? t(key) : t("optTag.unknown", { id });
}

/**
 * GH #1227: the Material-tags checkboxes, keyed by OpenPrintTag SPEC id with
 * the shared `optTag.<spec_name>` label. Curated — the spec has 74 tags and
 * most of the fill subspecies (bronze/iron/steel/…, bamboo/pine/cork) are
 * better entered by their parent tag; anything not listed still round-trips
 * untouched and is shown as "also tagged". The label-key table is validated
 * against the enum + both locales in tests/optTagLabels.test.ts. Lives here
 * (not in the form) so that test needs no React.
 */
export const FORM_TAG_GROUPS: ReadonlyArray<{
  key: string;
  labelKey: string;
  tags: ReadonlyArray<readonly [number, string]>;
}> = [
  {
    key: "material",
    labelKey: "form.tagGroup.material",
    tags: [
      [OPT_TAG.ABRASIVE, "optTag.abrasive"],
      [OPT_TAG.HIGH_SPEED, "optTag.high_speed"],
      [OPT_TAG.HIGH_TEMPERATURE, "optTag.high_temperature"],
      [OPT_TAG.UV_RESISTANT, "optTag.uv_resistant"],
      [OPT_TAG.FOAMING, "optTag.foaming"],
      [OPT_TAG.SELF_EXTINGUISHING, "optTag.self_extinguishing"],
      [OPT_TAG.ESD_SAFE, "optTag.esd_safe"],
      [OPT_TAG.CONDUCTIVE, "optTag.conductive"],
      [OPT_TAG.BLEND, "optTag.blend"],
      [OPT_TAG.WATER_SOLUBLE, "optTag.water_soluble"],
      [OPT_TAG.IPA_SOLUBLE, "optTag.ipa_soluble"],
      [OPT_TAG.LIMONENE_SOLUBLE, "optTag.limonene_soluble"],
      [OPT_TAG.ACETONE_SOLUBLE, "optTag.acetone_soluble"],
      [OPT_TAG.FILTRATION_RECOMMENDED, "optTag.filtration_recommended"],
      [OPT_TAG.BIOCOMPATIBLE, "optTag.biocompatible"],
      [OPT_TAG.RECYCLED, "optTag.recycled"],
      [OPT_TAG.BIO_BASED, "optTag.bio_based"],
      [OPT_TAG.INDUSTRIALLY_COMPOSTABLE, "optTag.industrially_compostable"],
      [OPT_TAG.HOME_COMPOSTABLE, "optTag.home_compostable"],
    ],
  },
  {
    key: "appearance",
    labelKey: "form.tagGroup.appearance",
    tags: [
      [OPT_TAG.MATTE, "optTag.matte"],
      [OPT_TAG.SILK, "optTag.silk"],
      [OPT_TAG.TRANSLUCENT, "optTag.translucent"],
      [OPT_TAG.TRANSPARENT, "optTag.transparent"],
      [OPT_TAG.IRIDESCENT, "optTag.iridescent"],
      [OPT_TAG.PEARLESCENT, "optTag.pearlescent"],
      [OPT_TAG.GLITTER, "optTag.glitter"],
      [OPT_TAG.GLOW_IN_THE_DARK, "optTag.glow_in_the_dark"],
      [OPT_TAG.NEON, "optTag.neon"],
      [OPT_TAG.TEMPERATURE_COLOR_CHANGE, "optTag.temperature_color_change"],
      [OPT_TAG.WITHOUT_PIGMENTS, "optTag.without_pigments"],
    ],
  },
  {
    key: "additives",
    labelKey: "form.tagGroup.additives",
    tags: [
      [OPT_TAG.CONTAINS_CARBON_FIBER, "optTag.contains_carbon_fiber"],
      [OPT_TAG.CONTAINS_GLASS_FIBER, "optTag.contains_glass_fiber"],
      [OPT_TAG.CONTAINS_KEVLAR, "optTag.contains_kevlar"],
      [OPT_TAG.CONTAINS_CARBON, "optTag.contains_carbon"],
      [OPT_TAG.CONTAINS_WOOD, "optTag.contains_wood"],
      [OPT_TAG.CONTAINS_METAL, "optTag.contains_metal"],
      [OPT_TAG.CONTAINS_STONE, "optTag.contains_stone"],
      [OPT_TAG.CONTAINS_CERAMIC, "optTag.contains_ceramic"],
      [OPT_TAG.IMITATES_WOOD, "optTag.imitates_wood"],
      [OPT_TAG.IMITATES_METAL, "optTag.imitates_metal"],
      [OPT_TAG.IMITATES_MARBLE, "optTag.imitates_marble"],
      [OPT_TAG.IMITATES_STONE, "optTag.imitates_stone"],
    ],
  },
];

/**
 * GH #529 / #538 — nozzle type catalog + display translation.
 *
 * The stored `type` value on a Nozzle is always English (so existing DB
 * rows, CSV / Atlas import, and the slicer integrations don't need a
 * migration). Display labels are translated via the `nozzleType.<key>`
 * i18n keys — `en` defaults to the same English text, `de` carries
 * "Messing" etc.
 *
 * This module is the single source of truth so every render site — the
 * NozzleForm select, the nozzles list table, the printer detail page's
 * installed-nozzle chips — translates the same way. Pre-fix the mapping
 * lived only inside NozzleForm, so a German user picked "Messing" in the
 * form but then saw "Brass" everywhere the value was rendered (Codex P2
 * round 1 on PR #538).
 *
 * DB-free + i18n-agnostic: takes the `t` function so it works in any
 * component without importing the provider here.
 */

/** Canonical nozzle types. `value` is what's stored; `i18nKey` resolves
 *  the display label. Extend BOTH this list AND the `nozzleType.<Key>`
 *  keys in en.json + de.json together — the i18n-key-coverage invariant
 *  test fails otherwise. */
export const NOZZLE_TYPES: { value: string; i18nKey: string }[] = [
  { value: "Brass", i18nKey: "nozzleType.Brass" },
  { value: "Hardened Steel", i18nKey: "nozzleType.HardenedSteel" },
  { value: "Stainless Steel", i18nKey: "nozzleType.StainlessSteel" },
  { value: "Copper", i18nKey: "nozzleType.Copper" },
  { value: "Ruby Tipped", i18nKey: "nozzleType.RubyTipped" },
  { value: "Tungsten Carbide", i18nKey: "nozzleType.TungstenCarbide" },
  { value: "ObXidian", i18nKey: "nozzleType.ObXidian" },
  { value: "Diamondback", i18nKey: "nozzleType.Diamondback" },
  { value: "Other", i18nKey: "nozzleType.Other" },
];

/** Stored value → i18n key. */
const KEY_BY_VALUE = new Map(NOZZLE_TYPES.map((n) => [n.value, n.i18nKey]));

/**
 * Translate a stored nozzle-type value for display. Falls back to the
 * raw stored value when it's not one of the known types (legacy data /
 * a future type the catalog hasn't caught up to) so we never render an
 * empty cell.
 */
export function nozzleTypeLabel(
  value: string | null | undefined,
  t: (key: string) => string,
): string {
  if (!value) return "";
  const key = KEY_BY_VALUE.get(value);
  return key ? t(key) : value;
}

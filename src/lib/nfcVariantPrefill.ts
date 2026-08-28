/**
 * GH #1177 Phase 1 — create-variant-from-tag prefill.
 *
 * When a scanned tag's data seeds a NEW VARIANT form, any prefilled value the
 * form later submits becomes an explicit override on the variant document —
 * and an override that merely EQUALS the parent's value silently severs
 * GH #106 live inheritance (the parent changes, the variant no longer
 * follows). That is the exact failure mode the v1.52 OPT variant import
 * solves server-side with pruneOptPayloadAgainstParent; this is the same
 * rule applied client-side to the NFC prefill: drop every inheritable field
 * whose tag value exactly equals the parent's stored value, so the form
 * seeds it blank and the variant keeps inheriting dynamically.
 *
 * Never pruned: name / color / colorName (variant identity), vendor / type
 * (required identity — the caller prefers the parent's), and totalWeight
 * (inventory — the physical roll being added, never inherited).
 * spoolWeight / netFilamentWeight ARE pruned when equal: they are shared
 * spec (#1048) that belongs on the template. Pruning only fires when BOTH
 * sides carry a value, so the Codex #706 r7/r8 zero-tare pin (spoolWeight 0
 * alongside an actual weight) survives unless the parent's tare is also 0 —
 * in which case inheritance yields the identical number anyway.
 */

import { snapToStep } from "@/lib/snapToStep";
import { unwrapIniString } from "@/lib/parseIni";

/** The raw parent doc fields the prune compares against (from ?raw=true). */
export interface VariantPrefillParent {
  density?: number | null;
  dryingTemperature?: number | null;
  dryingTime?: number | null;
  transmissionDistance?: number | null;
  settings?: Record<string, unknown> | null;
  diameter?: number | null;
  maxVolumetricSpeed?: number | null;
  shoreHardnessA?: number | null;
  shoreHardnessD?: number | null;
  netFilamentWeight?: number | null;
  spoolWeight?: number | null;
  temperatures?: Record<string, number | null> | null;
  optTags?: number[] | null;
  secondaryColors?: string[] | null;
}

const PRUNE_EQUAL_SCALARS = [
  "density",
  "diameter",
  "maxVolumetricSpeed",
  "shoreHardnessA",
  "shoreHardnessD",
  "netFilamentWeight",
  "spoolWeight",
  "dryingTemperature",
  "dryingTime",
  "transmissionDistance",
] as const;

/** density + diameter are seeded through the form's GH #570 snapToStep
 *  (CBOR half-floats: a tag's 1.24 decodes as 1.2392578125), so the OWN
 *  side is judged on the snapped value the form would actually submit.
 *  The PARENT side stays EXACT: the form never snaps an inherited value,
 *  so an off-grid parent (an imported 1.244) really does differ from a
 *  tag's snapped 1.24 and the override must survive (Codex #1183 r3/r5). */
const SNAP_BEFORE_COMPARE: ReadonlySet<string> = new Set(["density", "diameter"]);
const SNAP_STEP = 0.01;

/** The bag keys FilamentForm seeds through unwrapIniString (gcode/notes
 *  textareas): the wire holds `"Origin: CZ"` while an imported parent may
 *  hold the unquoted form — both DISPLAY identically, so equality must be
 *  judged on the unwrapped values (Codex P2 #1183 round 6). */
const INI_UNWRAPPED_SETTINGS: ReadonlySet<string> = new Set([
  "filament_notes",
  "start_filament_gcode",
  "end_filament_gcode",
]);

function sameNumericSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

/** POSITIONAL comparison, case-folded — secondary colors are ordered SLOTS
 *  (spec keys 20-24): gradients render in slot order and slot 0 is the
 *  representative slicer-export color, so the same colors in a different
 *  order are DIFFERENT data and must not be pruned (Codex P2 #1183). */
function sameColorSlots(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v.toLowerCase() === b[i].toLowerCase());
}

/**
 * Returns a copy of `prefill` with parent-equal inheritable values removed.
 * A field is pruned only when BOTH the prefill and the parent carry a value
 * and they are equal — a tag value the parent lacks stays, as a genuine
 * variant-owned value. Array fields (optTags, secondaryColors) prune on
 * set-equality (order-insensitive; colors case-insensitive), because an
 * empty array on a variant means "inherit the parent's whole array"
 * (GH #106 / #477 array-fallback). Temperature subfields prune
 * individually — each dotted path inherits on its own.
 */
export function pruneParentEqualPrefill(
  prefill: Record<string, unknown>,
  parent: VariantPrefillParent,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prefill };

  for (const field of PRUNE_EQUAL_SCALARS) {
    const own = out[field];
    const inherited = parent[field];
    if (typeof own !== "number" || typeof inherited !== "number") continue;
    const ownCmp = SNAP_BEFORE_COMPARE.has(field) ? snapToStep(own, SNAP_STEP) : own;
    if (ownCmp === inherited) {
      delete out[field];
    }
  }

  const ownTemps = out.temperatures;
  const parentTemps = parent.temperatures;
  if (
    ownTemps &&
    typeof ownTemps === "object" &&
    parentTemps &&
    typeof parentTemps === "object"
  ) {
    const pruned: Record<string, unknown> = { ...(ownTemps as Record<string, unknown>) };
    for (const [key, value] of Object.entries(pruned)) {
      const inherited = parentTemps[key];
      if (typeof value === "number" && typeof inherited === "number" && value === inherited) {
        pruned[key] = null;
      }
    }
    out.temperatures = pruned;
  }

  // Settings-bag entries the NFC prefill seeds (chamber_temperature, the
  // origin filament_notes) are inherited through the bag like any other
  // value — a parent-equal copy would sever propagation exactly like a
  // top-level scalar (Codex P2 #1183). String-compare per key; only prune
  // when the parent carries the identical string.
  const ownSettings = out.settings;
  const parentSettings = parent.settings;
  if (
    ownSettings &&
    typeof ownSettings === "object" &&
    parentSettings &&
    typeof parentSettings === "object"
  ) {
    const pruned: Record<string, unknown> = { ...(ownSettings as Record<string, unknown>) };
    for (const [key, value] of Object.entries(pruned)) {
      const inherited = (parentSettings as Record<string, unknown>)[key];
      // Mirror FilamentForm's getSettingVal exactly: a Mixed-bag parent
      // value may be a multi-element ARRAY (#678, first element displayed)
      // and may be a NUMBER (round-15 String-coercion) — the comparison
      // must judge what the form would SHOW, or a "45" prefill under a
      // parent [45] persists a parent-equal override (Codex #1183 r3/r4).
      const first = Array.isArray(inherited) ? inherited[0] : inherited;
      const inheritedStr =
        first == null || typeof first === "object" ? null : String(first);
      if (typeof value === "string" && inheritedStr !== null) {
        const unwrap = INI_UNWRAPPED_SETTINGS.has(key);
        const ownCmp = unwrap ? unwrapIniString(value) : value;
        const inheritedCmp = unwrap ? unwrapIniString(inheritedStr) : inheritedStr;
        if (ownCmp === inheritedCmp) {
          delete pruned[key];
        }
      }
    }
    out.settings = pruned;
  }

  const ownTags = out.optTags;
  if (
    Array.isArray(ownTags) &&
    ownTags.length > 0 &&
    Array.isArray(parent.optTags) &&
    parent.optTags.length > 0 &&
    sameNumericSet(ownTags as number[], parent.optTags)
  ) {
    delete out.optTags;
  }

  const ownSecondaries = out.secondaryColors;
  if (
    Array.isArray(ownSecondaries) &&
    ownSecondaries.length > 0 &&
    Array.isArray(parent.secondaryColors) &&
    parent.secondaryColors.length > 0 &&
    sameColorSlots(ownSecondaries as string[], parent.secondaryColors)
  ) {
    delete out.secondaryColors;
  }

  return out;
}

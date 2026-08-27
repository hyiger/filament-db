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

/** The raw parent doc fields the prune compares against (from ?raw=true). */
export interface VariantPrefillParent {
  density?: number | null;
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
] as const;

function sameNumericSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function sameColorSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (list: readonly string[]) => [...list].map((c) => c.toLowerCase()).sort();
  const sa = norm(a);
  const sb = norm(b);
  return sa.every((v, i) => v === sb[i]);
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
    if (typeof own === "number" && typeof inherited === "number" && own === inherited) {
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
    sameColorSet(ownSecondaries as string[], parent.secondaryColors)
  ) {
    delete out.secondaryColors;
  }

  return out;
}

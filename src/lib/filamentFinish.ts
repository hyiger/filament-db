/**
 * Visual-finish derivation from a filament's `optTags` array.
 *
 * Several optTag IDs correspond to a "finish" — a visual property that
 * differentiates two filaments that otherwise share a color (the classic
 * case: white plain / white matte / white silk look identical in the
 * inventory list without an indicator). This module turns the numeric
 * tag array on the filament doc into a single canonical finish string
 * that `<FilamentSwatch>` consumes for its texture treatment and that
 * `<FinishChip>` consumes for the label beside the name.
 *
 * The tag IDs themselves are owned by the FilamentForm UI (see the
 * material-tags fieldset in `src/app/filaments/FilamentForm.tsx`).
 * Repeating the numeric IDs here is the lesser of two evils — pulling
 * the form's array into a shared module would couple `src/lib/` to the
 * form's React tree, and these IDs are effectively frozen (they map to
 * OpenPrintTag and Bambu tag enum values).
 *
 * Priority order when multiple finish-relevant tags coexist on one
 * filament:
 *   transparent → translucent → sparkle → silk → glow → matte
 * Transparent / translucent dominate because they fundamentally change how
 * the swatch is rendered (real alpha over a checker backdrop); sparkle /
 * silk / matte are ranked by visual distinctiveness; glow ranks last
 * because it's an *additive* property rather than a primary visual finish.
 */

export type Finish =
  | "matte"
  | "silk"
  | "sparkle"
  | "glow"
  | "translucent"
  | "transparent";

/**
 * optTag IDs that map onto a `Finish`. Anything else in the array
 * (abrasive, water-soluble, food-safe, carbon-fiber, …) is ignored —
 * those tags affect material properties, not how the swatch reads.
 */
const FINISH_BY_TAG_ID: Record<number, Finish> = {
  2: "transparent",
  3: "translucent",
  16: "matte",
  17: "silk",
  22: "sparkle",
  24: "glow",
};

/** Tag IDs that this module considers when deriving a finish. */
export const FINISH_TAG_IDS: readonly number[] = Object.keys(FINISH_BY_TAG_ID).map(Number);

/** Priority order — earlier entries win when multiple finishes coexist. */
const PRIORITY: readonly Finish[] = [
  "transparent",
  "translucent",
  "sparkle",
  "silk",
  "glow",
  "matte",
];

/**
 * Derive the single canonical finish for a filament given its optTags
 * array. Returns `null` when the filament has no finish-relevant tag
 * (i.e. it's a plain solid swatch — the existing default behaviour).
 *
 * Accepts undefined/null for convenience because list summaries from
 * older clients may omit the field.
 */
export function deriveFinish(optTags: readonly number[] | null | undefined): Finish | null {
  if (!optTags || optTags.length === 0) return null;
  const present = new Set<Finish>();
  for (const id of optTags) {
    const f = FINISH_BY_TAG_ID[id];
    if (f) present.add(f);
  }
  if (present.size === 0) return null;
  for (const f of PRIORITY) {
    if (present.has(f)) return f;
  }
  return null;
}

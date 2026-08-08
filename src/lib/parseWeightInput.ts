/**
 * Validator for a hand-typed spool weight in grams.
 *
 * Extracted so the inventory page and the detail page can agree, and so the
 * rule is unit-testable — the pages themselves are client components the
 * node-only vitest env can't render.
 *
 * ## The bug this exists to prevent (GH #1105)
 *
 * `Number("") === 0`. The inventory page's inline editor guarded with
 * `!Number.isFinite(n) || n < 0`, which an empty field sails straight through:
 * clearing the box and clicking Save wrote `totalWeight: 0`, dropping the
 * remaining bar to 0%, and taking that spool's weight out of the location and
 * library totals — with no validation error. Whitespace was equally lethal
 * (`Number(" ") === 0`).
 *
 * So the empty check MUST come first and MUST be on the trimmed string. That
 * is the whole point of this module; a future "simplification" that folds it
 * into the finite check reintroduces the bug exactly.
 *
 * `Number` rather than `parseFloat` is also deliberate: `parseFloat("12abc")`
 * is 12, which would silently accept a typo as a real reading.
 *
 * No decimal-separator handling belongs here — `<input type="number">`
 * normalises the separator to `.` before we ever see the value, regardless of
 * the user's locale or their v1.66 number-format preference.
 */

/** Why a typed weight was rejected. Callers map this to a message. */
export type WeightInputProblem = "empty" | "invalid" | "negative";

export type ParsedWeightInput =
  | { ok: true; grams: number }
  | { ok: false; reason: WeightInputProblem };

export function parseWeightInput(raw: string): ParsedWeightInput {
  const trimmed = raw.trim();
  // Must precede the Number() call — see the docblock.
  if (trimmed === "") return { ok: false, reason: "empty" };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, reason: "invalid" };
  if (n < 0) return { ok: false, reason: "negative" };
  return { ok: true, grams: n };
}

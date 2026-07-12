/**
 * Substitute `{param}` tokens in a translation template with param values.
 *
 * GH #1007 F1: each value is inserted LITERALLY via a *function* replacement.
 * A string second argument to `String.prototype.replace` interprets `$$`,
 * `$&`, `` $` `` and `$'` as special replacement patterns — so a param value
 * carrying them (e.g. a filament named "Cheap $$ PLA", or a raw server error
 * string) would render corrupted, including in the destructive delete/retire
 * confirm dialogs. A function replacement bypasses that pattern handling.
 *
 * Extracted from TranslationProvider so the substitution is unit-testable
 * without a React renderer (the test env is node, no jsdom).
 */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  let value = template;
  for (const [paramName, paramValue] of Object.entries(params)) {
    value = value.replace(
      new RegExp(`\\{${paramName}\\}`, "g"),
      () => String(paramValue),
    );
  }
  return value;
}

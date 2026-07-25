/**
 * Substitute `{param}` tokens in a translation template with param values.
 *
 * TWO independent hazards live here; the implementation below closes both and
 * neither may be "simplified" away.
 *
 * GH #1007 F1 — the REPLACEMENT must stay a FUNCTION. A string second argument
 * to `String.prototype.replace` interprets `$$`, `$&`, `` $` `` and `$'` as
 * special replacement patterns, so a param value carrying them (e.g. a filament
 * named "Cheap $$ PLA", or a raw server error string) would render corrupted.
 * A function replacement bypasses that pattern handling entirely.
 *
 * GH #1029 — the SCAN must be SINGLE-PASS. The previous implementation folded
 * over `Object.entries(params)`, re-scanning the OUTPUT of each pass:
 *
 *     let value = template;
 *     for (const [k, v] of Object.entries(params))
 *       value = value.replace(new RegExp(`\\{${k}\\}`, "g"), () => String(v));
 *
 * so a `{token}` sitting inside an ALREADY-SUBSTITUTED value was picked up as a
 * live token by a later iteration and replaced. Filament, printer and location
 * names are user-controlled and do flow into multi-param strings, e.g.
 *
 *     interpolate("Delete {name}? ({count} spools)", { name: "PLA {count}", count: 7 })
 *       was -> "Delete PLA 7? (7 spools)"      // the name's literal {count} got substituted
 *       now -> "Delete PLA {count}? (7 spools)"
 *
 * Worse, whether it bit depended on the CALL SITE's object-key insertion order
 * (a value can only inject a token belonging to a LATER param), so it was
 * invisible until someone reordered an object literal. Scanning the template
 * exactly once makes an inserted value structurally unreachable as a token and
 * removes the order dependence entirely.
 *
 * Building one regex here rather than one per param per call also fixes a
 * latent mis-match: the old code spliced `paramName` into a `RegExp` unescaped,
 * so a key containing regex metacharacters matched by luck (`.` as a wildcard).
 *
 * Extracted from TranslationProvider so the substitution is unit-testable
 * without a React renderer (the test env is node, no jsdom).
 */

/**
 * Matches every `{token}` in a template.
 *
 * `\w+` is exactly the token grammar both locale files use — verified against
 * all 61 distinct tokens in `en.json` + `de.json`, and pinned by the invariant
 * test in `tests/i18nInterpolate.test.ts` so a future dotted/hyphenated key
 * fails LOUDLY in CI rather than silently not substituting. If that test ever
 * trips, widen this class rather than deleting the test.
 *
 * Module-scoped with the `g` flag is safe here because
 * `String.prototype.replace` resets `lastIndex` to 0 before matching a global
 * regex (unlike `.test()` / `.exec()`, which advance it).
 */
const TOKEN_RE = /\{(\w+)\}/g;

export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(TOKEN_RE, (match, name: string) =>
    // hasOwnProperty, not `params[name] !== undefined`: an unknown token must
    // survive verbatim (matching the previous behaviour), and an inherited
    // Object.prototype key must never be substitutable.
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : match,
  );
}

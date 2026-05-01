/**
 * Pure helpers for the user-defined currency list (GH #140).
 *
 * Currency entries are persisted as a JSON-serialized array of
 * `{ code, symbol, name }`. Splitting these helpers out of `useCurrency.ts`
 * keeps validation and storage parsing testable without React or DOM
 * dependencies.
 */

export interface CustomCurrency {
  /** ISO-4217-style 3-letter uppercase code (or any other 2–6 letter
   * uppercase identifier). Codes are unique across the whole list and
   * must not collide with the built-in CURRENCIES list. */
  code: string;
  /** Display symbol — typically 1 character ("$") but allow short multi-char
   * identifiers (e.g. "kr") that some currencies use. */
  symbol: string;
  /** Optional human-readable name (e.g. "Swedish Krona"). May be empty. */
  name: string;
}

export type ValidationError =
  | "code-empty"
  | "code-too-short"
  | "code-too-long"
  | "code-invalid-chars"
  | "code-collides-builtin"
  | "code-duplicate"
  | "symbol-empty"
  | "symbol-too-long";

const CODE_RE = /^[A-Z][A-Z0-9]{1,5}$/;
const SYMBOL_MAX = 4;

/** Normalise a code candidate: trim + uppercase. */
export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Normalise a symbol candidate: trim only. Symbols are case-significant. */
export function normaliseSymbol(raw: string): string {
  return raw.trim();
}

/**
 * Validate a custom-currency candidate against:
 *   - shape rules (non-empty code 2–6 chars, alpha + digits, starts alpha;
 *     non-empty symbol ≤ 4 chars)
 *   - collisions with the supplied built-in code list
 *   - duplicates against the supplied existing-custom list (matched on code)
 *
 * Returns null on success, or a ValidationError discriminator. Callers map
 * the discriminator to a localised string — keeping it as an enum lets the
 * tests assert specific failure modes without coupling to UI copy.
 */
export function validateCustomCurrency(
  entry: { code: string; symbol: string; name?: string },
  builtInCodes: string[],
  existingCustom: CustomCurrency[],
): ValidationError | null {
  const code = entry.code;
  const symbol = entry.symbol;

  if (!code) return "code-empty";
  if (code.length < 2) return "code-too-short";
  if (code.length > 6) return "code-too-long";
  if (!CODE_RE.test(code)) return "code-invalid-chars";

  if (builtInCodes.includes(code)) return "code-collides-builtin";
  if (existingCustom.some((c) => c.code === code)) return "code-duplicate";

  if (!symbol) return "symbol-empty";
  if (symbol.length > SYMBOL_MAX) return "symbol-too-long";

  return null;
}

/** Append a custom currency to the list. Caller is responsible for calling
 * `validateCustomCurrency` first; this helper trusts its input. */
export function addCustomCurrency(
  list: CustomCurrency[],
  entry: CustomCurrency,
): CustomCurrency[] {
  return [...list, entry];
}

/** Remove a custom currency by code. Match is case-insensitive on code so
 * the caller can pass user input without normalising first. */
export function removeCustomCurrency(
  list: CustomCurrency[],
  code: string,
): CustomCurrency[] {
  const target = code.trim().toUpperCase();
  return list.filter((c) => c.code !== target);
}

/**
 * Parse the JSON blob persisted to storage back into a CustomCurrency[].
 * Robust against bad shapes — anything missing required fields, duplicates,
 * or built-in collisions is dropped. Returns an empty array on any failure.
 *
 * The defensive filter keeps a corrupted prefs file from poisoning the UI.
 */
export function parseCustomCurrencies(
  json: string | null | undefined,
  builtInCodes: string[],
): CustomCurrency[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>(builtInCodes);
  const out: CustomCurrency[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = raw as any;
    const code = typeof r.code === "string" ? normaliseCode(r.code) : "";
    const symbol = typeof r.symbol === "string" ? normaliseSymbol(r.symbol) : "";
    const name = typeof r.name === "string" ? r.name : "";
    if (!code || !symbol) continue;
    if (seen.has(code)) continue; // skip dupes & built-in collisions
    if (!CODE_RE.test(code)) continue;
    if (symbol.length > SYMBOL_MAX) continue;
    seen.add(code);
    out.push({ code, symbol, name });
  }
  return out;
}

/** JSON-serialize the list for storage. Dual to parseCustomCurrencies. */
export function serializeCustomCurrencies(list: CustomCurrency[]): string {
  return JSON.stringify(list);
}

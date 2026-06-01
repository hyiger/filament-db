import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import de from "../src/i18n/locales/de.json" with { type: "json" };

/**
 * Catches the regression pattern from issue #490: a developer adds a
 * new `t("some.key")` call somewhere in `src/` but forgets to add the
 * key to one (or both) of the locale files. The fallback when a key
 * is missing is to render the key string verbatim — invisible for
 * regular UI copy because it usually looks similar to the intent,
 * but actively harmful for ARIA labels where screen readers
 * happily announce "filter dot aria dot quick" to the user.
 *
 * Implementation strategy:
 *   1. Walk src/ recursively for TS/TSX files.
 *   2. Extract every literal `t("key")` or `t('key')` (including the
 *      two-arg form `t("key", { ... })`). Skip dynamic forms like
 *      `t(varName)` — those can't be checked statically and are rare
 *      in this codebase anyway.
 *   3. Assert each extracted key exists in every locale.
 *
 * The test is purely string-based — no React rendering, no Vite —
 * so it's fast (a few hundred ms) and stays valid regardless of
 * how t() is implemented under the hood.
 */

const SRC_DIR = join(__dirname, "..", "src");

/**
 * Recursively collect every .ts / .tsx file under `src/`.
 * Skips node_modules and the locale JSON files themselves.
 */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules") continue;
      collectSourceFiles(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Match every `t("key")` and `t('key')` call. The capture is the key
 * string (single or double-quoted). Skips templates and dynamic args.
 *
 *   t("foo.bar")            ✓ match → "foo.bar"
 *   t('foo.bar')            ✓ match → "foo.bar"
 *   t("foo.bar", { x: 1 })  ✓ match → "foo.bar"
 *   t(someVar)              ✗ not statically known
 *   t(`literal`)            ✗ template (rarely used; ignore)
 */
const T_CALL = /\bt\(\s*(["'])((?:(?!\1).)*)\1/g;

function extractKeysFromSource(filePath: string): Set<string> {
  const text = readFileSync(filePath, "utf-8");
  const keys = new Set<string>();
  let match;
  while ((match = T_CALL.exec(text)) !== null) {
    keys.add(match[2]);
  }
  return keys;
}

describe("i18n key coverage", () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);
  const referencedKeys = new Set<string>();
  for (const file of sourceFiles) {
    for (const key of extractKeysFromSource(file)) {
      referencedKeys.add(key);
    }
  }

  const enKeys = new Set(Object.keys(en as Record<string, string>));
  const deKeys = new Set(Object.keys(de as Record<string, string>));

  it("scans a sensible number of source files (sanity check)", () => {
    // If a future refactor moves src/ around and this scanner finds
    // zero files, the rest of the test would silently pass with an
    // empty keys set. Pin the floor so that regression is loud.
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it("extracts a sensible number of t() keys (sanity check)", () => {
    expect(referencedKeys.size).toBeGreaterThan(100);
  });

  it("every t() key referenced in src/ exists in en.json", () => {
    const missing = [...referencedKeys].filter((k) => !enKeys.has(k)).sort();
    expect(
      missing,
      `Missing ${missing.length} key(s) in en.json — referenced in source but not defined. ` +
        `Add them to src/i18n/locales/en.json (and de.json):\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every t() key referenced in src/ exists in de.json", () => {
    const missing = [...referencedKeys].filter((k) => !deKeys.has(k)).sort();
    expect(
      missing,
      `Missing ${missing.length} key(s) in de.json — referenced in source but not defined. ` +
        `Add them to src/i18n/locales/de.json (and en.json):\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("en.json and de.json have the same key set (parity)", () => {
    // Stricter than the cross-checks above: catches keys defined in
    // one locale but accidentally dropped from the other (the failure
    // mode that lets a locale fall back to the raw key under user-
    // facing copy, not just under-static-check). Same parity guarantee
    // jq 'keys|length' has been giving us by hand.
    const onlyEn = [...enKeys].filter((k) => !deKeys.has(k)).sort();
    const onlyDe = [...deKeys].filter((k) => !enKeys.has(k)).sort();
    expect(onlyEn, `Keys in en.json but missing from de.json:\n  ${onlyEn.join("\n  ")}`).toEqual([]);
    expect(onlyDe, `Keys in de.json but missing from en.json:\n  ${onlyDe.join("\n  ")}`).toEqual([]);
  });
});

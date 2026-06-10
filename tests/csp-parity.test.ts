import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * GH #408 / #635 — Electron CSP parity guard.
 *
 * The Electron renderer's `onHeadersReceived` overrides whatever CSP
 * the embedded Next.js server sends, so any directive present in the
 * web CSP (`next.config.ts`) but absent from the Electron header
 * (`electron/main.ts`) silently drops in desktop builds. v1.25.1 +
 * v1.30.3 both shipped with that exact drift; this test fails fast
 * when a future change touches one side and forgets the other.
 *
 * GH #635: the original test compared directive NAME sets only, so a
 * token added to one side (the exact v1.30.3 `img-src https:` drift,
 * #371) slipped through. It now parses each CSP into directive →
 * value-token sets and diffs the tokens per directive, with explicit
 * carve-outs for the two documented variances:
 *   - `connect-src` — Electron adds `ws://localhost:* http://localhost:*`
 *     for the embedded server. Web's tokens must be a SUBSET of
 *     Electron's, and the extras must be EXACTLY that localhost pair.
 *   - `script-src` — both files declare a dev and a prod variant
 *     (Turbopack/RSC need `'unsafe-eval'` in dev only; web gates on
 *     NODE_ENV, Electron on app.isPackaged). The two variant sets must
 *     pair up exactly across the files.
 */
const REPO_ROOT = resolve(__dirname, "..");

/**
 * Codex feedback on PR #462: the earlier regex required the directive
 * name to follow `;` or start-of-file, which never matches the web CSP
 * where each directive lives in its own JS string literal like
 * `"default-src 'self'"`. The directive name there is right after a
 * `"` — not after a `;`.
 *
 * So each known directive name is matched preceded by ANY non-word
 * boundary (`;`, `"`, `'`, `\``, whitespace, BOL) and followed by
 * whitespace + a value. This matches both:
 *   - one big template literal: `"… ;${scriptSrc}; style-src 'self'…"`
 *   - per-line quoted strings: `"default-src 'self'"`, `"style-src…"`
 * Comments in the file (the prose mentioning a directive name) won't
 * match because they're stripped first, and a survivor would still
 * need its value to start with a CSP value token.
 */
const KNOWN_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "frame-src",
  "frame-ancestors",
  "base-uri",
  "form-action",
  "object-src",
  "media-src",
  "worker-src",
  "manifest-src",
  "child-src",
] as const;

/** The ONE intentional `connect-src` asymmetry: Electron's allowance for
 *  the embedded Next server. Anything else appearing on only one side is
 *  drift and must fail the parity check. */
const CONNECT_SRC_ELECTRON_EXTRAS = ["http://localhost:*", "ws://localhost:*"];

/**
 * Strip JS / TS comments before scanning for directives. Codex
 * follow-up on PR #462 round 2: the regex matches directive names
 * followed by a CSP value token, but the source file contains
 * COMMENTS that quote real CSP fragments verbatim (e.g.
 * `// 'base-uri 'self'' (prevents <base> injection)`). Those
 * comment mentions would falsely satisfy the parity assertion.
 *
 * Doesn't try to be a full TS parser — the only comment shapes in
 * this repo are `// line` and `/* block *​/`, so a tiny regex pass
 * is enough. The negative lookbehind on `//` (preceding char not
 * `:`) keeps `https://` / `mongodb://` URLs in code from being
 * misread as line comments.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** A plausible first token of a CSP directive value — filters out any
 *  stray prose match that survived comment stripping. */
const VALUE_START =
  /^(?:'(?:self|none|unsafe-(?:inline|eval))'|https?:|wss?:|data:|blob:|\*|[a-z0-9.\-]+)/i;

/**
 * Parse a source file into directive → list of value-token arrays.
 * A directive can occur more than once (the dev/prod `script-src`
 * variants); each occurrence keeps its own token array. The value run
 * ends at a `;`, a string-literal boundary (`"` / backtick), a template
 * placeholder (`$`), or end-of-line — single quotes stay IN the run
 * because CSP keyword tokens are single-quoted.
 */
function readDirectiveTokens(filePath: string): Map<string, string[][]> {
  const raw = readFileSync(resolve(REPO_ROOT, filePath), "utf8");
  const text = stripComments(raw);
  const found = new Map<string, string[][]>();
  for (const name of KNOWN_DIRECTIVES) {
    // Match the directive name preceded by a non-word-char boundary
    // (so `style-src` doesn't accidentally match inside `frame-style-src`)
    // and capture the value run that follows.
    const pattern = new RegExp(
      String.raw`(?:^|[^a-zA-Z\-])` +
        name.replace(/-/g, "\\-") +
        String.raw`[ \t]+([^;"\`$\n]+)`,
      "g",
    );
    for (const match of text.matchAll(pattern)) {
      const value = match[1].trim();
      if (!value || !VALUE_START.test(value)) continue;
      const tokens = value.split(/\s+/);
      const list = found.get(name) ?? [];
      list.push(tokens);
      found.set(name, list);
    }
  }
  return found;
}

/** Sorted union of every occurrence's tokens. */
function unionTokens(occurrences: string[][]): string[] {
  return [...new Set(occurrences.flat())].sort();
}

/** Canonical, order-independent key per variant — used to pair the
 *  dev/prod `script-src` declarations across the two files. */
function variantKeys(occurrences: string[][]): string[] {
  return occurrences.map((tokens) => [...new Set(tokens)].sort().join(" ")).sort();
}

/**
 * Value-level diff of the two CSPs. Returns one human-readable problem
 * string per mismatch — empty means parity (modulo the documented
 * carve-outs). Kept as a pure function so the guard itself can be
 * exercised against synthetic drift below (GH #635: the test must fail
 * when e.g. `https://cdn.example` lands in one side's `img-src` only).
 */
function diffCspTokens(
  web: Map<string, string[][]>,
  electron: Map<string, string[][]>,
): string[] {
  const problems: string[] = [];
  const names = [...new Set([...web.keys(), ...electron.keys()])].sort();
  for (const name of names) {
    const w = web.get(name) ?? [];
    const e = electron.get(name) ?? [];
    if (w.length === 0) {
      problems.push(`${name}: declared in the Electron CSP but missing from the web CSP`);
      continue;
    }
    if (e.length === 0) {
      problems.push(`${name}: declared in the web CSP but missing from the Electron CSP`);
      continue;
    }
    if (name === "connect-src") {
      // Carve-out: Electron adds the embedded-server localhost pair on
      // top of the web tokens — nothing more, nothing less.
      const webSet = new Set(w.flat());
      const electronSet = new Set(e.flat());
      const missing = [...webSet].filter((t) => !electronSet.has(t)).sort();
      if (missing.length > 0) {
        problems.push(`connect-src: Electron is missing web tokens [${missing.join(" ")}]`);
      }
      const extras = [...electronSet].filter((t) => !webSet.has(t)).sort();
      if (extras.join(" ") !== CONNECT_SRC_ELECTRON_EXTRAS.join(" ")) {
        problems.push(
          `connect-src: Electron extras must be exactly [${CONNECT_SRC_ELECTRON_EXTRAS.join(" ")}] ` +
            `(the embedded-server allowance), got [${extras.join(" ") || "none"}]`,
        );
      }
      continue;
    }
    if (name === "script-src") {
      // Carve-out: both sides declare a dev and a prod variant (the
      // dev-only 'unsafe-eval' gating). Compare the variant SETS so a
      // token added to one side's dev OR prod variant still trips.
      const webVariants = variantKeys(w);
      const electronVariants = variantKeys(e);
      if (webVariants.join(" | ") !== electronVariants.join(" | ")) {
        problems.push(
          `script-src: variants differ — web [${webVariants.join(" | ")}] ` +
            `vs electron [${electronVariants.join(" | ")}]`,
        );
      }
      continue;
    }
    const webUnion = unionTokens(w);
    const electronUnion = unionTokens(e);
    if (webUnion.join(" ") !== electronUnion.join(" ")) {
      problems.push(
        `${name}: tokens differ — web [${webUnion.join(" ")}] vs electron [${electronUnion.join(" ")}]`,
      );
    }
  }
  return problems;
}

describe("CSP parity — web (next.config.ts) vs Electron (electron/main.ts)", () => {
  const web = readDirectiveTokens("next.config.ts");
  const electron = readDirectiveTokens("electron/main.ts");

  it("the parser actually finds both CSPs (guards against a refactor blinding this test)", () => {
    // If either file moves its CSP somewhere the regex can't see, both
    // maps go empty and a naive diff would vacuously pass — pin the
    // core directives so that failure mode is loud instead.
    for (const name of ["default-src", "script-src", "img-src", "connect-src", "object-src"]) {
      expect(web.has(name), `web CSP should declare ${name}`).toBe(true);
      expect(electron.has(name), `Electron CSP should declare ${name}`).toBe(true);
    }
  });

  it("every directive carries the same value tokens on both sides (GH #635)", () => {
    expect(diffCspTokens(web, electron)).toEqual([]);
  });

  it("connect-src: Electron's only extras are the embedded-server localhost pair", () => {
    const webSet = new Set((web.get("connect-src") ?? []).flat());
    const electronSet = new Set((electron.get("connect-src") ?? []).flat());
    for (const token of webSet) {
      expect(electronSet.has(token), `Electron connect-src should carry web's "${token}"`).toBe(true);
    }
    const extras = [...electronSet].filter((t) => !webSet.has(t)).sort();
    expect(extras).toEqual(CONNECT_SRC_ELECTRON_EXTRAS);
  });

  it("script-src: the dev and prod variants pair up exactly across both files", () => {
    const webVariants = variantKeys(web.get("script-src") ?? []);
    const electronVariants = variantKeys(electron.get("script-src") ?? []);
    // Two declarations per file: prod (no eval) + dev ('unsafe-eval').
    expect(webVariants).toHaveLength(2);
    expect(electronVariants).toEqual(webVariants);
  });

  it("Electron CSP carries the four hardening directives added in #408", () => {
    expect(electron.has("frame-ancestors")).toBe(true);
    expect(electron.has("base-uri")).toBe(true);
    expect(electron.has("form-action")).toBe(true);
    expect(electron.has("object-src")).toBe(true);
  });
});

describe("CSP parity guard self-test (GH #635)", () => {
  // The #371 regression shape: a source token added to ONE side's
  // img-src. The original name-set comparison passed on this; the
  // value-level diff must flag it.
  it("flags a token added to only one side's img-src", () => {
    const web = new Map([["img-src", [["'self'", "data:"]]]]);
    const electron = new Map([["img-src", [["'self'", "data:", "https://cdn.example"]]]]);
    expect(diffCspTokens(web, electron)).toEqual([
      expect.stringContaining("img-src: tokens differ"),
    ]);
  });

  it("flags a directive present on only one side", () => {
    const web = new Map([["media-src", [["'self'"]]]]);
    const electron = new Map<string, string[][]>();
    expect(diffCspTokens(web, electron)).toEqual([
      expect.stringContaining("missing from the Electron CSP"),
    ]);
  });

  it("flags a connect-src extra beyond the documented localhost pair", () => {
    const web = new Map([["connect-src", [["'self'"]]]]);
    const electron = new Map([
      ["connect-src", [["'self'", "ws://localhost:*", "http://localhost:*", "https://evil.example"]]],
    ]);
    expect(diffCspTokens(web, electron)).toEqual([
      expect.stringContaining("connect-src: Electron extras must be exactly"),
    ]);
  });

  it("accepts the documented carve-outs (localhost pair + dev-only unsafe-eval)", () => {
    const web = new Map([
      ["connect-src", [["'self'"]]],
      ["script-src", [["'self'", "'unsafe-inline'", "'unsafe-eval'"], ["'self'", "'unsafe-inline'"]]],
    ]);
    const electron = new Map([
      ["connect-src", [["'self'", "ws://localhost:*", "http://localhost:*"]]],
      ["script-src", [["'self'", "'unsafe-inline'"], ["'self'", "'unsafe-inline'", "'unsafe-eval'"]]],
    ]);
    expect(diffCspTokens(web, electron)).toEqual([]);
  });

  it("flags a token added to only one side's script-src dev variant", () => {
    const web = new Map([
      ["script-src", [["'self'", "'unsafe-inline'", "'unsafe-eval'"], ["'self'", "'unsafe-inline'"]]],
    ]);
    const electron = new Map([
      ["script-src", [
        ["'self'", "'unsafe-inline'"],
        ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.example"],
      ]],
    ]);
    expect(diffCspTokens(web, electron)).toEqual([
      expect.stringContaining("script-src: variants differ"),
    ]);
  });
});

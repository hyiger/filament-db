import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * GH #408 — Electron CSP parity guard.
 *
 * The Electron renderer's `onHeadersReceived` overrides whatever CSP
 * the embedded Next.js server sends, so any directive present in the
 * web CSP (`next.config.ts`) but absent from the Electron header
 * (`electron/main.ts`) silently drops in desktop builds. v1.25.1 +
 * v1.30.3 both shipped with that exact drift; this test fails fast
 * when a future change touches one side and forgets the other.
 *
 * The ONE intentional asymmetry is `connect-src` — Electron adds
 * `ws://localhost:* http://localhost:*` for the embedded server.
 * `script-src` ALSO carries a dev-vs-packaged variance (Turbopack
 * needs `unsafe-eval` in dev), so we just verify both files declare
 * the directive and don't compare its tokens.
 */
const REPO_ROOT = resolve(__dirname, "..");

/**
 * Codex feedback on PR #462: the earlier regex required the directive
 * name to follow `;` or start-of-file, which never matches the web CSP
 * where each directive lives in its own JS string literal like
 * `"default-src 'self'"`. The directive name there is right after a
 * `"` — not after a `;`.
 *
 * Replace the position-anchored regex with one that finds each known
 * CSP directive name preceded by ANY non-word boundary (`;`, `"`, `'`,
 * `\``, whitespace, BOL) and followed by whitespace + a value. This
 * matches both:
 *   - one big template literal: `"… ;${scriptSrc}; style-src 'self'…"`
 *   - per-line quoted strings: `"default-src 'self'"`, `"style-src…"`
 * Comments in the file (the prose mentioning a directive name) won't
 * match because they're not followed by whitespace + a CSP value
 * unless the test ALSO accepts a comma / period, which we don't.
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

function readDirectives(filePath: string): Set<string> {
  const raw = readFileSync(resolve(REPO_ROOT, filePath), "utf8");
  const text = stripComments(raw);
  const seen = new Set<string>();
  for (const name of KNOWN_DIRECTIVES) {
    // Match the directive name preceded by a non-word-char boundary
    // (so `style-src` doesn't accidentally match inside `frame-style-src`)
    // and followed by whitespace + a value that starts with a CSP value
    // token (`'self'`, `'none'`, `https:`, `data:`, `blob:`, `*`, `ws:`,
    // or a hostname-like character).
    const pattern = new RegExp(
      String.raw`(?:^|[^a-z\-])` +
        name.replace(/-/g, "\\-") +
        String.raw`\s+(?:'(?:self|none|unsafe-(?:inline|eval))'|https?:|wss?:|data:|blob:|\*|[a-z0-9.\-]+)`,
      "i",
    );
    if (pattern.test(text)) {
      seen.add(name);
    }
  }
  return seen;
}

describe("CSP parity — web (next.config.ts) vs Electron (electron/main.ts)", () => {
  it("every directive on the web side is also present on the Electron side", () => {
    const web = readDirectives("next.config.ts");
    const electron = readDirectives("electron/main.ts");
    const missing = [...web].filter((d) => !electron.has(d));
    expect(missing).toEqual([]);
  });

  it("Electron CSP carries the four hardening directives added in #408", () => {
    const electron = readDirectives("electron/main.ts");
    expect(electron.has("frame-ancestors")).toBe(true);
    expect(electron.has("base-uri")).toBe(true);
    expect(electron.has("form-action")).toBe(true);
    expect(electron.has("object-src")).toBe(true);
  });
});

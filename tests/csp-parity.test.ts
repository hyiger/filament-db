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

function readDirectives(filePath: string): Set<string> {
  const text = readFileSync(resolve(REPO_ROOT, filePath), "utf8");
  // Match every CSP directive name (the token right after `;` or at the
  // start of a CSP string literal, before the value). We grep across the
  // whole file rather than parse it so the test doesn't depend on the
  // exact line layout.
  const seen = new Set<string>();
  for (const match of text.matchAll(/(?:^|;\s*)([a-z\-]+)\s+[^;'"]*?(?=[;'"])/g)) {
    const name = match[1];
    // Filter to real CSP directive names — there are only ~15 of them
    // and we don't want to pick up arbitrary CSS-like tokens.
    if (
      [
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
      ].includes(name)
    ) {
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

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  FILE,
  FIXED_MARKER,
  REPLACEMENTS,
  patchSource,
} from "../scripts/patch-app-builder-keychain.mjs";

/**
 * app-builder-lib <= 26.16.0 authenticates `security set-key-partition-list -k`
 * with the p12 EXPORT password instead of the temp keychain's own random
 * password. macOS 26.5.2 tolerated the wrong argument; 26.6.2 validates it, and
 * the macOS signing step dies with "SecKeychainUnlock: ... not correct" —
 * reproduced locally on 26.6.2/25G83, the same build as the runner that failed
 * the v1.81.0 tag. Upstream fixed it in 27.0.0-alpha.8 with no 26.x backport.
 *
 * These tests exist so that a dependency bump which MOVES the anchors fails
 * here, at PR time, instead of on release day — the script itself only
 * discovers it while packaging.
 */

// A minimal stand-in for the three regions the patch touches.
const PRISTINE = `
    const keychainPassword = (0, crypto_1.randomBytes)(32).toString("base64");
    return await importCerts(keychainFile, certPaths, cscPasswords);
async function importCerts(keychainFile, paths, keyPasswords) {
        const password = keyPasswords[i] ?? "";
        await exec("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]);
`;

describe("patchSource", () => {
  it("rewrites -k to the keychain password, not the p12 password", () => {
    const out = patchSource(PRISTINE);
    expect(out).not.toBeNull();
    expect(out).toContain('"-k", keychainPassword, keychainFile]');
    expect(out).not.toContain('"-k", password, keychainFile]');
  });

  it("threads the keychain password through importCerts", () => {
    const out = patchSource(PRISTINE) as string;
    expect(out).toContain("importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)");
    expect(out).toContain("async function importCerts(keychainFile, paths, keyPasswords, keychainPassword)");
  });

  it("is a no-op on already-fixed source", () => {
    expect(patchSource(patchSource(PRISTINE) as string)).toBeNull();
    expect(patchSource(`x ${FIXED_MARKER} y`)).toBeNull();
  });

  it("THROWS rather than silently doing nothing when an anchor is missing", () => {
    // The whole point: a silent no-op would ship an unpatched build, which then
    // either fails opaquely at signing or (with forceCodeSigning) reddens late.
    expect(() => patchSource("unrelated file contents")).toThrow(/expected exactly 1 occurrence/);
  });

  it("throws when an anchor is ambiguous", () => {
    expect(() => patchSource(PRISTINE + PRISTINE)).toThrow(/found 2/);
  });

  it("names the offending anchor so the failure is actionable", () => {
    expect(() => patchSource("nope")).toThrow(/set-key-partition-list -k|importCerts|-k", password/);
  });
});

describe("the installed app-builder-lib still matches the anchors", () => {
  // Skipped where node_modules isn't present (it always is in CI and locally).
  const installed = existsSync(FILE) ? readFileSync(FILE, "utf8") : null;

  it.skipIf(installed === null)(
    "is either already fixed, or patchable without error",
    () => {
      // If a bump moves the code, this throws HERE rather than during a release.
      expect(() => patchSource(installed as string)).not.toThrow();
    },
  );

  it.skipIf(installed === null)("exposes exactly three replacements", () => {
    expect(REPLACEMENTS).toHaveLength(3);
  });
});

#!/usr/bin/env node
/**
 * Backport of electron-builder's own fix for the macOS temp-keychain bug.
 *
 * app-builder-lib <= 26.16.0 creates its temporary signing keychain with a
 * random password (`createKeychain`, `randomBytes(32)`), but then authenticates
 * `security set-key-partition-list -k` with the *p12 export* password instead.
 * `-k` takes the KEYCHAIN's own unlock password, so the argument is always
 * wrong. macOS <= 26.5.2 (build 25F84) did not validate it; macOS 26.6.2
 * (25G83) does, and the call dies with:
 *
 *   security: SecKeychainUnlock: The user name or passphrase you entered is not correct.
 *
 * Upstream fixed this in 27.0.0-alpha.8 (dist/codeSign/mac/macCodeSign.js) but
 * has NOT backported it to any published 26.x — 26.16.0 still ships the bug.
 * This script applies the identical three-line change to the installed 26.x.
 *
 * Idempotent, and a no-op when app-builder-lib isn't installed (the Docker /
 * gate legs run `npm ci --ignore-scripts` and never package).
 * Exits 1 if the code has moved, so a silent no-op is impossible.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const FILE = "node_modules/app-builder-lib/out/codeSign/macCodeSign.js";

/** Marker of the already-fixed form (upstream 27.x, or a previous run). */
export const FIXED_MARKER = '"-k", keychainPassword, keychainFile';

export const REPLACEMENTS = [
  [
    "return await importCerts(keychainFile, certPaths, cscPasswords);",
    "return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);",
  ],
  [
    "async function importCerts(keychainFile, paths, keyPasswords) {",
    "async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {",
  ],
  ['"-k", password, keychainFile]', '"-k", keychainPassword, keychainFile]'],
];

/**
 * Pure transform. Returns the patched source, or null when it is already fixed.
 * Throws — never silently returns the input — when an anchor is missing or
 * ambiguous, so a dependency bump that moves the code reddens the build instead
 * of shipping an unpatched (and therefore unsigned-or-failing) release.
 */
export function patchSource(source) {
  if (source.includes(FIXED_MARKER)) return null;
  let out = source;
  for (const [from, to] of REPLACEMENTS) {
    const hits = out.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `expected exactly 1 occurrence of anchor, found ${hits}:\n  ${from}\n` +
          "app-builder-lib has changed shape. Check whether the upstream fix has landed " +
          "(electron-userland/electron-builder — set-key-partition-list -k) and update or " +
          "delete this script.",
      );
    }
    out = out.replace(from, to);
  }
  return out;
}

function main() {
  if (!existsSync(FILE)) {
    console.log(`[patch-keychain] ${FILE} not present — nothing to patch.`);
    return;
  }
  const patched = patchSource(readFileSync(FILE, "utf8"));
  if (patched === null) {
    console.log("[patch-keychain] already fixed (upstream or previous run) — no-op.");
    return;
  }
  writeFileSync(FILE, patched);
  console.log("[patch-keychain] applied: set-key-partition-list now uses the keychain password.");
}

// Only run as a CLI, so the pure helpers stay unit-testable (mirrors audit-gate.mjs).
if (process.argv[1] && process.argv[1].endsWith("patch-app-builder-keychain.mjs")) {
  try {
    main();
  } catch (err) {
    console.error(`[patch-keychain] FAILED: ${err.message}`);
    process.exit(1);
  }
}

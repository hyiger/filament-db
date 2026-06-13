// Merge two single-arch electron-updater `latest-mac.yml` files (arm64 + x64)
// into ONE multi-arch `latest-mac.yml`.
//
// Why: electron-updater's MacUpdater filters the `files` array by the running
// arch — it keeps entries whose URL contains "arm64" on Apple Silicon (or under
// Rosetta) and the non-arm64 entries on Intel, then downloads the matching
// `.zip`. So a single yml that lists BOTH arches' zips makes the updater install
// the NATIVE build. Without this merge the two macOS release jobs each emit a
// `latest-mac.yml` and the later upload wins, serving one arch to every Mac —
// the macOS analogue of the Windows `latest.yml` collision fixed in GH #586.
//
// electron-updater also REQUIRES a `.zip` (it throws "ZIP file not provided"
// when only a `.dmg` is present), which is why the mac build target now emits
// both `dmg` + `zip`.
//
// Usage:
//   node scripts/merge-mac-latest-yml.mjs <arm64.yml> <x64.yml> > latest-mac.yml

import { readFileSync } from "node:fs";
// Use the `yaml` package — the same direct dependency the app already parses
// OpenPrintTag YAML with (src/lib/openprinttagBrowser.ts). electron-updater
// reads the file with its own parser, so any standards-compliant YAML is fine.
import { parse, stringify } from "yaml";

/**
 * Merge arm64 + x64 `latest-mac.yml` documents into one multi-arch document.
 *
 * - Combines the `files` arrays (x64 first, then arm64), deduped by `url`.
 * - Keeps `version` / `releaseDate` and bases the legacy top-level
 *   `path` / `sha512` / `size` on the x64 doc. electron-updater prefers the
 *   arch-filtered `files` array (getFileList returns it whenever it's
 *   non-empty), so the top-level fields are only a fallback for very old
 *   clients; x64 is the broadest-compatible default (runs on arm64 via Rosetta).
 *
 * @param {string} arm64Yml raw contents of the arm64 latest-mac.yml
 * @param {string} x64Yml   raw contents of the x64 latest-mac.yml
 * @returns {string} the merged multi-arch latest-mac.yml
 */
export function mergeMacLatestYml(arm64Yml, x64Yml) {
  const arm = parse(arm64Yml);
  const x64 = parse(x64Yml);
  if (arm == null || typeof arm !== "object") {
    throw new Error("arm64 latest-mac.yml is empty or not a mapping");
  }
  if (x64 == null || typeof x64 !== "object") {
    throw new Error("x64 latest-mac.yml is empty or not a mapping");
  }

  const seen = new Set();
  const files = [];
  for (const f of [...(x64.files ?? []), ...(arm.files ?? [])]) {
    if (f == null || typeof f.url !== "string") continue;
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    files.push(f);
  }
  if (files.length === 0) {
    throw new Error("no `files` entries found in either latest-mac.yml");
  }
  if (!files.some((f) => f.url.includes("arm64"))) {
    throw new Error("merged latest-mac.yml has no arm64 entry — arm64 Macs would get no native build");
  }
  if (!files.some((f) => !f.url.includes("arm64"))) {
    throw new Error("merged latest-mac.yml has no x64 entry — Intel Macs would get no native build");
  }

  // Base on the x64 document (its top-level path points at the x64 zip), then
  // replace `files` with the combined multi-arch list. lineWidth: 0 disables
  // line folding so base64 sha512 values are never wrapped.
  const merged = { ...x64, files };
  return stringify(merged, { lineWidth: 0 });
}

// CLI entry — guarded so importing this module (e.g. from tests) doesn't run it.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [armPath, x64Path] = process.argv.slice(2);
  if (!armPath || !x64Path) {
    console.error(
      "Usage: node scripts/merge-mac-latest-yml.mjs <arm64.yml> <x64.yml> > latest-mac.yml",
    );
    process.exit(1);
  }
  process.stdout.write(
    mergeMacLatestYml(readFileSync(armPath, "utf8"), readFileSync(x64Path, "utf8")),
  );
}

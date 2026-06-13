import { describe, expect, it } from "vitest";
import { parse } from "yaml";
// The merge logic ships as a CLI helper used by release.yml; import the pure
// function directly (the .mjs guards its CLI entry behind import.meta check).
import { mergeMacLatestYml } from "../scripts/merge-mac-latest-yml.mjs";

const ARM64_YML = `version: 1.41.0
files:
  - url: FilamentDB-1.41.0-mac-arm64.zip
    sha512: ARM64ZIPSHA512==
    size: 111
  - url: FilamentDB-1.41.0-mac-arm64.dmg
    sha512: ARM64DMGSHA512==
    size: 222
path: FilamentDB-1.41.0-mac-arm64.zip
sha512: ARM64ZIPSHA512==
releaseDate: '2026-06-13T00:00:00.000Z'
`;

const X64_YML = `version: 1.41.0
files:
  - url: FilamentDB-1.41.0-mac-x64.zip
    sha512: X64ZIPSHA512==
    size: 333
  - url: FilamentDB-1.41.0-mac-x64.dmg
    sha512: X64DMGSHA512==
    size: 444
path: FilamentDB-1.41.0-mac-x64.zip
sha512: X64ZIPSHA512==
releaseDate: '2026-06-13T00:00:00.000Z'
`;

interface MacYml {
  version: string;
  path: string;
  sha512: string;
  releaseDate: string;
  files: { url: string; sha512: string; size: number }[];
}

function parseYml(s: string): MacYml {
  return parse(s) as MacYml;
}

describe("mergeMacLatestYml", () => {
  it("combines both arches' files into one document", () => {
    const merged = parseYml(mergeMacLatestYml(ARM64_YML, X64_YML));
    const urls = merged.files.map((f) => f.url);
    expect(urls).toContain("FilamentDB-1.41.0-mac-arm64.zip");
    expect(urls).toContain("FilamentDB-1.41.0-mac-x64.zip");
    expect(urls).toContain("FilamentDB-1.41.0-mac-arm64.dmg");
    expect(urls).toContain("FilamentDB-1.41.0-mac-x64.dmg");
    expect(merged.files).toHaveLength(4);
    expect(merged.version).toBe("1.41.0");
  });

  it("preserves the arm64 substring electron-updater filters on", () => {
    const merged = parseYml(mergeMacLatestYml(ARM64_YML, X64_YML));
    // MacUpdater keeps files whose url contains "arm64" on Apple Silicon and the
    // rest on Intel. Both groups must be non-empty for native installs to work.
    expect(merged.files.some((f) => f.url.includes("arm64"))).toBe(true);
    expect(merged.files.some((f) => !f.url.includes("arm64"))).toBe(true);
  });

  it("preserves per-file checksums (no cross-arch corruption)", () => {
    const merged = parseYml(mergeMacLatestYml(ARM64_YML, X64_YML));
    const arm64Zip = merged.files.find((f) => f.url === "FilamentDB-1.41.0-mac-arm64.zip");
    const x64Zip = merged.files.find((f) => f.url === "FilamentDB-1.41.0-mac-x64.zip");
    expect(arm64Zip?.sha512).toBe("ARM64ZIPSHA512==");
    expect(x64Zip?.sha512).toBe("X64ZIPSHA512==");
  });

  it("bases the legacy top-level path on x64 (broadest compatibility)", () => {
    const merged = parseYml(mergeMacLatestYml(ARM64_YML, X64_YML));
    expect(merged.path).toBe("FilamentDB-1.41.0-mac-x64.zip");
    expect(merged.sha512).toBe("X64ZIPSHA512==");
  });

  it("dedupes by url if an entry appears in both inputs", () => {
    // Simulate an overlap (e.g. a universal artifact listed in both docs).
    const shared = `version: 1.41.0
files:
  - url: FilamentDB-1.41.0-mac-arm64.zip
    sha512: SHARED==
    size: 111
  - url: FilamentDB-1.41.0-mac-x64.zip
    sha512: X64==
    size: 333
path: FilamentDB-1.41.0-mac-x64.zip
sha512: X64==
releaseDate: '2026-06-13T00:00:00.000Z'
`;
    const merged = parseYml(mergeMacLatestYml(ARM64_YML, shared));
    const arm64ZipCount = merged.files.filter(
      (f) => f.url === "FilamentDB-1.41.0-mac-arm64.zip",
    ).length;
    expect(arm64ZipCount).toBe(1);
  });

  it("throws when an input is empty or not a mapping", () => {
    expect(() => mergeMacLatestYml("", X64_YML)).toThrow();
    expect(() => mergeMacLatestYml(ARM64_YML, "")).toThrow();
  });

  it("throws when one arch is missing entirely (would strand those Macs)", () => {
    const x64Only = `version: 1.41.0
files:
  - url: FilamentDB-1.41.0-mac-x64.zip
    sha512: X64==
    size: 333
path: FilamentDB-1.41.0-mac-x64.zip
sha512: X64==
releaseDate: '2026-06-13T00:00:00.000Z'
`;
    // Both inputs x64-only → no arm64 entry → throws rather than ship a yml
    // that strands Apple Silicon users.
    expect(() => mergeMacLatestYml(x64Only, x64Only)).toThrow(/arm64/);
  });
});

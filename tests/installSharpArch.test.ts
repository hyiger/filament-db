import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// Ships as a CLI invoked from release.yml's cross-build legs; import the pure
// helpers directly (the .mjs guards its CLI entry, like audit-gate.mjs).
import { parseArgs, packagesFor } from "../scripts/install-sharp-arch.mjs";

/**
 * GH #1195 — sharp resolves @img/sharp-<platform>-<arch> at require time and
 * throws if absent. The three cross-build legs would otherwise ship the
 * runner's arch inside the standalone tree, which resolves BEFORE the app's
 * root node_modules, leaving POST /api/labels/print dead on Intel macOS,
 * Windows arm64 and Linux arm64.
 */
const SHARP_PKG = JSON.parse(
  readFileSync("node_modules/sharp/package.json", "utf8"),
) as { version: string; optionalDependencies: Record<string, string> };

describe("parseArgs", () => {
  it("requires both platform and arch", () => {
    expect(() => parseArgs([])).toThrow(/--platform is required/);
    expect(() => parseArgs(["--platform", "darwin"])).toThrow(/--arch is required/);
  });

  it("defaults the destination to the standalone tree, not root node_modules", () => {
    // Patching root would be a NO-OP: Node resolves standalone/node_modules
    // first, so the traced wrong-arch copy would still win.
    expect(parseArgs(["--platform", "darwin", "--arch", "x64"]).dest).toBe(
      "standalone/node_modules",
    );
  });

  it("rejects an unknown flag rather than silently ignoring it", () => {
    // A typo'd flag that patched the wrong tree would exit 0 while proving
    // nothing — the same posture as parseAuditGateArgs.
    expect(() =>
      parseArgs(["--platform", "darwin", "--arch", "x64", "--dst", "x"]),
    ).toThrow(/Unknown argument/);
  });

  it("rejects a value-less flag", () => {
    expect(() => parseArgs(["--platform"])).toThrow(/requires a value/);
  });

  it("rejects a bogus platform or arch instead of fetching nothing", () => {
    expect(() => parseArgs(["--platform", "solaris", "--arch", "x64"])).toThrow(/Invalid --platform/);
    expect(() => parseArgs(["--platform", "darwin", "--arch", "sparc"])).toThrow(/Invalid --arch/);
  });
});

describe("packagesFor", () => {
  it("derives darwin's separate libvips package", () => {
    const names = packagesFor(SHARP_PKG, "darwin", "x64").map((p) => p.name).sort();
    expect(names).toEqual(["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"]);
  });

  it("derives linux's separate libvips package", () => {
    const names = packagesFor(SHARP_PKG, "linux", "arm64").map((p) => p.name).sort();
    expect(names).toEqual(["@img/sharp-libvips-linux-arm64", "@img/sharp-linux-arm64"]);
  });

  it("handles win32, which bundles libvips rather than splitting it", () => {
    // Hardcoding a two-package table would have failed here — the set is
    // genuinely platform-dependent, which is why it is derived.
    const names = packagesFor(SHARP_PKG, "win32", "arm64").map((p) => p.name);
    expect(names).toEqual(["@img/sharp-win32-arm64"]);
  });

  it("pins each package to the version sharp itself declares", () => {
    for (const { name, version } of packagesFor(SHARP_PKG, "darwin", "x64")) {
      expect(version).toBe(SHARP_PKG.optionalDependencies[name]);
      expect(version).toBeTruthy();
    }
  });

  it("throws for a target sharp does not publish, rather than installing nothing", () => {
    expect(() => packagesFor(SHARP_PKG, "darwin", "riscv64")).toThrow(/no optional dependency/);
  });

  it("covers every target the release workflow asks for", () => {
    // If a sharp upgrade ever drops one of these, this fails here rather than
    // in a release build.
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["win32", "arm64"],
      ["linux", "arm64"],
    ] as const) {
      expect(packagesFor(SHARP_PKG, platform, arch).length).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// Ships as a CLI invoked from release.yml's cross-build legs; import the pure
// helpers directly (the .mjs guards its CLI entry, like audit-gate.mjs).
import { createHash } from "node:crypto";
import {
  parseArgs,
  packagesFor,
  registryMetadataUrl,
  verifyIntegrity,
  DEFAULT_DESTS,
} from "../scripts/install-sharp-arch.mjs";

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

  it("defaults to BOTH the standalone tree and root node_modules", () => {
    // Verified against a real packaged build: electron-builder auto-inserts
    // "!**/node_modules/**" when its files list mentions node_modules and only
    // re-includes standalone/.next/node_modules, so standalone/node_modules is
    // STRIPPED from the package and the embedded server resolves sharp from
    // the app's ROOT node_modules. Patching only standalone was a silent
    // no-op in every shipped artifact; patching only root would break if the
    // packaging config ever re-included standalone, which Node resolves first.
    expect(parseArgs(["--platform", "darwin", "--arch", "x64"]).dests).toEqual([
      "standalone/node_modules",
      "node_modules",
    ]);
    expect(DEFAULT_DESTS).toContain("node_modules");
    expect(DEFAULT_DESTS).toContain("standalone/node_modules");
  });

  it("an explicit --dest overrides both defaults", () => {
    expect(parseArgs(["--platform", "darwin", "--arch", "x64", "--dest", "x"]).dests).toEqual(["x"]);
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

describe("registry fetch (GH #1195 — replaces the npm/cmd.exe path)", () => {
  // The script used to shell out to `npm pack`. On Windows npm is a batch
  // script Node cannot exec, and three attempts to work around that were all
  // wrong and none verifiable from here — a unit test over the argv cannot see
  // what Windows receives after Node's own quoting. Fetching from the registry
  // removes the shell entirely: same code path on every platform, and testable.
  describe("registryMetadataUrl", () => {
    it("percent-encodes the slash in a scoped name", () => {
      expect(registryMetadataUrl("@img/sharp-win32-arm64", "0.35.3")).toBe(
        "https://registry.npmjs.org/@img%2Fsharp-win32-arm64/0.35.3",
      );
    });

    it("handles an unscoped name", () => {
      expect(registryMetadataUrl("sharp", "0.35.3")).toBe(
        "https://registry.npmjs.org/sharp/0.35.3",
      );
    });

    it("encodes the version segment", () => {
      expect(registryMetadataUrl("x", "1.0.0-beta+1")).toContain("1.0.0-beta%2B1");
    });
  });

  describe("verifyIntegrity", () => {
    const body = Buffer.from("tarball bytes");
    const good = `sha512-${createHash("sha512").update(body).digest("base64")}`;

    it("accepts a matching digest", () => {
      expect(() => verifyIntegrity(body, good, "pkg")).not.toThrow();
    });

    it("rejects a corrupted or substituted tarball", () => {
      // The whole point: a silently wrong tarball would be unpacked into the
      // shipped app.
      expect(() => verifyIntegrity(Buffer.from("tampered"), good, "pkg")).toThrow(
        /integrity mismatch/,
      );
    });

    it("supports the other SRI algorithms the registry may return", () => {
      for (const algo of ["sha256", "sha384"] as const) {
        const d = `${algo}-${createHash(algo).update(body).digest("base64")}`;
        expect(() => verifyIntegrity(body, d, "pkg")).not.toThrow();
      }
    });

    it("refuses a missing or malformed digest rather than skipping the check", () => {
      // Treating an absent digest as "fine" would silently disable the guard.
      for (const bad of [undefined, null, "", "notadigest", 42]) {
        expect(() => verifyIntegrity(body, bad as never, "pkg")).toThrow(/integrity/);
      }
    });

    it("refuses an unknown algorithm", () => {
      expect(() => verifyIntegrity(body, "md5-abc", "pkg")).toThrow(/unsupported/);
    });

    it("names the package in the error so a CI failure is actionable", () => {
      expect(() => verifyIntegrity(body, "sha512-wrong", "@img/sharp-win32-arm64")).toThrow(
        /@img\/sharp-win32-arm64/,
      );
    });
  });
});

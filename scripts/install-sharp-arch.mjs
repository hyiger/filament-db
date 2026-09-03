#!/usr/bin/env node
/**
 * Install sharp's TARGET-architecture native packages into the Next standalone
 * tree, for cross-built release artifacts (GH #1195).
 *
 * WHY THIS EXISTS. `sharp` resolves `@img/sharp-<platform>-<arch>` at require
 * time and throws if the matching package is absent — there is no JS fallback
 * in a packaged build. Three release legs cross-build (mac-x64-cross on an
 * arm64 runner, win-arm64-cross on x64, linux-arm64 on x64) with
 * `npmRebuild: false`, so they package the RUNNER's binaries. Since a route
 * now imports sharp, Next's tracing copies it into `.next/standalone/
 * node_modules/`, and `electron:fixlinks` copies that to `standalone/`, which
 * electron-builder ships. Node resolves `standalone/node_modules` BEFORE the
 * app's root `node_modules`, so patching root alone is a no-op — the traced,
 * wrong-arch copy wins. This patches the tree that actually ships.
 *
 * WHY NOT `npm install --os --cpu` BEFORE THE BUILD. Those flags re-resolve
 * EVERY optional dependency, not just sharp's — verified: it swaps
 * lightningcss / @tailwindcss/oxide / @rolldown/binding to the target arch too,
 * and `npm run build` then dies with "Cannot find module
 * '../lightningcss.darwin-arm64.node'". This script touches only sharp's own
 * packages, after the build, so the host toolchain is untouched.
 *
 * USAGE
 *   node scripts/install-sharp-arch.mjs --platform darwin --arch x64
 *   node scripts/install-sharp-arch.mjs --platform win32  --arch arm64 --dest standalone/node_modules
 *
 * Exits non-zero on any failure — a silently wrong-arch artifact is exactly
 * the outcome this guards against.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Fetch a package tarball straight from the npm registry.
 *
 * WHY NOT `npm pack`. The original version shelled out to npm, which on
 * Windows is a BATCH SCRIPT that Node cannot execute without a command
 * interpreter. Three successive attempts to get that right — npm.cmd, then
 * cmd.exe with hand-quoted arguments — were all wrong, and none of them was
 * verifiable here: this script cannot be run on Windows from a development
 * host or from the root test suite, and a unit test over the pre-serialization
 * argv cannot see what Windows actually receives after Node's own quoting
 * (GH #1195 review, rounds 10-12).
 *
 * So the untestable surface is gone rather than iterated on. A direct HTTPS
 * fetch has no shell, no batch file and no argument serialization, runs the
 * SAME code path on every platform, and is exercised end to end from macOS
 * against the real Windows-arm64 package. It also skips npm's os/cpu
 * suitability check for free — the original reason `npm pack` was chosen over
 * `npm install` — and lets us verify the registry's own integrity digest,
 * which `npm pack` never gave us.
 */

/** Registry metadata URL for one exact version. Scoped names need the slash
 *  percent-encoded; the version segment is a literal version, not a range
 *  (sharp pins its optionalDependencies exactly). */
export function registryMetadataUrl(name, version) {
  return `https://registry.npmjs.org/${name.replace("/", "%2F")}/${encodeURIComponent(version)}`;
}

/**
 * Verify a downloaded tarball against the registry's Subresource-Integrity
 * digest. A silently corrupted or substituted tarball would otherwise be
 * unpacked into the shipped app.
 */
export function verifyIntegrity(buffer, integrity, label) {
  if (typeof integrity !== "string" || !integrity.includes("-")) {
    throw new Error(`${label}: registry returned no usable integrity digest`);
  }
  const [algorithm, expected] = [
    integrity.slice(0, integrity.indexOf("-")),
    integrity.slice(integrity.indexOf("-") + 1),
  ];
  if (!["sha512", "sha384", "sha256"].includes(algorithm)) {
    throw new Error(`${label}: unsupported integrity algorithm "${algorithm}"`);
  }
  const actual = createHash(algorithm).update(buffer).digest("base64");
  if (actual !== expected) {
    throw new Error(
      `${label}: integrity mismatch — expected ${algorithm}-${expected}, got ${algorithm}-${actual}`,
    );
  }
}

async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: registry responded ${res.status} for ${url}`);
  return res.json();
}

/** Download one package tarball into `destDir`, integrity-checked. */
async function downloadTarball(name, version, destDir) {
  const label = `${name}@${version}`;
  const meta = await fetchJson(registryMetadataUrl(name, version), label);
  const dist = meta && meta.dist;
  if (!dist || typeof dist.tarball !== "string") {
    throw new Error(`${label}: registry metadata has no dist.tarball`);
  }
  const res = await fetch(dist.tarball);
  if (!res.ok) throw new Error(`${label}: tarball responded ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  verifyIntegrity(buffer, dist.integrity, label);
  const file = join(destDir, `${name.replace("/", "-").replace("@", "")}-${version}.tgz`);
  writeFileSync(file, buffer);
  return file;
}

const VALID_PLATFORMS = ["darwin", "win32", "linux", "linuxmusl"];
const VALID_ARCHES = ["x64", "arm64", "arm", "s390x", "ppc64", "riscv64"];

export function parseArgs(argv) {
  const out = { dest: "standalone/node_modules" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--platform": out.platform = next(); break;
      case "--arch": out.arch = next(); break;
      case "--dest": out.dest = next(); break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!out.platform) throw new Error("--platform is required");
  if (!out.arch) throw new Error("--arch is required");
  if (!VALID_PLATFORMS.includes(out.platform)) {
    throw new Error(`Invalid --platform "${out.platform}" (expected one of ${VALID_PLATFORMS.join(", ")})`);
  }
  if (!VALID_ARCHES.includes(out.arch)) {
    throw new Error(`Invalid --arch "${out.arch}" (expected one of ${VALID_ARCHES.join(", ")})`);
  }
  return out;
}

/**
 * The @img packages sharp needs for one target, derived from sharp's OWN
 * optionalDependencies rather than a hardcoded table — the set differs by
 * platform (darwin/linux carry a separate libvips package; win32 bundles it)
 * and would silently rot on a sharp upgrade.
 */
export function packagesFor(sharpPkg, platform, arch) {
  const suffix = `-${platform}-${arch}`;
  const names = Object.keys(sharpPkg.optionalDependencies ?? {}).filter((n) => n.endsWith(suffix));
  if (names.length === 0) {
    throw new Error(
      `sharp ${sharpPkg.version} declares no optional dependency for ${platform}-${arch}. ` +
        `Known targets: ${Object.keys(sharpPkg.optionalDependencies ?? {}).join(", ")}`,
    );
  }
  return names.map((name) => ({ name, version: sharpPkg.optionalDependencies[name] }));
}

async function main() {
  const { platform, arch, dest } = parseArgs(process.argv.slice(2));
  const sharpPkgPath = resolve("node_modules/sharp/package.json");
  if (!existsSync(sharpPkgPath)) {
    throw new Error("node_modules/sharp not found — run npm ci first.");
  }
  const sharpPkg = JSON.parse(readFileSync(sharpPkgPath, "utf8"));
  const destDir = resolve(dest, "@img");

  // The standalone tree must already exist; if it does not, the build/fixlinks
  // step has not run and patching it would create a directory the packager
  // then ships as the ONLY sharp copy, which is worse than failing.
  const destRoot = resolve(dest);
  if (!existsSync(destRoot)) {
    throw new Error(
      `Destination "${dest}" does not exist. Run \`npm run build && npm run electron:fixlinks\` first.`,
    );
  }

  const wanted = packagesFor(sharpPkg, platform, arch);
  console.log(`sharp ${sharpPkg.version} → ${platform}-${arch}: ${wanted.map((w) => w.name).join(", ")}`);

  const staging = mkdtempSync(join(tmpdir(), "sharp-arch-"));
  try {
    mkdirSync(destDir, { recursive: true });
    for (const { name, version } of wanted) {
      const tarPath = await downloadTarball(name, version, staging);
      const unpacked = join(staging, name.replace("/", "__"));
      mkdirSync(unpacked, { recursive: true });
      execFileSync("tar", ["-xzf", tarPath, "-C", unpacked, "--strip-components", "1"]);

      const target = join(destDir, name.split("/")[1]);
      rmSync(target, { recursive: true, force: true });
      cpSync(unpacked, target, { recursive: true });

      // Prove a native artifact actually landed. A tarball that extracted to
      // metadata only would otherwise pass silently and fail at runtime on a
      // user's machine.
      const hasBinary = (function find(dir) {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) { if (find(p)) return true; }
          else if (/\.(node|dll|so(\.\d+)*|dylib)$/.test(e.name)) return true;
        }
        return false;
      })(target);
      if (!hasBinary) {
        throw new Error(`${name} unpacked to ${target} but contains no native binary`);
      }
      console.log(`  installed ${name}@${version}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  console.log(`@img now in ${dest}: ${readdirSync(destDir).join(", ")}`);
}

// Only run when invoked directly, so the pure helpers stay unit-testable.
if (process.argv[1] && process.argv[1].endsWith("install-sharp-arch.mjs")) {
  try {
    await main();
  } catch (err) {
    console.error(`::error::install-sharp-arch: ${err.message}`);
    process.exit(1);
  }
}

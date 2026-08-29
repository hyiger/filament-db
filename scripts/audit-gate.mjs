/**
 * CI audit gate: `npm audit --audit-level=moderate` with a reviewed allowlist.
 *
 * npm audit has no native exception mechanism, so an UNFIXABLE advisory (e.g.
 * immutable pinned to ^3.x by swagger-ui-react, no upstream fix) would fail
 * every CI run forever. This wrapper fails on any advisory >= moderate whose
 * (GHSA id, package) pair is NOT in `.audit-allowlist.json`, and prints
 * allowlisted ones as warnings (plus a nudge when an entry is past its
 * reviewBy date — a warning, never a failure, so releases can't be broken by
 * a calendar).
 *
 * Used by BOTH .github/workflows/test.yml and ci-gate.yml (the two copies of
 * the gate that must stay in sync — see the cross-reference comments there),
 * and by mobile.yml for packages/mobile, which vendors its own lockfile and
 * therefore its own allowlist:
 *
 *   node scripts/audit-gate.mjs                                # repo root
 *   node scripts/audit-gate.mjs --dir packages/mobile --omit-dev
 *
 * The pure helpers are exported for tests (tests/auditGate.test.ts).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEVERITIES = ["moderate", "high", "critical"];

/**
 * The allowlist Map key: the (GHSA id, package) COMPOUND pair. A single GHSA
 * can cover multiple npm packages (#1023), and the justification/
 * exposure analysis in an allowlist entry applies to one specific package
 * only — so the same GHSA may legitimately need one entry PER package.
 * GH #1082: keying the Map on the id alone made two such entries collide
 * (last one wins), so the advisory on the first package failed the gate even
 * though its valid, justified entry was right there in the file.
 *
 * A GHSA id can't contain a space (validated as /^GHSA-[a-z0-9-]+$/ below),
 * so `id + " " + package` is unambiguous.
 */
export function allowlistKey(id, pkg) {
  return `${id} ${pkg}`;
}

/**
 * #1023: enforce the allowlist's stated MUSTs before any entry
 * can activate an exception — otherwise an entry missing its justification or
 * carrying an invalid reviewBy date silently becomes a PERMANENT exception
 * (an invalid date never compares as past, so the expiry nudge never fires).
 *
 * GH #1082: also reject a duplicate (id, package) pair. The Map below keys on
 * that pair, so a duplicate would silently shadow the earlier entry — a
 * genuinely redundant double entry fails closed with a message naming it,
 * consistent with the rest of this validation.
 *
 * Returns the list of validation errors (empty = valid). `label` names the
 * file in each message — the audited package's own path when --dir is used,
 * so a mobile failure doesn't point at the root allowlist.
 */
export function validateAllowlistEntries(allowlist, label = ".audit-allowlist.json") {
  const entryErrors = [];
  const seenPairs = new Set();
  for (const [i, a] of (Array.isArray(allowlist.allow) ? allowlist.allow : []).entries()) {
    const where = `${label} allow[${i}]`;
    if (typeof a.id !== "string" || !/^GHSA-[a-z0-9-]+$/.test(a.id))
      entryErrors.push(`${where}: missing/invalid GHSA id`);
    if (typeof a.package !== "string" || a.package.trim() === "")
      entryErrors.push(`${where}: missing package`);
    if (typeof a.justification !== "string" || a.justification.trim().length < 20)
      entryErrors.push(`${where}: justification is required (a real sentence, not a stub)`);
    if (typeof a.reviewBy !== "string" || Number.isNaN(new Date(a.reviewBy).getTime()))
      entryErrors.push(`${where}: reviewBy must be a valid date`);
    if (typeof a.id === "string" && typeof a.package === "string") {
      const key = allowlistKey(a.id, a.package);
      if (seenPairs.has(key))
        entryErrors.push(
          `${where}: duplicate entry for ${a.id} + ${a.package} — remove the redundant one`,
        );
      else seenPairs.add(key);
    }
  }
  if (!Array.isArray(allowlist.allow))
    entryErrors.push(`${label}: \`allow\` must be an array`);
  return entryErrors;
}

/**
 * Parse the CLI flags.
 *
 *   --dir <path>  audit this package directory instead of the repo root,
 *                 reading ITS .audit-allowlist.json (resolved against cwd)
 *   --omit-dev    pass --omit=dev to npm audit (production deps only)
 *
 * Defaults reproduce the historical invocation exactly — no flags audits the
 * repo root against the root allowlist, independent of cwd — so the two
 * root-gate copies are unaffected.
 *
 * Anything unrecognized or malformed THROWS instead of being ignored: a gate
 * that silently audited the wrong tree (or the whole dev tree) because a flag
 * was typo'd would still exit 0 while proving nothing.
 */
export function parseAuditGateArgs(argv) {
  const opts = { dir: null, omitDev: false };
  const setDir = (value) => {
    if (typeof value !== "string" || value === "" || value.startsWith("--"))
      throw new Error("--dir requires a directory path");
    opts.dir = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--omit-dev") opts.omitDev = true;
    else if (arg === "--dir") setDir(argv[++i]);
    else if (arg.startsWith("--dir=")) setDir(arg.slice("--dir=".length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** Build the exception lookup, keyed on the (GHSA id, package) pair. */
export function buildAllowlistMap(allow) {
  return new Map(allow.map((a) => [allowlistKey(a.id, a.package), a]));
}

/**
 * Classify every moderate+ advisory in an npm-audit `vulnerabilities` report
 * against the allowlist Map. Returns { offenders, tolerated } — offenders are
 * human-readable labels; tolerated carry the matched entry for the reviewBy
 * nudge.
 */
export function classifyAdvisories(vulnerabilities, allowed) {
  const offenders = [];
  const tolerated = [];
  for (const [name, vuln] of Object.entries(vulnerabilities)) {
    // `via` mixes advisory objects (this package's own advisories) and strings
    // (names of vulnerable dependencies — those packages carry their own
    // entries in the report, so a pure pass-through parent has no advisory
    // objects of its own and is judged by its children's entries).
    const advisories = (vuln.via ?? []).filter((v) => typeof v === "object" && v !== null);
    for (const adv of advisories) {
      // #1023: judge each advisory by ITS OWN severity, not the
      // package's aggregate (`vuln.severity` is the max across advisories, and
      // --audit-level does not filter the report) — otherwise a below-threshold
      // advisory on a package that also carries an allowlisted high one would
      // be misread at the aggregate severity and block the gate.
      if (!SEVERITIES.includes(adv.severity)) continue;
      const id = (adv.url ?? "").split("/").pop() ?? "";
      const label = `${name} [${adv.severity}] ${id}: ${adv.title}`;
      // The exception binds to the reviewed PACKAGE too —
      // the compound Map key enforces the pair match by construction.
      const entry = allowed.get(allowlistKey(id, name));
      if (entry) tolerated.push({ label, entry });
      else offenders.push(label);
    }
  }
  return { offenders, tolerated };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  let args;
  try {
    args = parseAuditGateArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`audit-gate: ${err.message}`);
    console.error("usage: node scripts/audit-gate.mjs [--dir <package-dir>] [--omit-dev]");
    process.exit(1);
  }

  // The audited tree and its allowlist travel together: a package that vendors
  // its own lockfile owns its own exceptions, and its justifications describe
  // ITS exposure. Never let one tree be audited against another's allowlist.
  const target = args.dir ? resolve(process.cwd(), args.dir) : root;
  const allowlistPath = join(target, ".audit-allowlist.json");
  // Repo-relative when it is inside the repo, absolute otherwise — a label
  // like "../../../../tmp/.audit-allowlist.json" helps nobody.
  const relLabel = relative(root, allowlistPath);
  const allowlistLabel = relLabel && !relLabel.startsWith("..") ? relLabel : allowlistPath;

  let allowlist;
  try {
    allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
  } catch (err) {
    console.error(`Could not read ${allowlistLabel} — failing closed: ${err.message}`);
    process.exit(1);
  }

  const entryErrors = validateAllowlistEntries(allowlist, allowlistLabel);
  if (entryErrors.length > 0) {
    console.error(`${allowlistLabel} is malformed — failing closed:`);
    for (const e of entryErrors) console.error("  " + e);
    process.exit(1);
  }
  const allowed = buildAllowlistMap(allowlist.allow);

  // npm audit exits non-zero when it finds anything — capture stdout regardless.
  let raw;
  try {
    const npmArgs = ["audit", "--json", "--audit-level=moderate"];
    if (args.omitDev) npmArgs.push("--omit=dev");
    raw = execFileSync("npm", npmArgs, {
      cwd: target,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (!err.stdout) {
      console.error("npm audit produced no output:", err.message);
      process.exit(1);
    }
    raw = err.stdout;
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    console.error("npm audit output was not JSON:\n" + raw.slice(0, 2000));
    process.exit(1);
  }

  // #1023: fail CLOSED on an audit-service error. When the registry
  // audit endpoint errors (403, outage), npm exits nonzero but still writes a
  // valid JSON *error object* to stdout — no `vulnerabilities` key at all. The
  // old `report.vulnerabilities ?? {}` default read that as "no advisories" and
  // printed a pass, silently skipping the security gate in both release
  // workflows. Reject error-shaped output and require the real report shape.
  if (report.error || report.statusCode) {
    console.error(
      "npm audit returned an error response — failing closed:\n" +
        JSON.stringify(report.error ?? report, null, 2).slice(0, 2000),
    );
    process.exit(1);
  }
  if (typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    console.error(
      "npm audit output missing the `vulnerabilities` report shape — failing closed:\n" +
        raw.slice(0, 2000),
    );
    process.exit(1);
  }

  const { offenders, tolerated } = classifyAdvisories(report.vulnerabilities, allowed);

  for (const { label, entry } of tolerated) {
    console.warn(`ALLOWLISTED: ${label}`);
    if (entry.reviewBy && new Date(entry.reviewBy) < new Date()) {
      console.warn(
        `  ⚠ past its reviewBy (${entry.reviewBy}) — re-check upstream for a fix and update ${allowlistLabel}`,
      );
    }
  }

  if (offenders.length > 0) {
    console.error(`\nAudit gate FAILED — advisories not in ${allowlistLabel}:`);
    for (const o of offenders) console.error("  " + o);
    process.exit(1);
  }

  console.log(
    `Audit gate passed (${tolerated.length} allowlisted advisor${tolerated.length === 1 ? "y" : "ies"} tolerated).`,
  );
}

// CLI entry — guarded so importing this module (e.g. from tests) doesn't run it.
// Compare via pathToFileURL, not `file://${argv[1]}` string-building: a security gate
// must not fail OPEN (exit 0, no output) just because the invocation path needs URL
// encoding (spaces, Windows separators) or came through a symlink Node realpathed.
const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    // Accept both the as-invoked path and its realpath — Node's treatment of a
    // symlinked entry differs by loader, and either shape must still run the gate.
    return (
      import.meta.url === pathToFileURL(process.argv[1]).href ||
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();
if (invokedAsCli) {
  main();
}

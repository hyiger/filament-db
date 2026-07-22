/**
 * CI audit gate: `npm audit --audit-level=moderate` with a reviewed allowlist.
 *
 * npm audit has no native exception mechanism, so an UNFIXABLE advisory (e.g.
 * immutable pinned to ^3.x by swagger-ui-react, no upstream fix) would fail
 * every CI run forever. This wrapper fails on any advisory >= moderate whose
 * GHSA id is NOT in `.audit-allowlist.json`, and prints allowlisted ones as
 * warnings (plus a nudge when an entry is past its reviewBy date — a warning,
 * never a failure, so releases can't be broken by a calendar).
 *
 * Used by BOTH .github/workflows/test.yml and ci-gate.yml (the two copies of
 * the gate that must stay in sync — see the cross-reference comments there).
 * Run locally: `node scripts/audit-gate.mjs`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEVERITIES = ["moderate", "high", "critical"];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const allowlist = JSON.parse(readFileSync(join(root, ".audit-allowlist.json"), "utf8"));

// Codex P2 on #1023: enforce the allowlist's stated MUSTs before any entry can
// activate an exception — otherwise an entry missing its justification or
// carrying an invalid reviewBy date silently becomes a PERMANENT exception
// (an invalid date never compares as past, so the expiry nudge never fires).
const entryErrors = [];
for (const [i, a] of (Array.isArray(allowlist.allow) ? allowlist.allow : []).entries()) {
  const where = `.audit-allowlist.json allow[${i}]`;
  if (typeof a.id !== "string" || !/^GHSA-[a-z0-9-]+$/.test(a.id))
    entryErrors.push(`${where}: missing/invalid GHSA id`);
  if (typeof a.package !== "string" || a.package.trim() === "")
    entryErrors.push(`${where}: missing package`);
  if (typeof a.justification !== "string" || a.justification.trim().length < 20)
    entryErrors.push(`${where}: justification is required (a real sentence, not a stub)`);
  if (typeof a.reviewBy !== "string" || Number.isNaN(new Date(a.reviewBy).getTime()))
    entryErrors.push(`${where}: reviewBy must be a valid date`);
}
if (!Array.isArray(allowlist.allow)) entryErrors.push(".audit-allowlist.json: `allow` must be an array");
if (entryErrors.length > 0) {
  console.error("Audit allowlist is malformed — failing closed:");
  for (const e of entryErrors) console.error("  " + e);
  process.exit(1);
}
const allowed = new Map(allowlist.allow.map((a) => [a.id, a]));

// npm audit exits non-zero when it finds anything — capture stdout regardless.
let raw;
try {
  raw = execFileSync("npm", ["audit", "--json", "--audit-level=moderate"], {
    cwd: root,
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

// Codex P1 on #1023: fail CLOSED on an audit-service error. When the registry
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

const offenders = [];
const tolerated = [];
for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
  // `via` mixes advisory objects (this package's own advisories) and strings
  // (names of vulnerable dependencies — those packages carry their own
  // entries in the report, so a pure pass-through parent has no advisory
  // objects of its own and is judged by its children's entries).
  const advisories = (vuln.via ?? []).filter((v) => typeof v === "object" && v !== null);
  for (const adv of advisories) {
    // Codex P2 on #1023: judge each advisory by ITS OWN severity, not the
    // package's aggregate (`vuln.severity` is the max across advisories, and
    // --audit-level does not filter the report) — otherwise a below-threshold
    // advisory on a package that also carries an allowlisted high one would
    // be misread at the aggregate severity and block the gate.
    if (!SEVERITIES.includes(adv.severity)) continue;
    const id = (adv.url ?? "").split("/").pop() ?? "";
    const label = `${name} [${adv.severity}] ${id}: ${adv.title}`;
    const entry = allowed.get(id);
    // Codex P2 on #1023: bind the exception to the reviewed PACKAGE too — a
    // GHSA can cover multiple npm packages, and the justification/exposure
    // analysis in the allowlist applies to one specific package only.
    if (entry && entry.package === name) tolerated.push({ label, entry });
    else offenders.push(label);
  }
}

for (const { label, entry } of tolerated) {
  console.warn(`ALLOWLISTED: ${label}`);
  if (entry.reviewBy && new Date(entry.reviewBy) < new Date()) {
    console.warn(
      `  ⚠ past its reviewBy (${entry.reviewBy}) — re-check upstream for a fix and update .audit-allowlist.json`,
    );
  }
}

if (offenders.length > 0) {
  console.error("\nAudit gate FAILED — advisories not in .audit-allowlist.json:");
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}

console.log(
  `Audit gate passed (${tolerated.length} allowlisted advisor${tolerated.length === 1 ? "y" : "ies"} tolerated).`,
);

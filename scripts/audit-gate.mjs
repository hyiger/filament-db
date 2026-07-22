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

const offenders = [];
const tolerated = [];
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (!SEVERITIES.includes(vuln.severity)) continue;
  // `via` mixes advisory objects (this package's own advisories) and strings
  // (names of vulnerable dependencies — those packages carry their own
  // entries in the report, so a pure pass-through parent has no advisory
  // objects of its own and is judged by its children's entries).
  const advisories = (vuln.via ?? []).filter((v) => typeof v === "object" && v !== null);
  for (const adv of advisories) {
    const id = (adv.url ?? "").split("/").pop() ?? "";
    const label = `${name} [${vuln.severity}] ${id}: ${adv.title}`;
    if (allowed.has(id)) tolerated.push({ label, entry: allowed.get(id) });
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

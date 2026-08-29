import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The audit gate ships as a CLI used by ci-gate.yml + test.yml (root) and
// mobile.yml (packages/mobile); import the pure helpers directly (the .mjs
// guards its CLI entry behind an import.meta check, mirroring
// scripts/merge-mac-latest-yml.mjs).
import {
  allowlistKey,
  buildAllowlistMap,
  classifyAdvisories,
  parseAuditGateArgs,
  validateAllowlistEntries,
} from "../scripts/audit-gate.mjs";

const GHSA_A = "GHSA-aaaa-bbbb-cccc";
const GHSA_B = "GHSA-dddd-eeee-ffff";

interface AllowEntry {
  id?: unknown;
  package?: unknown;
  justification?: unknown;
  reviewBy?: unknown;
}

function entry(overrides: AllowEntry = {}): AllowEntry {
  return {
    id: GHSA_A,
    package: "left-pad",
    justification: "No upstream fix exists; the vulnerable path is never reachable here.",
    reviewBy: "2027-01-01",
    ...overrides,
  };
}

/** One npm-audit `vulnerabilities` row with a single advisory object in via[]. */
function vulnRow(severity: string, ghsaId: string, title = "Something bad") {
  return {
    severity,
    via: [{ severity, url: `https://github.com/advisories/${ghsaId}`, title }],
  };
}

describe("audit-gate validateAllowlistEntries", () => {
  it("accepts a fully-specified entry", () => {
    expect(validateAllowlistEntries({ allow: [entry()] })).toEqual([]);
  });

  it("accepts TWO entries for the same GHSA on different packages (the multi-package case)", () => {
    // GH #1082: this is the legitimate shape the compound key exists for — a
    // single GHSA covering two npm packages, each with its own justification.
    const errors = validateAllowlistEntries({
      allow: [entry({ package: "pkg-a" }), entry({ package: "pkg-b" })],
    });
    expect(errors).toEqual([]);
  });

  it("rejects a duplicate (id, package) pair with a message naming it", () => {
    const errors = validateAllowlistEntries({ allow: [entry(), entry()] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("allow[1]");
    expect(errors[0]).toContain(GHSA_A);
    expect(errors[0]).toContain("left-pad");
    expect(errors[0]).toContain("duplicate");
  });

  it("same package under a DIFFERENT GHSA is not a duplicate", () => {
    const errors = validateAllowlistEntries({
      allow: [entry(), entry({ id: GHSA_B })],
    });
    expect(errors).toEqual([]);
  });

  it("rejects a missing/invalid GHSA id", () => {
    expect(validateAllowlistEntries({ allow: [entry({ id: "CVE-2024-1234" })] })).toEqual([
      ".audit-allowlist.json allow[0]: missing/invalid GHSA id",
    ]);
    expect(validateAllowlistEntries({ allow: [entry({ id: 42 })] })).toEqual([
      ".audit-allowlist.json allow[0]: missing/invalid GHSA id",
    ]);
  });

  it("rejects a missing/blank package", () => {
    const errors = validateAllowlistEntries({ allow: [entry({ package: "  " })] });
    expect(errors).toEqual([".audit-allowlist.json allow[0]: missing package"]);
  });

  it("rejects a stub justification (under 20 trimmed chars)", () => {
    const errors = validateAllowlistEntries({ allow: [entry({ justification: "reviewed  " })] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("justification");
  });

  it("rejects an unparseable reviewBy date", () => {
    const errors = validateAllowlistEntries({ allow: [entry({ reviewBy: "not-a-date" })] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("reviewBy");
  });

  it("a non-string id/package entry still gets its shape errors without crashing the duplicate check", () => {
    const errors = validateAllowlistEntries({
      allow: [entry({ id: 42, package: null })],
    });
    expect(errors).toContain(".audit-allowlist.json allow[0]: missing/invalid GHSA id");
    expect(errors).toContain(".audit-allowlist.json allow[0]: missing package");
  });

  it("rejects a non-array `allow`", () => {
    expect(validateAllowlistEntries({ allow: "nope" })).toEqual([
      ".audit-allowlist.json: `allow` must be an array",
    ]);
  });
});

describe("audit-gate classifyAdvisories", () => {
  it("tolerates BOTH packages when one GHSA covers two and both are allowlisted (GH #1082 regression)", () => {
    // Pre-fix, the Map was keyed on the GHSA id alone, so these two entries
    // collided and only the last survived — pkg-a's advisory then failed the
    // gate despite its valid entry.
    const allowed = buildAllowlistMap([
      entry({ package: "pkg-a" }),
      entry({ package: "pkg-b" }),
    ]);
    const { offenders, tolerated } = classifyAdvisories(
      { "pkg-a": vulnRow("high", GHSA_A), "pkg-b": vulnRow("high", GHSA_A) },
      allowed,
    );
    expect(offenders).toEqual([]);
    expect(tolerated).toHaveLength(2);
    const labels = tolerated.map((t: { label: string }) => t.label);
    expect(labels.some((l: string) => l.startsWith("pkg-a "))).toBe(true);
    expect(labels.some((l: string) => l.startsWith("pkg-b "))).toBe(true);
  });

  it("an entry binds to its package only — the same GHSA on another package still offends", () => {
    const allowed = buildAllowlistMap([entry({ package: "pkg-a" })]);
    const { offenders, tolerated } = classifyAdvisories(
      { "pkg-a": vulnRow("high", GHSA_A), "pkg-b": vulnRow("high", GHSA_A) },
      allowed,
    );
    expect(tolerated).toHaveLength(1);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("pkg-b");
    expect(offenders[0]).toContain(GHSA_A);
  });

  it("flags a moderate+ advisory with no allowlist entry as an offender", () => {
    const { offenders, tolerated } = classifyAdvisories(
      { "left-pad": vulnRow("moderate", GHSA_B, "Regex DoS") },
      buildAllowlistMap([]),
    );
    expect(tolerated).toEqual([]);
    expect(offenders).toEqual([`left-pad [moderate] ${GHSA_B}: Regex DoS`]);
  });

  it("judges each advisory by its OWN severity — a low advisory never reaches the gate", () => {
    const { offenders, tolerated } = classifyAdvisories(
      { "left-pad": vulnRow("low", GHSA_A) },
      buildAllowlistMap([]),
    );
    expect(offenders).toEqual([]);
    expect(tolerated).toEqual([]);
  });

  it("ignores string via entries (pass-through parents) and a missing via", () => {
    const { offenders, tolerated } = classifyAdvisories(
      {
        parent: { severity: "high", via: ["left-pad"] },
        legacy: { severity: "high" },
      },
      buildAllowlistMap([]),
    );
    expect(offenders).toEqual([]);
    expect(tolerated).toEqual([]);
  });

  it("an advisory without a url yields an empty id and cannot match any entry", () => {
    const { offenders } = classifyAdvisories(
      { "left-pad": { severity: "high", via: [{ severity: "high", title: "No url" }] } },
      buildAllowlistMap([entry({ package: "left-pad" })]),
    );
    expect(offenders).toEqual(["left-pad [high] : No url"]);
  });
});

describe("audit-gate allowlistKey", () => {
  it("is unambiguous because a GHSA id cannot contain a space", () => {
    expect(allowlistKey(GHSA_A, "pkg with spaces")).toBe(`${GHSA_A} pkg with spaces`);
    expect(allowlistKey(GHSA_A, "pkg-a")).not.toBe(allowlistKey(GHSA_A, "pkg-b"));
    expect(allowlistKey(GHSA_A, "pkg-a")).not.toBe(allowlistKey(GHSA_B, "pkg-a"));
  });
});

describe("audit-gate parseAuditGateArgs", () => {
  it("defaults to the repo root and the full dependency tree", () => {
    expect(parseAuditGateArgs([])).toEqual({ dir: null, omitDev: false });
  });

  it("accepts --dir in both spellings, plus --omit-dev", () => {
    expect(parseAuditGateArgs(["--dir", "packages/mobile", "--omit-dev"])).toEqual({
      dir: "packages/mobile",
      omitDev: true,
    });
    expect(parseAuditGateArgs(["--dir=packages/mobile"])).toEqual({
      dir: "packages/mobile",
      omitDev: false,
    });
  });

  // A gate that shrugged off a typo'd flag would audit the WRONG tree (or the
  // whole dev tree) and still exit 0 — proving nothing while looking green.
  it("throws on an unknown flag rather than ignoring it", () => {
    expect(() => parseAuditGateArgs(["--omit-dev-typo"])).toThrow(/unknown argument/);
    expect(() => parseAuditGateArgs(["packages/mobile"])).toThrow(/unknown argument/);
  });

  it("throws when --dir has no value, including when the next token is a flag", () => {
    expect(() => parseAuditGateArgs(["--dir"])).toThrow(/--dir requires/);
    expect(() => parseAuditGateArgs(["--dir", "--omit-dev"])).toThrow(/--dir requires/);
    expect(() => parseAuditGateArgs(["--dir="])).toThrow(/--dir requires/);
  });
});

describe("the committed allowlists", () => {
  // Both files are validated at gate time, but the mobile gate is path-filtered
  // and does NOT run on most PRs — so a malformed mobile allowlist would sit
  // undetected until someone touched packages/mobile. This suite always runs.
  it.each([
    [".audit-allowlist.json"],
    ["packages/mobile/.audit-allowlist.json"],
  ])("%s passes the gate's own validation", (path) => {
    const allowlist = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
    expect(validateAllowlistEntries(allowlist, path)).toEqual([]);
  });
});

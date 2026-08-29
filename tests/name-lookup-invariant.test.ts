import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * GH #1116 — the drift guard for the survivor-fallback rule.
 *
 * ## Why this test exists
 *
 * A Mongoose String setter applies to QUERY values, so once `name` carries
 * `trim: true` no name-filtered query can select a row whose STORED name is
 * still raw. `trimEntityNames` repairs stored rows but can legitimately leave
 * survivors behind (a skipped collection, a colliding row).
 *
 * Every "resolve by name, then create when missing" path therefore needs the
 * `src/lib/trimmedNameLookup.ts` fallback, or it manufactures a duplicate that
 * renders identically to the row it failed to find.
 *
 * That rule was applied at one call site, then found missing at two more a
 * review round later, then at four more the round after that — the same defect
 * class three rounds running, every instance found by a human reading the diff.
 * This test is the mechanism that replaces the human.
 *
 * ## Granularity is the whole point
 *
 * The first version of this file asked whether the FILE imported the helper.
 * That is worthless: one guarded query anywhere exempts every other query in
 * the same file — and it was already waving through a live bug, the variant
 * collision check in the OpenPrintTag importer, in a file that used the helper
 * fifty lines earlier. So the unit of judgement is the QUERY, not the file.
 *
 * Each name-filtered query must have, within its immediate neighbourhood,
 * either a call to the fallback or an explicit
 *
 *     // name-lookup-ok: <why this one cannot manufacture a duplicate>
 *
 * marker. Writing the reason at the query — rather than in a table at the top
 * of some other file — is what makes the next reviewer able to check it.
 */

const SRC = "src";

/** How far from the match to look for a fallback call or a marker. Generous
 *  on purpose: a guarded query and its fallback are often separated by the
 *  comment explaining why. */
const WINDOW_BEFORE = 6;
const WINDOW_AFTER = 40;

/** `findOne({ name` / `findOneAndUpdate({ name, ...` — a bare `name` key in a
 *  query filter, not a `name:` nested inside an update document. */
const NAME_FILTER =
  /(findOne|findOneAndUpdate|findOneAndDelete|updateOne|deleteOne)\(\s*\{[^}]{0,240}?(^|[\s,{])name\s*[,:]/m;
const NAME_FILTER_G = new RegExp(NAME_FILTER.source, "gm");

const SATISFIED = /findSurvivorId|findByTrimmedName|trimmedNameFilter|name-lookup-ok:/;

/** A match whose own line is a comment is documentation, not a query. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

interface Offender {
  file: string;
  line: number;
  snippet: string;
}

function findOffenders(): Offender[] {
  const offenders: Offender[] = [];
  for (const file of walk(SRC)) {
    const rel = file.replace(/\\/g, "/");
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    NAME_FILTER_G.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NAME_FILTER_G.exec(source)) !== null) {
      const lineIndex = source.slice(0, m.index).split("\n").length - 1;
      if (isCommentLine(lines[lineIndex] ?? "")) continue;
      const window = lines
        .slice(Math.max(0, lineIndex - WINDOW_BEFORE), lineIndex + WINDOW_AFTER)
        .join("\n");
      if (SATISFIED.test(window)) continue;
      offenders.push({
        file: rel,
        line: lineIndex + 1,
        snippet: (lines[lineIndex] ?? "").trim().slice(0, 100),
      });
    }
  }
  return offenders;
}

describe("every name-filtered query is survivor-aware (GH #1116)", () => {
  it("has no unguarded, unexplained name-filtered query", () => {
    const offenders = findOffenders();
    expect(
      offenders.map((o) => `${o.file}:${o.line}  ${o.snippet}`),
      "Each of these filters a Mongoose query on `name` with no survivor " +
        "fallback nearby and no explanation.\n\n" +
        "If the path can CREATE when the lookup misses, it will manufacture a " +
        "duplicate against a row `trimEntityNames` could not repair — use " +
        "findSurvivorId/findByTrimmedName from src/lib/trimmedNameLookup.ts.\n\n" +
        "If it genuinely cannot (a read-only lookup, a guard that only " +
        "refuses, or a post-E11000 recovery where the index already proved an " +
        "exact stored-string match), put a\n" +
        "    // name-lookup-ok: <reason>\n" +
        "comment on the line above it.",
    ).toEqual([]);
  });

  it("actually detects the pattern it claims to", () => {
    // A detector that silently matches nothing passes forever while covering
    // nothing — which is precisely the failure this file exists to prevent one
    // level up, so it is asserted rather than assumed.
    expect(NAME_FILTER.test(`await Filament.findOne({ name, _deletedAt: null })`)).toBe(true);
    expect(
      NAME_FILTER.test(`await Filament.findOneAndUpdate({\n  name: importName,\n  vendor,\n})`),
    ).toBe(true);
    // Not a name filter: addressed by id, or `name` inside the update doc.
    expect(NAME_FILTER.test(`await Filament.findOne({ _id: id })`)).toBe(false);
    expect(
      NAME_FILTER.test(`await Filament.updateOne({ _id: id }, { $set: { name: "x" } })`),
    ).toBe(false);
  });

  it("still finds the real call sites — the sweep is not vacuous", () => {
    // Without this, deleting the regex body or pointing SRC at an empty
    // directory would turn the suite green. The count is deliberately a floor,
    // not an equality, so ordinary churn does not fail CI.
    let total = 0;
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      NAME_FILTER_G.lastIndex = 0;
      while (NAME_FILTER_G.exec(source) !== null) total++;
    }
    expect(total).toBeGreaterThanOrEqual(20);
  });

  it("treats a marker as scoped to its own query, not the file", () => {
    // The regression that motivated the rewrite: a guarded query must not
    // launder an unguarded one elsewhere in the same file.
    const guarded = [
      "const a = await Filament.findOne({ name, _deletedAt: null });",
      "// name-lookup-ok: read-only",
    ].join("\n");
    const unguardedFarBelow = [
      guarded,
      ...Array.from({ length: WINDOW_AFTER + 10 }, () => "// filler"),
      "const b = await Filament.findOne({ name, vendor });",
    ].join("\n");
    const lines = unguardedFarBelow.split("\n");
    NAME_FILTER_G.lastIndex = 0;
    const positions: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = NAME_FILTER_G.exec(unguardedFarBelow)) !== null) {
      positions.push(unguardedFarBelow.slice(0, m.index).split("\n").length - 1);
    }
    expect(positions).toHaveLength(2);
    const windowFor = (i: number) =>
      lines.slice(Math.max(0, i - WINDOW_BEFORE), i + WINDOW_AFTER).join("\n");
    expect(SATISFIED.test(windowFor(positions[0]))).toBe(true);
    expect(SATISFIED.test(windowFor(positions[1]))).toBe(false);
  });
});

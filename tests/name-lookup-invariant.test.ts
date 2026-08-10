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
 * survivors (a skipped collection, a colliding row).
 *
 * Every "resolve by name, then create when missing" path therefore needs the
 * `src/lib/trimmedNameLookup.ts` fallback, or it manufactures a duplicate that
 * renders identically to the row it failed to find.
 *
 * That rule was applied at one call site, then found missing at two more a
 * review round later, then at four more the round after that — the same defect
 * class three rounds running, each time discovered by a human reading the diff
 * rather than by anything mechanical. This test is the mechanism.
 *
 * ## What it does
 *
 * Any file under `src/` that filters a Mongoose query on a bare `name` must
 * either import the fallback helper, or appear in `EXEMPT` with a reason.
 * It is deliberately coarse: a false positive costs one line of allow-list
 * with an explanation, while a false negative costs a duplicated user record.
 *
 * The exemptions are the interesting part — read them before adding one.
 */

/** Files whose name-filtered queries cannot manufacture a duplicate. */
const EXEMPT: Record<string, string> = {
  // Read-only resolution: a miss returns not-found, which is correct and
  // already the behaviour for a genuinely absent name.
  "src/lib/matchFilament.ts":
    "read-only — a miss falls through to the other match tiers, never creates",
  "src/lib/singleFilamentExport.ts":
    "read-only export lookup — a miss is a 404",
  "src/app/api/filaments/[id]/calibration/route.ts":
    "read-only — slicer asks for calibration by preset name; a miss is a 404",
  "src/app/api/filaments/[id]/spool-check/route.ts":
    "read-only — a miss is a 404",
  "src/app/api/filaments/[id]/orcaslicer/route.ts":
    "name-addressed sync resolves an EXISTING row; create-on-404 was removed in #867",
  "src/app/api/filaments/[id]/route.ts":
    "name-addressed sync + name_taken collision guards; create-on-404 removed in #867",
  "src/app/api/filaments/[id]/restore/route.ts":
    "restore-time name conflict guard — refuses, never creates",

  // The helper and the migration themselves — they document the rule.
  "src/lib/trimmedNameLookup.ts": "the helper itself",
  "src/lib/trimEntityNames.ts": "the migration that removes the survivors",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** `findOne({ name` / `findOneAndUpdate({ name, ...` — a bare `name` key in a
 *  query filter, not `name:` nested inside some other object. */
const NAME_FILTER =
  /(findOne|findOneAndUpdate|findOneAndDelete|updateOne|deleteOne)\(\s*\{[^}]{0,240}?(^|[\s,{])name\s*[,:]/m;

describe("every name-filtered query is survivor-aware (GH #1116)", () => {
  const offenders: string[] = [];

  for (const file of walk("src")) {
    const rel = file.replace(/\\/g, "/");
    const source = readFileSync(file, "utf8");
    if (!NAME_FILTER.test(source)) continue;
    if (rel in EXEMPT) continue;
    if (source.includes("@/lib/trimmedNameLookup")) continue;
    offenders.push(rel);
  }

  it("has no unreviewed name-filtered query", () => {
    expect(
      offenders,
      `These files filter a Mongoose query on \`name\` but neither use the ` +
        `survivor fallback (src/lib/trimmedNameLookup.ts) nor appear in EXEMPT.\n\n` +
        `If the path can CREATE when the lookup misses, it will manufacture a ` +
        `duplicate against a row the migration could not trim — add the ` +
        `fallback. If it cannot create, add it to EXEMPT with the reason.\n\n` +
        offenders.map((f) => `  - ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a file that no longer has a name-filtered query is
    // stale, and a stale allow-list is how a real offender gets waved through
    // later under a name someone recognises.
    const stale = Object.keys(EXEMPT).filter((rel) => {
      let source: string;
      try {
        source = readFileSync(rel, "utf8");
      } catch {
        return true; // file gone
      }
      if (rel === "src/lib/trimmedNameLookup.ts" || rel === "src/lib/trimEntityNames.ts") {
        return false; // self-referential, documented above
      }
      return !NAME_FILTER.test(source);
    });
    expect(stale, `Stale EXEMPT entries — remove them:\n${stale.join("\n")}`).toEqual([]);
  });

  it("actually detects the pattern it claims to", () => {
    // Guards the regex itself: a test that silently matches nothing would
    // pass forever while covering nothing, which is the failure mode this
    // whole file exists to prevent one level up.
    expect(NAME_FILTER.test(`await Filament.findOne({ name, _deletedAt: null })`)).toBe(true);
    expect(
      NAME_FILTER.test(`await Filament.findOneAndUpdate({\n  name: importName,\n  vendor,\n})`),
    ).toBe(true);
    // Not a name filter: addressing by id, or a `name` nested in an update.
    expect(NAME_FILTER.test(`await Filament.findOne({ _id: id })`)).toBe(false);
    expect(NAME_FILTER.test(`await Filament.updateOne({ _id: id }, { $set: { x: 1 } })`)).toBe(
      false,
    );
  });
});

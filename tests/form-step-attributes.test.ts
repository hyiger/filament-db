import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * GH #1171 — source-level drift guard (same posture as the #1166 guard in
 * api-route-correctness.test.ts).
 *
 * FilamentForm is a single <form> whose tab panels stay mounted-but-hidden so
 * native constraint validation covers unopened tabs (#942). Consequently ANY
 * number input whose `step` is coarser than what the import/sync pipeline
 * stores (CSV parseNum, slicer parseFloat — arbitrary decimals) puts the form
 * into a stepMismatch state that blocks saving the ENTIRE form for values the
 * user never touched. #1166 hit this on max volumetric speed (step="0.1" vs a
 * synced 12.34); #1171 is the class sweep.
 *
 * The subtle half of the class: an <input type="number"> with NO step
 * attribute defaults to step=1, so a CSV-imported 217.5 °C temperature is just
 * as save-blocking as an explicit step="1". That's why this guard requires an
 * EXPLICIT step="any" on every number input rather than merely banning coarse
 * values — absence is an offender too.
 *
 * Allowlist: density + diameter keep step="0.01" deliberately. Their stored
 * values are the one place snapToStep normalizes at seed time (GH #570 — CBOR
 * half-float dust like 1.2392578125), so the seeded value always sits on the
 * 0.01 grid and can never stepMismatch. Loosening them without removing the
 * snap would be dead relaxation; removing the snap resurfaces #570.
 */

const REPO_ROOT = path.resolve(__dirname, "..");

// Every component that renders number inputs inside a real <form> (submit runs
// native constraint validation). The detail-page / inventory weight inputs are
// deliberately NOT here: they live outside any <form> with onClick saves, so
// their step can never block anything.
const FORM_FILES = [
  "src/app/filaments/FilamentForm.tsx",
  "src/app/printers/PrinterForm.tsx",
  "src/app/locations/LocationForm.tsx",
  "src/app/nozzles/NozzleForm.tsx",
  "src/app/bed-types/BedTypeForm.tsx",
];

// file → identifying substrings of number inputs allowed to keep a finite step.
const STEP_ALLOWLIST: Record<string, string[]> = {
  "src/app/filaments/FilamentForm.tsx": [
    'id="filament-density"', // GH #570 seed-snap keeps the value on the 0.01 grid
    'id="filament-diameter"', // GH #570 seed-snap keeps the value on the 0.01 grid
  ],
};

interface InputTag {
  tag: string;
  line: number;
}

// Extracts each <input …> JSX tag. A plain /<input[^>]*>/ regex truncates at
// the `>` inside onChange={(e) => …}, so this walks characters tracking brace
// depth: a `>` only terminates the tag at depth 0. Occurrences inside
// comments (a line whose prefix is `//` or a block-comment `*`) are prose,
// not controls — FilamentForm's getSettingVal docblock cites
// `<input type="number">` verbatim and must not count as an offender.
function extractInputTags(source: string): InputTag[] {
  const tags: InputTag[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf("<input", searchFrom);
    if (start === -1) break;
    const lineStart = source.lastIndexOf("\n", start) + 1;
    const linePrefix = source.slice(lineStart, start).trimStart();
    if (linePrefix.startsWith("//") || linePrefix.startsWith("*") || linePrefix.startsWith("/*")) {
      searchFrom = start + 1;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) break;
    tags.push({
      tag: source.slice(start, end + 1),
      line: source.slice(0, start).split("\n").length,
    });
    searchFrom = end + 1;
  }
  return tags;
}

function numberInputs(source: string): InputTag[] {
  return extractInputTags(source).filter((t) => t.tag.includes('type="number"'));
}

describe("form number inputs use step=\"any\" (GH #1171)", () => {
  it("every number input in a real <form> carries step=\"any\" or is allowlisted", () => {
    const offenders: string[] = [];
    for (const file of FORM_FILES) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      const allowed = STEP_ALLOWLIST[file] ?? [];
      for (const { tag, line } of numberInputs(source)) {
        if (tag.includes('step="any"')) continue;
        if (allowed.some((marker) => tag.includes(marker))) continue;
        offenders.push(`${file}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the allowlist stays live — each entry still names a finite-step number input", () => {
    // If density/diameter are renamed or loosened, the allowlist must shrink
    // rather than silently covering nothing.
    for (const [file, markers] of Object.entries(STEP_ALLOWLIST)) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      const inputs = numberInputs(source);
      for (const marker of markers) {
        const matches = inputs.filter((t) => t.tag.includes(marker));
        expect(matches, `${file} ${marker}`).toHaveLength(1);
        expect(matches[0].tag, `${file} ${marker} should keep a finite step`).toMatch(
          /step="0\.01"/,
        );
      }
    }
  });

  it("the extractor ignores input tags cited inside comments", () => {
    const jsx =
      '// <input type="number"> is sanitized by browsers\n' +
      "/* <input type=\"number\"> in a block comment\n" +
      ' * <input type="number"> on a continuation line */\n' +
      '<input type="number" step="any" />';
    expect(extractInputTags(jsx)).toHaveLength(1);
  });

  it("the extractor sees through arrow functions in attributes", () => {
    // Self-test: a regex-based extractor would truncate at the `=>` and lose
    // the step attribute; this pins the brace-aware walk.
    const jsx =
      '<input\n  type="number"\n  onChange={(e) => setForm({ ...form, x: e.target.value })}\n  step="any"\n/>';
    const tags = extractInputTags(jsx);
    expect(tags).toHaveLength(1);
    expect(tags[0].tag).toContain('step="any"');
  });
});

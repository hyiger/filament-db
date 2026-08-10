import { describe, it, expect } from "vitest";
import {
  MAX_FRAGMENT_CHARS,
  MAX_SHOWN_SKIPPED,
  formatSkipReport,
  type SkippedRowLike,
} from "@/lib/importSkipReport";

const strings = {
  row: ({ row, name, reason }: { row: number; name: string; reason: string }) =>
    `row ${row} — ${name}: ${reason}`,
  overflow: (count: number) => `…and ${count} more`,
};

const skip = (row: number, over: Partial<SkippedRowLike> = {}): SkippedRowLike => ({
  row,
  name: `F${row}`,
  reason: "Missing required field(s): vendor",
  ...over,
});

describe("formatSkipReport", () => {
  it("returns null when nothing was skipped and there are no notes", () => {
    // The caller uses null to mean "don't open a dialog at all".
    expect(formatSkipReport([], [], strings)).toBeNull();
    expect(formatSkipReport(undefined, undefined, strings)).toBeNull();
  });

  it("renders one line per skipped row", () => {
    expect(formatSkipReport([skip(2), skip(5)], undefined, strings)).toBe(
      "row 2 — F2: Missing required field(s): vendor\n" +
        "row 5 — F5: Missing required field(s): vendor",
    );
  });

  it("caps the list and reports the overflow", () => {
    const rows = Array.from({ length: 14 }, (_, i) => skip(i + 2));
    const out = formatSkipReport(rows, undefined, strings)!.split("\n");
    expect(out).toHaveLength(MAX_SHOWN_SKIPPED + 1);
    expect(out[out.length - 1]).toBe("…and 4 more");
  });

  it("keeps the reported row numbers verbatim — they are physical lines", () => {
    // The importer now passes real source lines, so the report must not
    // renumber or re-sort them.
    const out = formatSkipReport([skip(9), skip(3)], undefined, strings)!;
    expect(out.startsWith("row 9")).toBe(true);
    expect(out).toContain("row 3");
  });

  it("never interpolates a bare undefined for an unnamed row", () => {
    // A row can fail BEFORE its name is known — a missing Name column is
    // itself a skip reason.
    const out = formatSkipReport(
      [{ row: 4, reason: "Missing required field(s): name" }],
      undefined,
      {
        ...strings,
        row: ({ row, name, reason }) => (name ? `row ${row} — ${name}: ${reason}` : `row ${row}: ${reason}`),
      },
    );
    expect(out).toBe("row 4: Missing required field(s): name");
    expect(out).not.toContain("undefined");
  });

  it("treats a whitespace-only name as unnamed", () => {
    const out = formatSkipReport([skip(2, { name: "   " })], undefined, {
      ...strings,
      row: ({ row, name, reason }) => (name ? `named:${name}` : `unnamed:${row}:${reason}`),
    });
    expect(out).toBe("unnamed:2:Missing required field(s): vendor");
  });

  it("appends the non-fatal notes", () => {
    // GH #605 notes describe rows that DID import but had something stripped.
    // They were equally invisible and answer the same question.
    expect(formatSkipReport([skip(2)], ['Row 3 "X": skipped color'], strings)).toBe(
      "row 2 — F2: Missing required field(s): vendor\n" + 'Row 3 "X": skipped color',
    );
  });

  it("renders notes even when nothing was skipped", () => {
    expect(formatSkipReport([], ["Row 3: a note"], strings)).toBe("Row 3: a note");
  });
});

describe("formatSkipReport — note capping (Codex P2)", () => {
  it("caps notes on the SAME budget as skipped rows", () => {
    // "At most a handful" was wrong: a bulk update touching many templates
    // emits one note per row, up to the route's 10,000-row limit — and
    // ConfirmDialog's body neither scrolls nor bounds its height, so an
    // uncapped list would push Close off-screen.
    const notes = Array.from({ length: 30 }, (_, i) => `note ${i}`);
    const out = formatSkipReport([], notes, strings)!.split("\n");
    expect(out).toHaveLength(MAX_SHOWN_SKIPPED + 1);
    expect(out[out.length - 1]).toBe(`…and ${30 - MAX_SHOWN_SKIPPED} more`);
  });

  it("shares one budget across rows and notes", () => {
    // The dialog must be bounded overall, not per-section.
    const rows = Array.from({ length: 6 }, (_, i) => skip(i + 2));
    const notes = Array.from({ length: 20 }, (_, i) => `note ${i}`);
    const out = formatSkipReport(rows, notes, strings)!.split("\n");
    // 6 rows + 4 notes fills the budget, then one overflow line.
    expect(out).toHaveLength(MAX_SHOWN_SKIPPED + 1);
    expect(out[out.length - 1]).toBe("…and 16 more");
  });

  it("adds no overflow line when the notes fit", () => {
    const out = formatSkipReport([skip(2)], ["one note"], strings)!.split("\n");
    expect(out).toHaveLength(2);
    expect(out[1]).toBe("one note");
  });
});

describe("formatSkipReport — text bounds (Codex P2)", () => {
  it("clips a pathologically long reason", () => {
    // The entry cap bounds LINE COUNT, not length: a skip reason interpolates
    // the offending cell verbatim, and a single cell may approach the route's
    // ~10 MB upload limit. Ten such lines is still a multi-megabyte message in
    // a dialog that neither scrolls nor bounds its height.
    const huge = "x".repeat(50_000);
    const out = formatSkipReport([skip(2, { reason: huge })], undefined, strings)!;
    expect(out.length).toBeLessThan(MAX_FRAGMENT_CHARS + 100);
    expect(out).toContain("…");
  });

  it("clips a pathologically long name", () => {
    const out = formatSkipReport([skip(2, { name: "y".repeat(50_000) })], undefined, strings)!;
    expect(out.length).toBeLessThan(MAX_FRAGMENT_CHARS + 100);
  });

  it("clips a pathologically long note", () => {
    const out = formatSkipReport([], ["z".repeat(50_000)], strings)!;
    expect(out.length).toBeLessThan(MAX_FRAGMENT_CHARS + 10);
  });

  it("bounds the whole message even at the entry cap", () => {
    // The two caps together are what make the dialog bounded.
    const rows = Array.from({ length: 40 }, (_, i) => skip(i + 2, { reason: "q".repeat(5_000) }));
    const out = formatSkipReport(rows, undefined, strings)!;
    expect(out.length).toBeLessThan(MAX_SHOWN_SKIPPED * (MAX_FRAGMENT_CHARS * 2 + 40) + 200);
  });

  it("leaves an ordinary reason untouched", () => {
    const out = formatSkipReport([skip(2)], undefined, strings)!;
    expect(out).toBe("row 2 — F2: Missing required field(s): vendor");
    expect(out).not.toContain("…");
  });
});

describe("line terminators inside a fragment", () => {
  it("folds newlines to spaces so a quoted CSV cell can't blow up the dialog height", () => {
    // ConfirmDialog renders with whitespace-pre-wrap and no height bound, so
    // 160 characters of "\n" is 160 rendered lines — the cap bounds characters,
    // not lines, and Close ends up off-screen either way.
    const out = formatSkipReport(
      [{ row: 2, name: "a\nb\r\nc", reason: 'Parent "x\ny" not found' }],
      undefined,
      strings,
    );
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toContain("a b c");
    expect(out).toContain('Parent "x y" not found');
  });

  it("folds U+2028/U+2029, which pre-wrap also breaks on", () => {
    const out = formatSkipReport(
      [{ row: 2, name: "a\u2028b\u2029c", reason: "r" }],
      undefined,
      strings,
    );
    expect(out).toContain("a b c");
    expect(out).not.toMatch(/[\u2028\u2029]/);
  });

  it("folds BEFORE clipping — a newline-only cell can't survive inside the kept 160 chars", () => {
    const out = formatSkipReport(
      [{ row: 2, name: "x".repeat(5), reason: "\n".repeat(400) + "tail" }],
      undefined,
      strings,
    );
    expect(out).not.toMatch(/[\r\n]/);
  });
});

import { describe, expect, it } from "vitest";
import { MAX_USAGE_GRAMS } from "@/lib/capUsageHistory";
import {
  MAX_JOB_LABEL_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_USAGE_ROWS,
  buildPrintJobBody,
  emptyUsageRow,
  parseGrams,
  validatePrintJobForm,
  type PrintJobFormState,
} from "@/lib/printJobForm";

// GH #1167 — validation + body building for the in-app Log-print-job dialog.
// Mirrors the POST /api/print-history contract (tests/print-history.test.ts
// pins the server side; this pins the client side stays within it).

const FILAMENT_ID = "507f1f77bcf86cd799439011";
const SPOOL_ID = "507f1f77bcf86cd799439012";
// "Today" is injected — the helper never reads the clock (Codex P1 #1182).
const TODAY = "2026-08-27";

function validForm(overrides: Partial<PrintJobFormState> = {}): PrintJobFormState {
  return {
    jobLabel: "Benchy",
    printerId: "",
    date: "2026-08-26",
    notes: "",
    usage: [{ filamentId: FILAMENT_ID, spoolId: "", grams: "12.5" }],
    ...overrides,
  };
}

describe("parseGrams", () => {
  it("parses plain and decimal numbers", () => {
    expect(parseGrams("12")).toBe(12);
    expect(parseGrams(" 12.5 ")).toBe(12.5);
  });

  it("rejects empty, garbage, trailing-garbage, and non-finite input", () => {
    expect(parseGrams("")).toBeNull();
    expect(parseGrams("   ")).toBeNull();
    expect(parseGrams("abc")).toBeNull();
    // Number() (not parseFloat) so "12abc" is rejected, not silently 12.
    expect(parseGrams("12abc")).toBeNull();
    expect(parseGrams("Infinity")).toBeNull();
    expect(parseGrams("NaN")).toBeNull();
  });
});

describe("validatePrintJobForm", () => {
  it("accepts a minimal valid form", () => {
    expect(validatePrintJobForm(validForm(), TODAY)).toEqual({ ok: true });
  });

  it("requires a non-blank job label", () => {
    expect(validatePrintJobForm(validForm({ jobLabel: "" }), TODAY)).toEqual({
      ok: false,
      code: "label_required",
    });
    expect(validatePrintJobForm(validForm({ jobLabel: "   " }), TODAY)).toEqual({
      ok: false,
      code: "label_required",
    });
  });

  it("caps the label at the server's 200-char bound", () => {
    expect(
      validatePrintJobForm(validForm({ jobLabel: "x".repeat(MAX_JOB_LABEL_LENGTH) }), TODAY),
    ).toEqual({ ok: true });
    expect(
      validatePrintJobForm(validForm({ jobLabel: "x".repeat(MAX_JOB_LABEL_LENGTH + 1) }), TODAY),
    ).toEqual({ ok: false, code: "label_too_long" });
  });

  it("caps notes at the server's 2000-char slice so nothing truncates silently", () => {
    expect(
      validatePrintJobForm(validForm({ notes: "n".repeat(MAX_NOTES_LENGTH) }), TODAY),
    ).toEqual({ ok: true });
    expect(
      validatePrintJobForm(validForm({ notes: "n".repeat(MAX_NOTES_LENGTH + 1) }), TODAY),
    ).toEqual({ ok: false, code: "notes_too_long" });
  });

  it("requires 1..100 usage rows", () => {
    expect(validatePrintJobForm(validForm({ usage: [] }), TODAY)).toEqual({
      ok: false,
      code: "no_rows",
    });
    const many = Array.from({ length: MAX_USAGE_ROWS + 1 }, () => ({
      filamentId: FILAMENT_ID,
      spoolId: "",
      grams: "1",
    }));
    expect(validatePrintJobForm(validForm({ usage: many }), TODAY)).toEqual({
      ok: false,
      code: "too_many_rows",
    });
  });

  it("flags the offending row for a missing filament", () => {
    const usage = [
      { filamentId: FILAMENT_ID, spoolId: "", grams: "5" },
      { filamentId: "", spoolId: "", grams: "5" },
    ];
    expect(validatePrintJobForm(validForm({ usage }), TODAY)).toEqual({
      ok: false,
      code: "row_filament_required",
      rowIndex: 1,
    });
  });

  it("requires positive grams — the server accepts 0 but a 0 g form row is a typo", () => {
    for (const grams of ["", "0", "-1", "abc"]) {
      expect(
        validatePrintJobForm(validForm({ usage: [{ filamentId: FILAMENT_ID, spoolId: "", grams }] }), TODAY),
      ).toEqual({ ok: false, code: "row_grams_invalid", rowIndex: 0 });
    }
  });

  it("enforces the MAX_USAGE_GRAMS magnitude bound (GH #1030)", () => {
    expect(
      validatePrintJobForm(
        validForm({ usage: [{ filamentId: FILAMENT_ID, spoolId: "", grams: String(MAX_USAGE_GRAMS) }] }),
        TODAY,
      ),
    ).toEqual({ ok: true });
    expect(
      validatePrintJobForm(
        validForm({ usage: [{ filamentId: FILAMENT_ID, spoolId: "", grams: String(MAX_USAGE_GRAMS + 1) }] }),
        TODAY,
      ),
    ).toEqual({ ok: false, code: "row_grams_too_large", rowIndex: 0 });
  });
});

describe("buildPrintJobBody", () => {
  it("builds the minimal body: trimmed label, parsed grams, no optional fields", () => {
    const body = buildPrintJobBody(
      validForm({ jobLabel: "  Benchy ", printerId: "", date: "", notes: "  " }),
      TODAY,
    );
    expect(body).toEqual({
      jobLabel: "Benchy",
      usage: [{ filamentId: FILAMENT_ID, grams: 12.5 }],
    });
    expect(body).not.toHaveProperty("printerId");
    expect(body).not.toHaveProperty("startedAt");
    expect(body).not.toHaveProperty("notes");
    expect(body.usage[0]).not.toHaveProperty("spoolId");
  });

  it("passes a PAST bare YYYY-MM-DD through as startedAt (v1.63 UTC-midnight convention)", () => {
    const body = buildPrintJobBody(validForm({ date: "2026-08-26" }), TODAY);
    expect(body.startedAt).toBe("2026-08-26");
  });

  it("omits startedAt when the picked date is TODAY — the server stamps the current instant (Codex P1 #1182)", () => {
    // Today's UTC midnight is still in the future for a user east of UTC,
    // and analytics excludes startedAt > now — the job would vanish from
    // every aggregate until UTC catches up.
    const body = buildPrintJobBody(validForm({ date: TODAY }), TODAY);
    expect(body).not.toHaveProperty("startedAt");
  });

  it("rejects a future date at validation (Codex P1 #1182)", () => {
    expect(validatePrintJobForm(validForm({ date: "2026-08-28" }), TODAY)).toEqual({
      ok: false,
      code: "date_in_future",
    });
    // Today and the past are fine; empty date is fine (server stamps now).
    expect(validatePrintJobForm(validForm({ date: TODAY }), TODAY)).toEqual({ ok: true });
    expect(validatePrintJobForm(validForm({ date: "" }), TODAY)).toEqual({ ok: true });
  });

  it("includes printerId, notes, and per-row spoolId when set", () => {
    const body = buildPrintJobBody(
      validForm({
        printerId: "507f1f77bcf86cd799439099",
        notes: " first layer rough ",
        usage: [{ filamentId: FILAMENT_ID, spoolId: SPOOL_ID, grams: "7" }],
      }),
      TODAY,
    );
    expect(body.printerId).toBe("507f1f77bcf86cd799439099");
    expect(body.notes).toBe("first layer rough");
    expect(body.usage[0].spoolId).toBe(SPOOL_ID);
    expect(body.usage[0].grams).toBe(7);
  });

  it("never sends a source field — the server defaults to \"manual\"", () => {
    expect(buildPrintJobBody(validForm(), TODAY)).not.toHaveProperty("source");
  });

  it("defensively coerces unparseable grams to 0 when called without validating", () => {
    const body = buildPrintJobBody(
      validForm({ usage: [{ filamentId: FILAMENT_ID, spoolId: "", grams: "abc" }] }),
      TODAY,
    );
    expect(body.usage[0].grams).toBe(0);
  });
});

describe("emptyUsageRow", () => {
  it("returns a fresh unfilled row each call", () => {
    const a = emptyUsageRow();
    expect(a).toEqual({ filamentId: "", spoolId: "", grams: "" });
    expect(emptyUsageRow()).not.toBe(a);
  });
});

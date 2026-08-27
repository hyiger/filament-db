/**
 * GH #1167 — pure validation + body building for the in-app "Log print job"
 * dialog. Extracted from the component so the submit logic is unit-testable
 * (there is no component-test infra; src/lib is the coverage-gated home for
 * anything worth pinning).
 *
 * The server contract this mirrors is POST /api/print-history: jobLabel
 * required and ≤200 chars, usage a non-empty array of ≤100 rows with a valid
 * filamentId and grams in (0, MAX_USAGE_GRAMS], notes ≤2000 (the server
 * slices, we cap client-side so nothing is silently truncated). `source` is
 * deliberately never sent — the server defaults it to "manual", which is what
 * an in-app log is. The date rides as the bare `YYYY-MM-DD` from the picker
 * (stored as UTC midnight), the v1.63 convention that keeps analytics
 * day-buckets on the picked calendar day in every timezone.
 */

import { MAX_USAGE_GRAMS } from "@/lib/capUsageHistory";

export const MAX_JOB_LABEL_LENGTH = 200;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_USAGE_ROWS = 100;

export interface PrintJobUsageRow {
  filamentId: string;
  /** Spool subdocument id; "" = let the server auto-select (first non-retired
   *  spool with weight). */
  spoolId: string;
  /** Raw input value — validated/parsed here, not in the component. */
  grams: string;
}

export interface PrintJobFormState {
  jobLabel: string;
  /** "" = no printer. */
  printerId: string;
  /** Bare YYYY-MM-DD from <input type="date">; "" omits startedAt. */
  date: string;
  notes: string;
  usage: PrintJobUsageRow[];
}

export function emptyUsageRow(): PrintJobUsageRow {
  return { filamentId: "", spoolId: "", grams: "" };
}

export type PrintJobFormError =
  | { code: "label_required" }
  | { code: "label_too_long" }
  | { code: "notes_too_long" }
  | { code: "no_rows" }
  | { code: "too_many_rows" }
  | { code: "row_filament_required"; rowIndex: number }
  | { code: "row_grams_invalid"; rowIndex: number }
  | { code: "row_grams_too_large"; rowIndex: number };

export type PrintJobFormValidation =
  | { ok: true }
  | ({ ok: false } & PrintJobFormError);

export function parseGrams(raw: string): number | null {
  const trimmed = raw.trim();
  // Number("") is 0 and Number("12abc") is NaN — Number() (not parseFloat)
  // so trailing garbage is rejected rather than silently dropped.
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function validatePrintJobForm(form: PrintJobFormState): PrintJobFormValidation {
  if (form.jobLabel.trim() === "") return { ok: false, code: "label_required" };
  if (form.jobLabel.length > MAX_JOB_LABEL_LENGTH) return { ok: false, code: "label_too_long" };
  if (form.notes.length > MAX_NOTES_LENGTH) return { ok: false, code: "notes_too_long" };
  if (form.usage.length === 0) return { ok: false, code: "no_rows" };
  if (form.usage.length > MAX_USAGE_ROWS) return { ok: false, code: "too_many_rows" };
  for (let i = 0; i < form.usage.length; i++) {
    const row = form.usage[i];
    if (row.filamentId === "") return { ok: false, code: "row_filament_required", rowIndex: i };
    const grams = parseGrams(row.grams);
    // The server accepts grams === 0, but a 0 g row from the form is always a
    // typo or an unfilled field — require a positive amount.
    if (grams === null || grams <= 0) {
      return { ok: false, code: "row_grams_invalid", rowIndex: i };
    }
    if (grams > MAX_USAGE_GRAMS) return { ok: false, code: "row_grams_too_large", rowIndex: i };
  }
  return { ok: true };
}

export interface PrintJobBody {
  jobLabel: string;
  printerId?: string;
  startedAt?: string;
  notes?: string;
  usage: { filamentId: string; spoolId?: string; grams: number }[];
}

/** Build the POST body. Call only after validatePrintJobForm returns ok. */
export function buildPrintJobBody(form: PrintJobFormState): PrintJobBody {
  const body: PrintJobBody = {
    jobLabel: form.jobLabel.trim(),
    usage: form.usage.map((row) => {
      const entry: PrintJobBody["usage"][number] = {
        filamentId: row.filamentId,
        grams: parseGrams(row.grams) ?? 0,
      };
      if (row.spoolId !== "") entry.spoolId = row.spoolId;
      return entry;
    }),
  };
  if (form.printerId !== "") body.printerId = form.printerId;
  if (form.date !== "") body.startedAt = form.date;
  const notes = form.notes.trim();
  if (notes !== "") body.notes = notes;
  return body;
}

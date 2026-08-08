import mongoose from "mongoose";

/**
 * GH #897 / #912 / #1083 — shared `printerIds` validation for the nozzle
 * create (POST /api/nozzles) and update (PUT /api/nozzles/{id}) routes.
 *
 * A single physical nozzle lives in at most ONE printer (#232). The PUT
 * route enforced that with pre-mutation validation since #897/#912, but the
 * POST route (#1083) accepted an arbitrary array and installed AFTER
 * `Nozzle.create` — so a multi-printer body bypassed the invariant, and a
 * malformed/missing printer id 500'd or no-op'd with a committed nozzle
 * left behind. Both routes now run this ONE check BEFORE any mutation so
 * the two can't drift again.
 *
 * Order of checks (each is load-bearing):
 *   1. Non-array → `printerIds: undefined` (the caller skips the printer
 *      sync entirely — the PUT's "field not sent" semantics).
 *   2. Dedupe BEFORE the one-printer check (#912): a client that sends the
 *      same printer twice (`[id, id]` — a duplicated selection / retry
 *      payload) still targets ONE unique printer and must not be rejected.
 *   3. >1 unique printer → refuse (one-printer-per-nozzle, #232/#897).
 *   4. Exactly one → the id must be a valid ObjectId AND resolve to a live
 *      printer via the injected `findActivePrinter` (mirrors the printer
 *      routes' existence check), so an assignment can't silently no-op.
 *
 * `findActivePrinter` is injected (the routes pass a
 * `Printer.findOne({_id, _deletedAt: null})` closure) so this module stays
 * model-free and unit-testable without a DB.
 */

export const MULTI_PRINTER_MESSAGE =
  "A nozzle can be installed in at most one printer at a time.";
export const INVALID_PRINTER_ID_MESSAGE =
  "printerIds must contain a valid printer id";
export const PRINTER_NOT_FOUND_MESSAGE = "Target printer not found";

export type NozzlePrinterAssignment =
  | {
      ok: true;
      /** Deduped string ids, or undefined when the client didn't send an array. */
      printerIds: string[] | undefined;
      /** The validated single target, or null (no array / empty array). */
      targetId: string | null;
    }
  | { ok: false; message: string };

export async function validateNozzlePrinterAssignment(
  rawPrinterIds: unknown,
  findActivePrinter: (id: string) => Promise<unknown>,
): Promise<NozzlePrinterAssignment> {
  if (!Array.isArray(rawPrinterIds)) {
    return { ok: true, printerIds: undefined, targetId: null };
  }
  const printerIds = [...new Set(rawPrinterIds.map((p): string => String(p)))];
  if (printerIds.length > 1) {
    return { ok: false, message: MULTI_PRINTER_MESSAGE };
  }
  if (printerIds.length === 0) {
    return { ok: true, printerIds, targetId: null };
  }
  const targetId = printerIds[0];
  if (!mongoose.isValidObjectId(targetId)) {
    return { ok: false, message: INVALID_PRINTER_ID_MESSAGE };
  }
  const target = await findActivePrinter(targetId);
  if (!target) {
    return { ok: false, message: PRINTER_NOT_FOUND_MESSAGE };
  }
  return { ok: true, printerIds, targetId };
}

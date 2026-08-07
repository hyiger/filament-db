import { describe, it, expect, vi } from "vitest";
import mongoose from "mongoose";
import {
  validateNozzlePrinterAssignment,
  MULTI_PRINTER_MESSAGE,
  INVALID_PRINTER_ID_MESSAGE,
  PRINTER_NOT_FOUND_MESSAGE,
} from "@/lib/nozzlePrinterAssignment";

/**
 * GH #1083 — the shared printerIds validation used by BOTH nozzle routes
 * (POST /api/nozzles + PUT /api/nozzles/{id}). Pure unit coverage; the
 * route-level behaviour (no nozzle committed on a rejected assignment,
 * install on the happy path) lives in tests/nozzles-route.test.ts.
 */
describe("validateNozzlePrinterAssignment (#1083)", () => {
  const oid = () => new mongoose.Types.ObjectId().toString();

  it("passes through a non-array as 'field not sent' (printerIds undefined)", async () => {
    const find = vi.fn();
    for (const raw of [undefined, null, "abc", { 0: "x" }, 42]) {
      const res = await validateNozzlePrinterAssignment(raw, find);
      expect(res).toEqual({ ok: true, printerIds: undefined, targetId: null });
    }
    expect(find).not.toHaveBeenCalled();
  });

  it("accepts an empty array (clear-assignment semantics) without a lookup", async () => {
    const find = vi.fn();
    const res = await validateNozzlePrinterAssignment([], find);
    expect(res).toEqual({ ok: true, printerIds: [], targetId: null });
    expect(find).not.toHaveBeenCalled();
  });

  it("rejects two distinct printers with the one-printer message, no lookup", async () => {
    const find = vi.fn();
    const res = await validateNozzlePrinterAssignment([oid(), oid()], find);
    expect(res).toEqual({ ok: false, message: MULTI_PRINTER_MESSAGE });
    expect(find).not.toHaveBeenCalled();
  });

  it("#912: dedupes a duplicated single printer instead of rejecting it", async () => {
    const id = oid();
    const find = vi.fn().mockResolvedValue({ _id: id });
    const res = await validateNozzlePrinterAssignment([id, id], find);
    expect(res).toEqual({ ok: true, printerIds: [id], targetId: id });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(id);
  });

  it("String()-coerces entries before dedupe (ObjectId instances collapse)", async () => {
    const hex = oid();
    const find = vi.fn().mockResolvedValue({ _id: hex });
    // Two DISTINCT ObjectId instances with the same hex — byte-different
    // objects, same String() form — must dedupe to one target.
    const res = await validateNozzlePrinterAssignment(
      [new mongoose.Types.ObjectId(hex), new mongoose.Types.ObjectId(hex)],
      find,
    );
    expect(res).toEqual({ ok: true, printerIds: [hex], targetId: hex });
  });

  it("rejects an entry that is not a valid ObjectId, no lookup", async () => {
    const find = vi.fn();
    const res = await validateNozzlePrinterAssignment(["not-an-id"], find);
    expect(res).toEqual({ ok: false, message: INVALID_PRINTER_ID_MESSAGE });
    expect(find).not.toHaveBeenCalled();
  });

  it("rejects a valid-looking id whose printer does not exist / is deleted", async () => {
    const find = vi.fn().mockResolvedValue(null);
    const id = oid();
    const res = await validateNozzlePrinterAssignment([id], find);
    expect(res).toEqual({ ok: false, message: PRINTER_NOT_FOUND_MESSAGE });
    expect(find).toHaveBeenCalledWith(id);
  });

  it("accepts a single live printer and returns it as the target", async () => {
    const id = oid();
    const find = vi.fn().mockResolvedValue({ _id: id });
    const res = await validateNozzlePrinterAssignment([id], find);
    expect(res).toEqual({ ok: true, printerIds: [id], targetId: id });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import {
  findSpoolSlot,
  assignSpoolToSlot,
  clearSpoolsFromOtherPrinters,
  findInvalidSlotSpoolRef,
} from "@/lib/spoolSlots";
import {
  GET as getAssignment,
  PUT as putAssignment,
  DELETE as deleteAssignment,
} from "@/app/api/spools/[spoolId]/assignment/route";
import { PUT as updatePrinter } from "@/app/api/printers/[id]/route";

/**
 * GH #242 — surfacing a spool's printer-slot assignment.
 *
 * Covers src/lib/spoolSlots.ts (reverse lookup + one-slot enforcement),
 * the /api/spools/[spoolId]/assignment route, and the printer-write
 * reconciliation that keeps the one-slot invariant true regardless of
 * which form did the write.
 */
describe("spool ↔ printer-slot assignment (GH #242)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const printerMod = await import("@/models/Printer");
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.Filament) mongoose.model("Filament", filamentMod.default.schema);
    Printer = mongoose.models.Printer;
    Filament = mongoose.models.Filament;
  });

  /** Build the (request, ctx) tuple a route handler expects. */
  function req(
    spoolId: mongoose.Types.ObjectId | string,
    method: "GET" | "PUT" | "DELETE",
    body?: unknown,
  ) {
    return [
      new NextRequest(`http://localhost/api/spools/${spoolId}/assignment`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }),
      { params: Promise.resolve({ spoolId: String(spoolId) }) },
    ] as const;
  }

  describe("spoolSlots helpers", () => {
    it("findSpoolSlot resolves an assigned spool to its printer + slot", async () => {
      const spoolId = new mongoose.Types.ObjectId();
      const otherSpool = new mongoose.Types.ObjectId();
      const printer = await Printer.create({
        name: "X1C",
        manufacturer: "Bambu",
        printerModel: "X1C",
        amsSlots: [
          { slotName: "Slot 1", spoolId: otherSpool },
          { slotName: "Slot 2", spoolId },
        ],
      });

      const found = await findSpoolSlot(Printer, spoolId);
      expect(found).not.toBeNull();
      expect(found!.printerId).toBe(String(printer._id));
      expect(found!.printerName).toBe("X1C");
      expect(found!.slotName).toBe("Slot 2");
      expect(found!.filamentId).toBeNull();
    });

    it("findSpoolSlot returns null when the spool is in no slot", async () => {
      await Printer.create({
        name: "Empty",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1" }],
      });
      expect(await findSpoolSlot(Printer, new mongoose.Types.ObjectId())).toBeNull();
    });

    it("findSpoolSlot ignores soft-deleted printers", async () => {
      const spoolId = new mongoose.Types.ObjectId();
      await Printer.create({
        name: "Trashed",
        manufacturer: "X",
        printerModel: "P",
        _deletedAt: new Date(),
        amsSlots: [{ slotName: "S1", spoolId }],
      });
      expect(await findSpoolSlot(Printer, spoolId)).toBeNull();
    });

    it("findSpoolSlot reports the slot's filamentId when present", async () => {
      const spoolId = new mongoose.Types.ObjectId();
      const filamentId = new mongoose.Types.ObjectId();
      await Printer.create({
        name: "P",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1", spoolId, filamentId }],
      });
      const found = await findSpoolSlot(Printer, spoolId);
      expect(found!.filamentId).toBe(String(filamentId));
    });

    it("assignSpoolToSlot puts the spool in the target slot", async () => {
      const spoolId = new mongoose.Types.ObjectId();
      const printer = await Printer.create({
        name: "P",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1" }],
      });
      await assignSpoolToSlot(Printer, spoolId, {
        printerId: String(printer._id),
        slotId: String(printer.amsSlots[0]._id),
      });
      const fresh = await Printer.findById(printer._id);
      expect(String(fresh.amsSlots[0].spoolId)).toBe(String(spoolId));
    });

    it("assignSpoolToSlot enforces one slot per spool — moving clears the old slot", async () => {
      const spoolId = new mongoose.Types.ObjectId();
      const a = await Printer.create({
        name: "A",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1", spoolId }],
      });
      const b = await Printer.create({
        name: "B",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1" }],
      });
      await assignSpoolToSlot(Printer, spoolId, {
        printerId: String(b._id),
        slotId: String(b.amsSlots[0]._id),
      });
      expect((await Printer.findById(a._id)).amsSlots[0].spoolId).toBeNull();
      expect(String((await Printer.findById(b._id)).amsSlots[0].spoolId)).toBe(
        String(spoolId),
      );
    });

    it("assignSpoolToSlot(null) clears the spool everywhere and is idempotent", async () => {
      const spoolId = new mongoose.Types.ObjectId();
      const printer = await Printer.create({
        name: "P",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1", spoolId }],
      });
      await assignSpoolToSlot(Printer, spoolId, null);
      expect((await Printer.findById(printer._id)).amsSlots[0].spoolId).toBeNull();
      // A second clear on an already-unassigned spool must not throw.
      await assignSpoolToSlot(Printer, spoolId, null);
      expect((await Printer.findById(printer._id)).amsSlots[0].spoolId).toBeNull();
    });

    it("assignSpoolToSlot self-heals a spool wrongly present in two slots", async () => {
      const spoolId = new mongoose.Types.ObjectId();
      const printer = await Printer.create({
        name: "P",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [
          { slotName: "S1", spoolId },
          { slotName: "S2", spoolId },
        ],
      });
      await assignSpoolToSlot(Printer, spoolId, {
        printerId: String(printer._id),
        slotId: String(printer.amsSlots[1]._id),
      });
      const fresh = await Printer.findById(printer._id);
      expect(fresh.amsSlots[0].spoolId).toBeNull();
      expect(String(fresh.amsSlots[1].spoolId)).toBe(String(spoolId));
    });

    it("clearSpoolsFromOtherPrinters clears all but the excepted printer", async () => {
      const spoolId = new mongoose.Types.ObjectId();
      const keep = await Printer.create({
        name: "Keep",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1", spoolId }],
      });
      const other = await Printer.create({
        name: "Other",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1", spoolId }],
      });
      await clearSpoolsFromOtherPrinters(Printer, [spoolId], keep._id);
      expect(String((await Printer.findById(keep._id)).amsSlots[0].spoolId)).toBe(
        String(spoolId),
      );
      expect((await Printer.findById(other._id)).amsSlots[0].spoolId).toBeNull();
    });

    it("clearSpoolsFromOtherPrinters is a no-op for an empty id list", async () => {
      const spoolId = new mongoose.Types.ObjectId();
      const printer = await Printer.create({
        name: "P",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1", spoolId }],
      });
      await clearSpoolsFromOtherPrinters(Printer, [], printer._id);
      expect(String((await Printer.findById(printer._id)).amsSlots[0].spoolId)).toBe(
        String(spoolId),
      );
    });
  });

  describe("findInvalidSlotSpoolRef slot labelling (GH #631)", () => {
    it("labels an offending slot by its slotName when present", async () => {
      // Named slot with an invalid ObjectId — the message quotes the name.
      const msg = await findInvalidSlotSpoolRef(Filament, [
        { slotName: "AMS Slot A", spoolId: "not-an-object-id" },
      ]);
      expect(msg).toBe('Slot "AMS Slot A": spoolId is not a valid id');
    });

    it("falls back to a positional #N label when the slot has no name", async () => {
      // Nameless slot (missing slotName) with an invalid spoolId — the label
      // branch takes the `#${i + 1}` positional form for the SECOND slot.
      const msg = await findInvalidSlotSpoolRef(Filament, [
        { slotName: "First", spoolId: null }, // empty — skipped
        { spoolId: "not-an-object-id" }, // nameless, index 1 -> "#2"
      ]);
      expect(msg).toBe("Slot #2: spoolId is not a valid id");
    });

    it("falls back to #N when slotName is an empty string", async () => {
      // Empty-string slotName is falsy, so the ternary also picks #N.
      const msg = await findInvalidSlotSpoolRef(Filament, [
        { slotName: "", spoolId: "not-an-object-id" },
      ]);
      expect(msg).toBe("Slot #1: spoolId is not a valid id");
    });

    it("returns null when every slot ref is valid and non-retired", async () => {
      const fil = await Filament.create({
        name: "Slot ref PLA",
        vendor: "V",
        type: "PLA",
        spools: [{ label: "S" }],
      });
      const msg = await findInvalidSlotSpoolRef(Filament, [
        { slotName: "S1" }, // empty slot
        { slotName: "S2", spoolId: String(fil.spools[0]._id) },
      ]);
      expect(msg).toBeNull();
    });

    it("passes non-array input through as valid", async () => {
      expect(await findInvalidSlotSpoolRef(Filament, null)).toBeNull();
      expect(await findInvalidSlotSpoolRef(Filament, undefined)).toBeNull();
    });
  });

  describe("GET/PUT/DELETE /api/spools/[spoolId]/assignment", () => {
    async function makeSpool(filamentName: string) {
      const fil = await Filament.create({
        name: filamentName,
        vendor: "V",
        type: "PLA",
        spools: [{ label: "S" }],
      });
      return { filament: fil, spoolId: fil.spools[0]._id };
    }

    it("GET returns a null assignment for an unassigned spool", async () => {
      const { spoolId } = await makeSpool("PLA unassigned");
      const res = await getAssignment(...req(spoolId, "GET"));
      expect(res.status).toBe(200);
      expect((await res.json()).assignment).toBeNull();
    });

    it("GET returns the assignment for a spool in a slot", async () => {
      const { spoolId } = await makeSpool("PLA assigned");
      await Printer.create({
        name: "X1C",
        manufacturer: "Bambu",
        printerModel: "X1C",
        amsSlots: [{ slotName: "Slot 1", spoolId }],
      });
      const res = await getAssignment(...req(spoolId, "GET"));
      const body = await res.json();
      expect(body.assignment.slotName).toBe("Slot 1");
      expect(body.assignment.printerName).toBe("X1C");
    });

    it("GET returns 400 for an invalid spool id", async () => {
      const res = await getAssignment(...req("not-an-id", "GET"));
      expect(res.status).toBe(400);
    });

    it("PUT assigns the spool to a slot", async () => {
      const { spoolId } = await makeSpool("PLA put");
      const printer = await Printer.create({
        name: "P",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1" }],
      });
      const res = await putAssignment(
        ...req(spoolId, "PUT", {
          printerId: String(printer._id),
          slotId: String(printer.amsSlots[0]._id),
        }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).assignment.printerName).toBe("P");
      expect(
        String((await Printer.findById(printer._id)).amsSlots[0].spoolId),
      ).toBe(String(spoolId));
    });

    it("PUT moves the spool, clearing its previous slot", async () => {
      const { spoolId } = await makeSpool("PLA move");
      const a = await Printer.create({
        name: "A",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1", spoolId }],
      });
      const b = await Printer.create({
        name: "B",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1" }],
      });
      const res = await putAssignment(
        ...req(spoolId, "PUT", {
          printerId: String(b._id),
          slotId: String(b.amsSlots[0]._id),
        }),
      );
      expect(res.status).toBe(200);
      expect((await Printer.findById(a._id)).amsSlots[0].spoolId).toBeNull();
      expect(String((await Printer.findById(b._id)).amsSlots[0].spoolId)).toBe(
        String(spoolId),
      );
    });

    it("PUT returns 404 when the printer or slot does not exist", async () => {
      const { spoolId } = await makeSpool("PLA no-printer");
      const res = await putAssignment(
        ...req(spoolId, "PUT", {
          printerId: String(new mongoose.Types.ObjectId()),
          slotId: String(new mongoose.Types.ObjectId()),
        }),
      );
      expect(res.status).toBe(404);
    });

    it("PUT returns 400 on a malformed body", async () => {
      const { spoolId } = await makeSpool("PLA bad-body");
      const res = await putAssignment(...req(spoolId, "PUT", { printerId: "" }));
      expect(res.status).toBe(400);
    });

    it("PUT returns 400 when the spool is retired", async () => {
      const fil = await Filament.create({
        name: "PLA retired",
        vendor: "V",
        type: "PLA",
        spools: [{ label: "S", retired: true }],
      });
      const printer = await Printer.create({
        name: "P",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1" }],
      });
      const res = await putAssignment(
        ...req(fil.spools[0]._id, "PUT", {
          printerId: String(printer._id),
          slotId: String(printer.amsSlots[0]._id),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("PUT returns 404 for a spool that does not exist", async () => {
      const printer = await Printer.create({
        name: "P",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1" }],
      });
      const res = await putAssignment(
        ...req(new mongoose.Types.ObjectId(), "PUT", {
          printerId: String(printer._id),
          slotId: String(printer.amsSlots[0]._id),
        }),
      );
      expect(res.status).toBe(404);
    });

    it("DELETE clears the spool from its slot", async () => {
      const { spoolId } = await makeSpool("PLA delete");
      const printer = await Printer.create({
        name: "P",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1", spoolId }],
      });
      const res = await deleteAssignment(...req(spoolId, "DELETE"));
      expect(res.status).toBe(200);
      expect((await res.json()).assignment).toBeNull();
      expect((await Printer.findById(printer._id)).amsSlots[0].spoolId).toBeNull();
    });

    it("DELETE is idempotent for an unassigned spool", async () => {
      const { spoolId } = await makeSpool("PLA delete-noop");
      const res = await deleteAssignment(...req(spoolId, "DELETE"));
      expect(res.status).toBe(200);
    });
  });

  describe("printer-write reconciliation", () => {
    it("saving a printer with a spool clears that spool from other printers", async () => {
      // GH #631: the printer PUT now validates that amsSlots[].spoolId
      // references a real, active, non-retired spool — a fabricated id
      // would be rejected with 400, so back the slot with a real spool.
      const fil = await Filament.create({
        name: "Reconciliation PLA",
        vendor: "V",
        type: "PLA",
        spools: [{ label: "S" }],
      });
      const spoolId = fil.spools[0]._id;
      const a = await Printer.create({
        name: "A",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1", spoolId }],
      });
      const b = await Printer.create({
        name: "B",
        manufacturer: "X",
        printerModel: "P",
        amsSlots: [{ slotName: "S1" }],
      });

      const res = await updatePrinter(
        new NextRequest(`http://localhost/api/printers/${b._id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            amsSlots: [{ slotName: "S1", spoolId: String(spoolId) }],
          }),
        }),
        { params: Promise.resolve({ id: String(b._id) }) },
      );
      expect(res.status).toBe(200);
      expect((await Printer.findById(a._id)).amsSlots[0].spoolId).toBeNull();
      expect(String((await Printer.findById(b._id)).amsSlots[0].spoolId)).toBe(
        String(spoolId),
      );
    });

    it("saving a legacy printer with no amsSlots field does not throw", async () => {
      // Printer documents created before the amsSlots schema field existed
      // come back from a lean query without it — the reconciliation must
      // not assume the array is present.
      const inserted = await Printer.collection.insertOne({
        name: "Legacy printer",
        manufacturer: "X",
        printerModel: "P",
        _deletedAt: null,
      });
      const res = await updatePrinter(
        new NextRequest(`http://localhost/api/printers/${inserted.insertedId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ notes: "touched" }),
        }),
        { params: Promise.resolve({ id: String(inserted.insertedId) }) },
      );
      expect(res.status).toBe(200);
    });
  });
});

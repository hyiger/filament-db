import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { PUT, DELETE } from "@/app/api/filaments/[id]/route";
import { POST as createFilament } from "@/app/api/filaments/route";

/**
 * Security batch B — mass-assignment / data-integrity hardening.
 *   #260 — PUT /api/filaments/{id} must not write the `spools` array.
 *   #261 — deleting a filament must clear its spools from printer slots.
 *   #619 — POST/PUT must not write the server-owned `openprinttagSnapshot`.
 */
describe("mass-assignment & data-integrity hardening", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Printer: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const prtMod = await import("@/models/Nozzle");
    const printerMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", prtMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    Filament = mongoose.models.Filament;
    Printer = mongoose.models.Printer;
  });

  function jsonReq(url: string, body: unknown, method: string) {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── #260: PUT must not mass-assign the spools array ─────────────────

  it("#260 — PUT /api/filaments/{id} ignores a spools array in the body", async () => {
    const f = await Filament.create({
      name: "PUT Guard PLA",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "Original", totalWeight: 1000 }],
    });
    const spoolId = String(f.spools[0]._id);

    const res = await PUT(
      jsonReq(
        `http://localhost/api/filaments/${f._id}`,
        {
          name: "PUT Guard PLA",
          vendor: "T",
          type: "PLA",
          // Attempt to rewrite the spool ledger via the filament PUT.
          spools: [
            {
              _id: spoolId,
              label: "HACKED",
              totalWeight: 5,
              usageHistory: [{ grams: 999, jobLabel: "fabricated", source: "manual" }],
            },
          ],
        },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);

    // The spool is untouched — the PUT stripped `spools`.
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].label).toBe("Original");
    expect(fresh.spools[0].totalWeight).toBe(1000);
    expect(fresh.spools[0].usageHistory ?? []).toHaveLength(0);
  });

  // ── #261: deleting a filament clears its spools from printer slots ──

  it("#261 — soft-deleting a filament clears its spools from printer AMS slots", async () => {
    const f = await Filament.create({
      name: "Slot Owner PLA",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "Loaded", totalWeight: 1000 }],
    });
    const spoolId = String(f.spools[0]._id);
    const printer = await Printer.create({
      name: "MK4-A",
      manufacturer: "Prusa",
      printerModel: "MK4",
      amsSlots: [{ slotName: "Slot 1", spoolId }],
    });

    const res = await DELETE(
      new NextRequest(`http://localhost/api/filaments/${f._id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);

    const freshPrinter = await Printer.findById(printer._id);
    expect(freshPrinter.amsSlots[0].spoolId).toBeNull();
  });

  it("#261 — permanently deleting a trashed filament clears its slot refs", async () => {
    // A filament already in the trash, with a spool still loaded in a
    // slot (the pre-fix orphan state).
    const f = await Filament.create({
      name: "Trashed Slot Owner",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "Loaded", totalWeight: 1000 }],
      _deletedAt: new Date(),
    });
    const spoolId = String(f.spools[0]._id);
    const printer = await Printer.create({
      name: "MK4-B",
      manufacturer: "Prusa",
      printerModel: "MK4",
      amsSlots: [{ slotName: "Slot 1", spoolId }],
    });

    const res = await DELETE(
      new NextRequest(
        `http://localhost/api/filaments/${f._id}?permanent=true`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);

    const freshPrinter = await Printer.findById(printer._id);
    expect(freshPrinter.amsSlots[0].spoolId).toBeNull();
  });

  // ── #619: openprinttagSnapshot is server-owned OPT provenance ────────

  it("#619 — PUT /api/filaments/{id} ignores openprinttagSnapshot in the body", async () => {
    const f = await Filament.create({
      name: "OPT Provenance PLA",
      vendor: "T",
      type: "PLA",
      openprinttagSnapshot: { color: "#112233", density: 1.24 },
    });

    const res = await PUT(
      jsonReq(
        `http://localhost/api/filaments/${f._id}`,
        {
          name: "OPT Provenance PLA",
          vendor: "T",
          type: "PLA",
          // Attempt to forge the provenance store so user-edited fields
          // would classify as `adopt` (pre-checked) on the next re-sync.
          openprinttagSnapshot: { color: "#FFFFFF", density: 9.99 },
        },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);

    const fresh = await Filament.findById(f._id);
    expect(fresh.openprinttagSnapshot).toEqual({ color: "#112233", density: 1.24 });
  });

  it("#619 — POST /api/filaments ignores openprinttagSnapshot in the body", async () => {
    const res = await createFilament(
      jsonReq(
        "http://localhost/api/filaments",
        {
          name: "Forged Snapshot PLA",
          vendor: "T",
          type: "PLA",
          openprinttagSnapshot: { color: "#000000" },
        },
        "POST",
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const fresh = await Filament.findById(body._id);
    expect(fresh.openprinttagSnapshot).toBeNull();
  });

  // ── GH #605 round 10: the durable promotion-marker pair is server-owned ──
  //
  // promotionInFlight (parent side) + promotedByToken (copy side) are the
  // PROOF a promotion resume requires. A client-forged pair could make a
  // later gate pass "resume" a promotion that never ran — clearing a
  // parent's color/colorName/spools/totalWeight with no sibling receiving
  // them. Only src/lib/promoteParent.ts may write them. (The import paths
  // are covered structurally: the atlas import copies through the GH #255
  // allow-list, which lists neither field; the CSV importer maps named
  // columns; the shared-catalog import posts through this same POST
  // handler.)

  it("#605 r10 — POST /api/filaments ignores promotionInFlight/promotedByToken (exact and dotted keys)", async () => {
    const res = await createFilament(
      jsonReq(
        "http://localhost/api/filaments",
        {
          name: "Forged Marker PLA",
          vendor: "T",
          type: "PLA",
          promotionInFlight: { token: "forged", at: new Date().toISOString() },
          promotedByToken: "forged",
          "promotionInFlight.token": "forged-dotted",
        },
        "POST",
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const fresh = await Filament.findById(body._id).lean();
    expect(fresh.promotionInFlight ?? null).toBeNull();
    expect(fresh.promotedByToken ?? null).toBeNull();
  });

  it("#605 r10 — PUT /api/filaments/{id} ignores promotionInFlight/promotedByToken (exact and dotted keys)", async () => {
    const f = await Filament.create({
      name: "Marker Guard PLA",
      vendor: "T",
      type: "PLA",
    });

    const res = await PUT(
      jsonReq(
        `http://localhost/api/filaments/${f._id}`,
        {
          name: "Marker Guard PLA",
          vendor: "T",
          type: "PLA",
          promotionInFlight: { token: "forged", at: new Date().toISOString() },
          promotedByToken: "forged",
          // Dotted keys are LIVE update paths in findOneAndUpdate — the
          // sweep must drop them too, not just the exact keys.
          "promotionInFlight.token": "forged-dotted",
          "promotedByToken.0": "forged-dotted",
        },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);

    const fresh = await Filament.findById(f._id).lean();
    expect(fresh.promotionInFlight ?? null).toBeNull();
    expect(fresh.promotedByToken ?? null).toBeNull();
  });

  // ── GH #1026: prototype pollution via a __proto__-dotted body key ────
  //
  // GHSA-664h-wqgq-64gw. Pre-fix, this exact request set
  // `Object.prototype.$fullPath = "__proto__"` (ENUMERABLE, so it leaked into
  // every `for...in` in the process) and 500d, on mongoose 9.5.0. The
  // `$`-operator guard did not cover it: `"__proto__.x".startsWith("$")` is
  // false. Asserting the 400 alone would NOT catch a regression where the
  // guard runs after the write — so these assert the prototype directly.

  it("#1026 — PUT rejects a __proto__-dotted key and leaves Object.prototype clean", async () => {
    const f = await Filament.create({
      name: "Proto Guard PLA",
      vendor: "T",
      type: "PLA",
      color: "#111111",
      diameter: 1.75,
    });

    const proto = Object.prototype as unknown as Record<string, unknown>;
    expect(proto.$fullPath).toBeUndefined(); // sanity: clean to start

    // request.json() parses the body, and JSON.parse creates a genuine OWN
    // "__proto__.polluted" key — a shape an object literal cannot express.
    const body = JSON.parse('{"name":"Renamed","__proto__.polluted":"yes"}');
    expect(Object.keys(body)).toContain("__proto__.polluted");

    const res = await PUT(
      jsonReq(`http://localhost:3456/api/filaments/${f._id}`, body, "PUT"),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(400);

    // The actual regression assertion — the guard must run BEFORE the
    // findOneAndUpdate that does the casting.
    expect(proto.$fullPath).toBeUndefined();
    const probe: Record<string, number> = { a: 1 };
    const seen: string[] = [];
    for (const k in probe) seen.push(k);
    expect(seen).toEqual(["a"]);

    // Rejection is atomic — the legitimate field in the same body is not applied.
    const after = await Filament.findById(f._id).lean();
    expect(after.name).toBe("Proto Guard PLA");
  });

  it("#1026 — PUT still accepts a legitimate dotted temperatures path", async () => {
    const f = await Filament.create({
      name: "Proto Guard OK PLA",
      vendor: "T",
      type: "PLA",
      color: "#222222",
      diameter: 1.75,
    });
    const res = await PUT(
      jsonReq(
        `http://localhost:3456/api/filaments/${f._id}`,
        { "temperatures.nozzle": 215 },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const after = await Filament.findById(f._id).lean();
    expect(after.temperatures.nozzle).toBe(215);
  });
});

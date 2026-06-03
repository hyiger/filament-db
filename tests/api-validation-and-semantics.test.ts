import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";

/**
 * Route-level regression guards for the validation / semantics PR
 * (#337 numeric validation, #338 import HTTP semantics, #339 spools/import
 * multipart, #340 print-history GET/PUT, #341 spool POST 201).
 *
 * These all hit real route handlers; the model-reset pattern matches the
 * other route tests in this repo (re-register the schemas in beforeEach
 * because tests/setup.ts wipes mongoose.models between tests).
 */
describe("PR A — API validation & semantics", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const nozzleMod = await import("@/models/Nozzle");
    const filamentMod = await import("@/models/Filament");
    const printerMod = await import("@/models/Printer");
    const phMod = await import("@/models/PrintHistory");
    // Re-register every model the routes under test populate from —
    // tests/setup.ts wipes mongoose.models between tests.
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozzleMod.default.schema);
    if (!mongoose.models.Filament) mongoose.model("Filament", filamentMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.PrintHistory) mongoose.model("PrintHistory", phMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  function jsonReq(url: string, body: unknown, method: "POST" | "PUT" = "POST") {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ─── #337: numeric range validation ────────────────────────────────

  describe("GH #337 — rejects physically nonsensical numeric values", () => {
    it("nozzle diameter <= 0 → 400", async () => {
      const { POST } = await import("@/app/api/nozzles/route");
      const res = await POST(jsonReq("http://localhost/api/nozzles", {
        name: "QA-Neg", diameter: -5, type: "Brass",
      }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/diameter/i);
    });

    it("nozzle diameter = 0 → 400", async () => {
      const { POST } = await import("@/app/api/nozzles/route");
      const res = await POST(jsonReq("http://localhost/api/nozzles", {
        name: "QA-Zero", diameter: 0, type: "Brass",
      }));
      expect(res.status).toBe(400);
    });

    it("filament negative diameter / density / cost → 400", async () => {
      const { POST } = await import("@/app/api/filaments/route");
      for (const bad of [
        { diameter: -1 },
        { density: -2 },
        { cost: -99 },
      ]) {
        const res = await POST(jsonReq("http://localhost/api/filaments", {
          name: `QA-Bad-${Object.keys(bad)[0]}`, vendor: "x", type: "PLA", ...bad,
        }));
        expect(res.status).toBe(400);
      }
    });

    it("filament temperatures out of range → 400", async () => {
      const { POST } = await import("@/app/api/filaments/route");
      const tooHot = await POST(jsonReq("http://localhost/api/filaments", {
        name: "QA-Hot", vendor: "x", type: "PLA",
        temperatures: { nozzle: 9999 },
      }));
      expect(tooHot.status).toBe(400);
      const negBed = await POST(jsonReq("http://localhost/api/filaments", {
        name: "QA-NegBed", vendor: "x", type: "PLA",
        temperatures: { bed: -50 },
      }));
      expect(negBed.status).toBe(400);
    });

    it("valid physical values still pass", async () => {
      const { POST } = await import("@/app/api/filaments/route");
      const res = await POST(jsonReq("http://localhost/api/filaments", {
        name: "QA-Valid", vendor: "x", type: "PLA",
        diameter: 1.75, density: 1.24, cost: 24,
        temperatures: { nozzle: 210, bed: 60 },
      }));
      expect(res.status).toBe(201);
    });
  });

  // ─── #574: inverted nozzle temperature range (min > max) ───────────

  describe("GH #574 — rejects an inverted nozzle temperature range", () => {
    it("POST with nozzleRangeMin > nozzleRangeMax → 400", async () => {
      const { POST } = await import("@/app/api/filaments/route");
      const res = await POST(jsonReq("http://localhost/api/filaments", {
        name: "QA-InvRange", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 300, nozzleRangeMax: 200 },
      }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/less than or equal to the maximum/i);
    });

    it("POST with a normal range (min <= max) still passes", async () => {
      const { POST } = await import("@/app/api/filaments/route");
      const res = await POST(jsonReq("http://localhost/api/filaments", {
        name: "QA-OkRange", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 200, nozzleRangeMax: 220 },
      }));
      expect(res.status).toBe(201);
    });

    it("POST with only one end set is not treated as inverted", async () => {
      const { POST } = await import("@/app/api/filaments/route");
      const res = await POST(jsonReq("http://localhost/api/filaments", {
        name: "QA-PartialRange", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 300 },
      }));
      expect(res.status).toBe(201);
    });

    it("PUT with nozzleRangeMin > nozzleRangeMax → 400", async () => {
      const created = await Filament.create({ name: "QA-PutInv", vendor: "x", type: "PLA" });
      const { PUT } = await import("@/app/api/filaments/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${created._id}`, {
          temperatures: { nozzleRangeMin: 250, nozzleRangeMax: 100 },
        }, "PUT"),
        { params: Promise.resolve({ id: String(created._id) }) },
      );
      expect(res.status).toBe(400);
    });

    it("POST with numeric-STRING inverted range → 400 (Codex P2 on #577)", async () => {
      const { POST } = await import("@/app/api/filaments/route");
      const res = await POST(jsonReq("http://localhost/api/filaments", {
        name: "QA-StrInv", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: "300", nozzleRangeMax: "200" },
      }));
      expect(res.status).toBe(400);
    });

    it("PUT dotted partial min that inverts against the STORED max → 400 (Codex P2 on #577)", async () => {
      const created = await Filament.create({
        name: "QA-DottedInv", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 200 },
      });
      const { PUT } = await import("@/app/api/filaments/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${created._id}`, {
          "temperatures.nozzleRangeMin": 300, // stored max is 200 → inverted
        }, "PUT"),
        { params: Promise.resolve({ id: String(created._id) }) },
      );
      expect(res.status).toBe(400);
    });

    it("PUT dotted partial min that stays valid against the stored max → 200", async () => {
      const created = await Filament.create({
        name: "QA-DottedOk", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 260 },
      });
      const { PUT } = await import("@/app/api/filaments/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${created._id}`, {
          "temperatures.nozzleRangeMin": 240, // <= stored max 260
        }, "PUT"),
        { params: Promise.resolve({ id: String(created._id) }) },
      );
      expect(res.status).toBe(200);
    });

    it("PUT $set operator partial min that inverts against the STORED max → 400 (Codex P2 r2 on #577)", async () => {
      const created = await Filament.create({
        name: "QA-SetInv", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 200 },
      });
      const { PUT } = await import("@/app/api/filaments/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${created._id}`, {
          $set: { "temperatures.nozzleRangeMin": 300 }, // stored max 200 → inverted
        }, "PUT"),
        { params: Promise.resolve({ id: String(created._id) }) },
      );
      expect(res.status).toBe(400);
    });

    it("POST a variant whose lone min inverts against the inherited parent max → 400 (Codex P2 r3 on #577)", async () => {
      const parent = await Filament.create({
        name: "QA-RangeParent", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 200 },
      });
      const { POST } = await import("@/app/api/filaments/route");
      const res = await POST(jsonReq("http://localhost/api/filaments", {
        name: "QA-RangeVariant", vendor: "x", type: "PLA",
        parentId: String(parent._id),
        temperatures: { nozzleRangeMin: 300 }, // inherits parent max 200 → inverted
      }));
      expect(res.status).toBe(400);
    });

    it("POST a variant whose lone min stays valid against the inherited parent max → 201", async () => {
      const parent = await Filament.create({
        name: "QA-RangeParentOk", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 260 },
      });
      const { POST } = await import("@/app/api/filaments/route");
      const res = await POST(jsonReq("http://localhost/api/filaments", {
        name: "QA-RangeVariantOk", vendor: "x", type: "PLA",
        parentId: String(parent._id),
        temperatures: { nozzleRangeMin: 240 }, // <= inherited parent max 260
      }));
      expect(res.status).toBe(201);
    });

    it("PUT lowering a PARENT max below an inheriting child's own min → 400 (Codex P2 r5 on #577)", async () => {
      const parent = await Filament.create({
        name: "QA-CascadeParent", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 320 },
      });
      // Child overrides only its own min to 300 (valid while parent max is 320).
      await Filament.create({
        name: "QA-CascadeChild", vendor: "x", type: "PLA",
        parentId: parent._id,
        temperatures: { nozzleRangeMin: 300 },
      });
      const { PUT } = await import("@/app/api/filaments/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${parent._id}`, {
          temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 200 }, // child inherits 200 → 300/200
        }, "PUT"),
        { params: Promise.resolve({ id: String(parent._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/inheriting variant/i);
    });

    it("PUT lowering a PARENT max that stays valid for all children → 200", async () => {
      const parent = await Filament.create({
        name: "QA-CascadeParentOk", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 320 },
      });
      await Filament.create({
        name: "QA-CascadeChildOk", vendor: "x", type: "PLA",
        parentId: parent._id,
        temperatures: { nozzleRangeMin: 210 },
      });
      const { PUT } = await import("@/app/api/filaments/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${parent._id}`, {
          temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 250 }, // child 210 <= 250
        }, "PUT"),
        { params: Promise.resolve({ id: String(parent._id) }) },
      );
      expect(res.status).toBe(200);
    });

    it("PUT rejects a Mongo update operator body ($set) → 400 (Codex P2 r5 on #577)", async () => {
      // Operator bodies would slip past the field-level guards (range,
      // parentId re-parent). The renderer never sends them; reject outright.
      const created = await Filament.create({ name: "QA-OpReject", vendor: "x", type: "PLA" });
      const { PUT } = await import("@/app/api/filaments/[id]/route");
      for (const opBody of [
        { $set: { "temperatures.nozzleRangeMin": 300, "temperatures.nozzleRangeMax": 200 } },
        { $set: { parentId: "ffffffffffffffffffffffff" } },
      ]) {
        const res = await PUT(
          jsonReq(`http://localhost/api/filaments/${created._id}`, opBody, "PUT"),
          { params: Promise.resolve({ id: String(created._id) }) },
        );
        expect(res.status).toBe(400);
      }
    });

    it("PUT re-parent only (no range field) that inverts the stored min against the NEW parent max → 400 (Codex P2 r4 on #577)", async () => {
      const oldParent = await Filament.create({
        name: "QA-RP-Old", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 320 },
      });
      const newParent = await Filament.create({
        name: "QA-RP-New", vendor: "x", type: "PLA",
        temperatures: { nozzleRangeMin: 180, nozzleRangeMax: 200 },
      });
      // Variant overrides only its own min to 300 (valid under oldParent's 320).
      const variant = await Filament.create({
        name: "QA-RP-Variant", vendor: "x", type: "PLA",
        parentId: oldParent._id,
        temperatures: { nozzleRangeMin: 300 },
      });
      const { PUT } = await import("@/app/api/filaments/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/filaments/${variant._id}`, {
          parentId: String(newParent._id), // stored min 300 + new parent max 200 → inverted
        }, "PUT"),
        { params: Promise.resolve({ id: String(variant._id) }) },
      );
      expect(res.status).toBe(400);
    });
  });

  // ─── #338: import endpoints 400 (not 500) on wrong content-type ────

  describe("GH #338 — import endpoints reject non-multipart with 400", () => {
    async function postText(route: { POST: (r: NextRequest) => Promise<Response> }, url: string) {
      const req = new NextRequest(url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "definitely not multipart",
      });
      return route.POST(req);
    }

    it("/api/filaments/parse-ini → 400", async () => {
      const route = await import("@/app/api/filaments/parse-ini/route");
      const res = await postText(route, "http://localhost/api/filaments/parse-ini");
      expect(res.status).toBe(400);
    });
    it("/api/filaments/import → 400", async () => {
      const route = await import("@/app/api/filaments/import/route");
      const res = await postText(route, "http://localhost/api/filaments/import");
      expect(res.status).toBe(400);
    });
    it("/api/filaments/import-csv → 400", async () => {
      const route = await import("@/app/api/filaments/import-csv/route");
      const res = await postText(route, "http://localhost/api/filaments/import-csv");
      expect(res.status).toBe(400);
    });
    it("/api/filaments/import-xlsx → 400", async () => {
      const route = await import("@/app/api/filaments/import-xlsx/route");
      const res = await postText(route, "http://localhost/api/filaments/import-xlsx");
      expect(res.status).toBe(400);
    });
  });

  // ─── #339: spools/import accepts multipart uploads ────────────────

  describe("GH #339 — /api/spools/import handles multipart/form-data uploads", () => {
    it("parses a multipart CSV upload (raw fallback used to mis-parse the MIME envelope)", async () => {
      // Pre-create a matching filament so the row resolves.
      await Filament.create({
        name: "QA Mat", vendor: "QA", type: "PLA", diameter: 1.75,
      });

      const { POST } = await import("@/app/api/spools/import/route");
      const csv = "filament,vendor,label,totalWeight\nQA Mat,QA,QA Spool,1000\n";
      const form = new FormData();
      form.append("file", new File([csv], "spools.csv", { type: "text/csv" }));
      const req = new NextRequest("http://localhost/api/spools/import", {
        method: "POST",
        body: form,
      });
      const res = await POST(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.imported).toBe(1);
      expect(body.failed).toBe(0);
    });

    it("multipart without a 'file' field → 400 with a clear message", async () => {
      const { POST } = await import("@/app/api/spools/import/route");
      const form = new FormData();
      form.append("notfile", "x");
      const req = new NextRequest("http://localhost/api/spools/import", {
        method: "POST",
        body: form,
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/file/i);
    });
  });

  // ─── #340: print-history GET-by-id + PUT ──────────────────────────

  describe("GH #340 — /api/print-history/[id] GET + PUT", () => {
    async function makeJob() {
      const fil = await Filament.create({
        name: "PH Mat", vendor: "QA", type: "PLA", diameter: 1.75,
        netFilamentWeight: 1000, spoolWeight: 200,
      });
      // push a spool so the POST has somewhere to deduct from
      fil.spools.push({ label: "S1", totalWeight: 1000 });
      await fil.save();
      const spoolId = fil.spools[0]._id.toString();

      const { POST: createJob } = await import("@/app/api/print-history/route");
      const res = await createJob(jsonReq("http://localhost/api/print-history", {
        jobLabel: "Original label",
        notes: "first notes",
        usage: [{ filamentId: fil._id.toString(), spoolId, grams: 25 }],
      }));
      expect(res.status).toBe(201);
      return await res.json();
    }

    it("GET returns the entry", async () => {
      const job = await makeJob();
      const { GET } = await import("@/app/api/print-history/[id]/route");
      const res = await GET(
        new NextRequest(`http://localhost/api/print-history/${job._id}`),
        { params: Promise.resolve({ id: job._id }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobLabel).toBe("Original label");
    });

    it("GET on a bad id → 400", async () => {
      const { GET } = await import("@/app/api/print-history/[id]/route");
      const res = await GET(
        new NextRequest("http://localhost/api/print-history/not-an-id"),
        { params: Promise.resolve({ id: "not-an-id" }) },
      );
      expect(res.status).toBe(400);
    });

    it("GET on a missing id → 404", async () => {
      const { GET } = await import("@/app/api/print-history/[id]/route");
      const missing = "000000000000000000000000";
      const res = await GET(
        new NextRequest(`http://localhost/api/print-history/${missing}`),
        { params: Promise.resolve({ id: missing }) },
      );
      expect(res.status).toBe(404);
    });

    it("PUT updates jobLabel and notes; spool weight is untouched", async () => {
      const job = await makeJob();
      const { PUT } = await import("@/app/api/print-history/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/print-history/${job._id}`, {
          jobLabel: "Edited label", notes: "edited notes",
        }, "PUT"),
        { params: Promise.resolve({ id: job._id }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobLabel).toBe("Edited label");
      expect(body.notes).toBe("edited notes");

      // spool weight should still be the post-charge value (1000 - 25 = 975)
      const fil = await Filament.findById(body.usage[0].filamentId).lean();
      const spool = fil.spools[0];
      expect(spool.totalWeight).toBe(975);
    });

    it("PUT rejects usage[] edits with 400", async () => {
      const job = await makeJob();
      const { PUT } = await import("@/app/api/print-history/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/print-history/${job._id}`, {
          jobLabel: "x", usage: [{ filamentId: job.usage[0].filamentId, grams: 999 }],
        }, "PUT"),
        { params: Promise.resolve({ id: job._id }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/usage/i);
    });

    it("PUT rejects unknown fields with 400", async () => {
      const job = await makeJob();
      const { PUT } = await import("@/app/api/print-history/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/print-history/${job._id}`, {
          jobLabel: "x", _purged: true,
        }, "PUT"),
        { params: Promise.resolve({ id: job._id }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/_purged/);
    });

    it("PUT caps notes at 2000 chars (mirrors POST guard, Codex P2 on PR #350)", async () => {
      const job = await makeJob();
      const { PUT } = await import("@/app/api/print-history/[id]/route");
      const huge = "x".repeat(5000);
      const res = await PUT(
        jsonReq(`http://localhost/api/print-history/${job._id}`, {
          notes: huge,
        }, "PUT"),
        { params: Promise.resolve({ id: job._id }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.notes.length).toBe(2000);
    });

    it("PUT caps jobLabel at 200 chars (mirrors POST guard)", async () => {
      const job = await makeJob();
      const { PUT } = await import("@/app/api/print-history/[id]/route");
      const huge = "L".repeat(500);
      const res = await PUT(
        jsonReq(`http://localhost/api/print-history/${job._id}`, {
          jobLabel: huge,
        }, "PUT"),
        { params: Promise.resolve({ id: job._id }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobLabel.length).toBe(200);
    });

    it("PUT with empty body → 400", async () => {
      const job = await makeJob();
      const { PUT } = await import("@/app/api/print-history/[id]/route");
      const res = await PUT(
        jsonReq(`http://localhost/api/print-history/${job._id}`, {}, "PUT"),
        { params: Promise.resolve({ id: job._id }) },
      );
      expect(res.status).toBe(400);
    });

  });

  // ─── #341: spool POST returns 201 (was 200) ───────────────────────

  describe("GH #341 — spool POST returns 201", () => {
    it("POST /api/filaments/[id]/spools → 201 on success", async () => {
      const fil = await Filament.create({
        name: "SP Mat", vendor: "QA", type: "PLA", diameter: 1.75,
      });
      const { POST } = await import("@/app/api/filaments/[id]/spools/route");
      const res = await POST(
        jsonReq(`http://localhost/api/filaments/${fil._id}/spools`, {
          label: "S1", totalWeight: 1000,
        }),
        { params: Promise.resolve({ id: fil._id.toString() }) },
      );
      expect(res.status).toBe(201);
    });
  });
});

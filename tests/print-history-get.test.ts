import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listPrintHistory } from "@/app/api/print-history/route";

/**
 * GET /api/print-history coverage. The existing print-history.test.ts focuses
 * on POST + DELETE (job logging + undo). The GET endpoint supports
 * ?filamentId, ?printerId, and ?limit (default 100, max 1000), and silent
 * regressions in those filters could corrupt analytics — this file covers
 * the filter paths.
 */
describe("GET /api/print-history", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PrintHistory: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Nozzle: any;

  beforeEach(async () => {
    const phMod = await import("@/models/PrintHistory");
    const fMod = await import("@/models/Filament");
    const pMod = await import("@/models/Printer");
    const nMod = await import("@/models/Nozzle");
    if (!mongoose.models.PrintHistory)
      mongoose.model("PrintHistory", phMod.default.schema);
    if (!mongoose.models.Filament) mongoose.model("Filament", fMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", pMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nMod.default.schema);
    PrintHistory = mongoose.models.PrintHistory;
    Filament = mongoose.models.Filament;
    Printer = mongoose.models.Printer;
    Nozzle = mongoose.models.Nozzle;
  });

  function reqUrl(qs: string) {
    return new NextRequest(`http://localhost/api/print-history${qs}`);
  }

  async function seed() {
    const noz = await Nozzle.create({ name: "0.4", diameter: 0.4, type: "Brass" });
    const printerA = await Printer.create({
      name: "Printer A",
      manufacturer: "X",
      printerModel: "PA",
    });
    const printerB = await Printer.create({
      name: "Printer B",
      manufacturer: "X",
      printerModel: "PB",
    });
    const filamentA = await Filament.create({
      name: "Filament A",
      vendor: "T",
      type: "PLA",
      compatibleNozzles: [noz._id],
    });
    const filamentB = await Filament.create({
      name: "Filament B",
      vendor: "T",
      type: "PLA",
      compatibleNozzles: [noz._id],
    });

    // 3 jobs on printer A using filament A, 1 on printer B using both
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await PrintHistory.create({
        jobLabel: `A-job-${i}`,
        printerId: printerA._id,
        usage: [{ filamentId: filamentA._id, grams: 10 + i }],
        startedAt: new Date(now - i * 1000),
        source: "manual",
      });
    }
    await PrintHistory.create({
      jobLabel: "B-job-multimaterial",
      printerId: printerB._id,
      usage: [
        { filamentId: filamentA._id, grams: 5 },
        { filamentId: filamentB._id, grams: 7 },
      ],
      startedAt: new Date(now - 10_000),
      source: "manual",
    });

    return { printerA, printerB, filamentA, filamentB };
  }

  it("returns all entries sorted by startedAt desc when no filter is given", async () => {
    await seed();
    const res = await listPrintHistory(reqUrl(""));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(4);
    // Newest first
    const labels = body.map((e: { jobLabel: string }) => e.jobLabel);
    expect(labels[0]).toBe("A-job-0");
    expect(labels[labels.length - 1]).toBe("B-job-multimaterial");
  });

  it("filters by printerId", async () => {
    const { printerA } = await seed();
    const res = await listPrintHistory(reqUrl(`?printerId=${printerA._id}`));
    const body = await res.json();
    expect(body).toHaveLength(3);
    expect(body.every((e: { jobLabel: string }) => e.jobLabel.startsWith("A-job-"))).toBe(
      true,
    );
  });

  it("filters by filamentId — multi-material jobs match if any usage entry references the filament", async () => {
    const { filamentB } = await seed();
    const res = await listPrintHistory(reqUrl(`?filamentId=${filamentB._id}`));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].jobLabel).toBe("B-job-multimaterial");
  });

  it("filters by filamentId — filament A appears in both single and multi-material jobs", async () => {
    const { filamentA } = await seed();
    const res = await listPrintHistory(reqUrl(`?filamentId=${filamentA._id}`));
    const body = await res.json();
    expect(body).toHaveLength(4); // 3 A-jobs + 1 B-job that also uses A
  });

  it("respects ?limit", async () => {
    await seed();
    const res = await listPrintHistory(reqUrl("?limit=2"));
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it("clamps a too-high limit to 1000 (no crash, no unbounded query)", async () => {
    await seed();
    const res = await listPrintHistory(reqUrl("?limit=99999"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeLessThanOrEqual(1000);
  });

  it("clamps a non-positive limit to at least 1", async () => {
    await seed();
    const res = await listPrintHistory(reqUrl("?limit=0"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // limit=0 clamps to 1; we have 4 entries so we get 1
    expect(body).toHaveLength(1);
  });

  it("falls back to default limit (100) on a non-numeric ?limit", async () => {
    await seed();
    const res = await listPrintHistory(reqUrl("?limit=abc"));
    expect(res.status).toBe(200);
    // Default 100 is well over our seeded 4
    const body = await res.json();
    expect(body).toHaveLength(4);
  });

  it("excludes soft-deleted entries", async () => {
    await seed();
    const all = await PrintHistory.find({});
    // soft-delete one
    all[0]._deletedAt = new Date();
    await all[0].save();

    const res = await listPrintHistory(reqUrl(""));
    const body = await res.json();
    expect(body).toHaveLength(3);
    expect(body.some((e: { _id: string }) => e._id === String(all[0]._id))).toBe(false);
  });

  it("returns 400 (not 500) on a malformed ?filamentId (#630)", async () => {
    const res = await listPrintHistory(reqUrl("?filamentId=zzz"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/filamentId/);
  });

  it("returns 400 (not 500) on a malformed ?printerId (#630)", async () => {
    const res = await listPrintHistory(reqUrl("?printerId=not-an-objectid"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/printerId/);
  });

  it("still accepts well-formed ObjectId filters after the #630 guard", async () => {
    const { filamentA } = await seed();
    const res = await listPrintHistory(reqUrl(`?filamentId=${filamentA._id}`));
    expect(res.status).toBe(200);
  });

  it("populates printerId.name and usage.filamentId fields", async () => {
    await seed();
    const res = await listPrintHistory(reqUrl(""));
    const body = await res.json();
    const first = body[0];
    expect(first.printerId).toBeTypeOf("object");
    expect(first.printerId.name).toMatch(/Printer [AB]/);
    expect(first.usage[0].filamentId).toBeTypeOf("object");
    expect(first.usage[0].filamentId.name).toMatch(/Filament [AB]/);
  });
});

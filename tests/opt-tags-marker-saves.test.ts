import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as postPrintHistory } from "@/app/api/print-history/route";
import { DELETE as deletePrintHistory, PUT as putPrintHistory } from "@/app/api/print-history/[id]/route";
import { POST as postUsage } from "@/app/api/filaments/[id]/spools/[spoolId]/usage/route";
import { POST as restoreFilament } from "@/app/api/filaments/[id]/restore/route";
import { POST as importSpools } from "@/app/api/spools/import/route";
import { scanUnverifiedOptTags, type MinimalRenumberDb } from "@/lib/optTagRenumber";

/**
 * GH #1227 — a write that loads a filament and saves it for an unrelated
 * reason must leave an unreviewed row unreviewed.
 *
 * Before the fix, Mongoose filled the schema default `optTagsSpec: true` into
 * a pre-v1.83 row loaded through findOne() and the route's save() wrote it:
 * the legacy ids stayed unconverted, the row was read under the spec
 * numbering, and it dropped out of Data health. Each case below drives a real
 * route against such a row and checks the stored marker is still ABSENT and
 * the row is still listed for review.
 */
describe("routes that save a filament keep its numbering review open (GH #1227)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  const col = () => mongoose.connection.collection("filaments");
  const db = () => mongoose.connection.db as unknown as MinimalRenumberDb;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    const printHistoryMod = await import("@/models/PrintHistory");
    const printerMod = await import("@/models/Printer");
    const locationMod = await import("@/models/Location");
    if (!mongoose.models.Filament) mongoose.model("Filament", filamentMod.default.schema);
    if (!mongoose.models.PrintHistory) mongoose.model("PrintHistory", printHistoryMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.Location) mongoose.model("Location", locationMod.default.schema);
    Filament = mongoose.models.Filament;
    await col().deleteMany({});
  });

  /** A schema-shaped pre-v1.83 row: legacy [2] (app "transparent"), no marker. */
  async function unreviewed(name: string) {
    const f = await Filament.create({
      name,
      vendor: "QA",
      type: "PLA",
      optTags: [2],
      spoolWeight: 200,
      spools: [{ label: "roll", totalWeight: 1000 }],
    });
    await col().updateOne({ _id: f._id }, { $unset: { optTagsSpec: "" } });
    return { id: String(f._id), spoolId: String(f.spools[0]._id) };
  }

  async function expectStillUnreviewed(id: string) {
    const raw = await col().findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(raw).not.toBeNull();
    expect(raw).not.toHaveProperty("optTagsSpec");
    expect(raw!.optTags).toEqual([2]);
    const pending = await scanUnverifiedOptTags(db());
    expect(pending.map((r) => r.filamentId)).toContain(id);
  }

  const json = (url: string, method: string, body?: unknown) =>
    new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it("the model itself: a loaded row saved for another reason stays unmarked; a new row is marked", async () => {
    const { id } = await unreviewed("Model Save PLA");
    const doc = await Filament.findById(id);
    expect(doc.optTagsSpec).toBeUndefined();
    doc.spools[0].totalWeight = 900;
    await doc.save();
    await expectStillUnreviewed(id);

    const fresh = await Filament.create({ name: "Fresh PLA", vendor: "QA", type: "PLA", optTags: [20] });
    const rawFresh = await col().findOne({ _id: fresh._id });
    expect(rawFresh!.optTagsSpec).toBe(true);
  });

  it("POST /api/print-history debits the spool and leaves the row unreviewed", async () => {
    const { id } = await unreviewed("Print Job PLA");
    const res = await postPrintHistory(
      json("http://localhost/api/print-history", "POST", {
        jobLabel: "benchy",
        source: "manual",
        usage: [{ filamentId: id, grams: 50 }],
      }),
    );
    expect(res.status).toBe(201);
    const raw = await col().findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(raw!.spools[0].totalWeight).toBe(950);
    await expectStillUnreviewed(id);
  });

  it("DELETE /api/print-history/{id} refunds the spool and leaves the row unreviewed", async () => {
    const { id } = await unreviewed("Refund PLA");
    const created = await postPrintHistory(
      json("http://localhost/api/print-history", "POST", {
        jobLabel: "refund-me",
        source: "manual",
        usage: [{ filamentId: id, grams: 50 }],
      }),
    );
    expect(created.status).toBe(201);
    const job = await created.json();
    const del = await deletePrintHistory(
      new NextRequest(`http://localhost/api/print-history/${job._id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: String(job._id) }) },
    );
    expect(del.status).toBe(200);
    const raw = await col().findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(raw!.spools[0].totalWeight).toBe(1000);
    await expectStillUnreviewed(id);
  });

  it("PUT /api/print-history/{id} backfills a legacy entry's job id and leaves the row unreviewed", async () => {
    // A pre-jobId job: its spool ledger entry carries no jobId, so moving the
    // job's startedAt makes the route load the filament, stamp the id and save.
    const { id, spoolId } = await unreviewed("Edit Job PLA");
    const oldStarted = new Date("2026-01-10T12:00:00Z");
    await col().updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $push: { "spools.0.usageHistory": { grams: 50, date: oldStarted, source: "job" } } } as never,
    );
    const job = await mongoose.models.PrintHistory.create({
      jobLabel: "legacy-job",
      source: "manual",
      startedAt: oldStarted,
      usage: [{ filamentId: new mongoose.Types.ObjectId(id), spoolId: new mongoose.Types.ObjectId(spoolId), grams: 50 }],
    });
    const res = await putPrintHistory(
      json(`http://localhost/api/print-history/${job._id}`, "PUT", { startedAt: "2026-01-11T12:00:00Z" }),
      { params: Promise.resolve({ id: String(job._id) }) },
    );
    expect(res.status).toBe(200);
    const raw = await col().findOne({ _id: new mongoose.Types.ObjectId(id) });
    const entry = raw!.spools[0].usageHistory.find((h: { grams: number }) => h.grams === 50);
    expect(String(entry.jobId)).toBe(String(job._id));
    await expectStillUnreviewed(id);
  });

  it("POST .../spools/{spoolId}/usage logs usage and leaves the row unreviewed", async () => {
    const { id, spoolId } = await unreviewed("Usage PLA");
    const res = await postUsage(
      json(`http://localhost/api/filaments/${id}/spools/${spoolId}/usage`, "POST", { grams: 10 }),
      { params: Promise.resolve({ id, spoolId }) },
    );
    expect(res.status).toBe(201);
    await expectStillUnreviewed(id);
  });

  it("POST /api/filaments/{id}/restore brings the row back unreviewed", async () => {
    const { id } = await unreviewed("Restore PLA");
    await col().updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { _deletedAt: new Date() } });
    const res = await restoreFilament(
      new NextRequest(`http://localhost/api/filaments/${id}/restore`, { method: "POST" }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const raw = await col().findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(raw!._deletedAt).toBeNull();
    await expectStillUnreviewed(id);
  });

  it("POST /api/spools/import updating an existing spool leaves the row unreviewed", async () => {
    const { id, spoolId } = await unreviewed("Import PLA");
    const csv = `filament,totalWeight,spoolId\nImport PLA,800,${spoolId}\n`;
    const res = await importSpools(
      new NextRequest("http://localhost/api/spools/import", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: csv,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);
    const raw = await col().findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(raw!.spools[0].totalWeight).toBe(800);
    await expectStillUnreviewed(id);
  });
});

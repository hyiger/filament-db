import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as postPrintHistory } from "@/app/api/print-history/route";
import { POST as logUsage } from "@/app/api/filaments/[id]/spools/[spoolId]/usage/route";
import { PUT as putSpool } from "@/app/api/filaments/[id]/spools/[spoolId]/route";

/**
 * GH #1208 — a multi-filament job saves each filament under its own key and
 * releases it, so other writers can land before a later save fails. The
 * failure path used to restore every spool's PRE-JOB absolute weight from a
 * snapshot, erasing any acknowledged write in between (while that write's
 * own ledger entry survived). It now undoes exactly this job's debit,
 * relative to the current weight, keyed on the job's ledger entries.
 *
 * Every interleaving here uses the real route handlers. The only hook is a
 * patched `Model#save` that runs a step around the JOB's first save of a
 * filament; saves made by routes called inside a step pass straight through.
 */
describe("GH #1208 — failed multi-filament job undoes only its own debit", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let PrintHistory: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  type SaveFn = (this: { _id?: unknown }, ...args: unknown[]) => Promise<unknown>;
  const proto = mongoose.Model.prototype as unknown as { save: SaveFn };
  let originalSave: SaveFn;

  beforeEach(async () => {
    for (const m of ["Filament", "PrintHistory", "Printer", "Nozzle", "BedType", "Location"]) {
      delete mongoose.models[m];
    }
    Filament = (await import("@/models/Filament")).default;
    await import("@/models/Printer");
    await import("@/models/Nozzle");
    await import("@/models/BedType");
    await import("@/models/Location");
    PrintHistory = (await import("@/models/PrintHistory")).default;
    originalSave = proto.save;
  });

  afterEach(() => {
    proto.save = originalSave;
    vi.restoreAllMocks();
  });

  type Step = { before?: () => Promise<void>; after?: () => Promise<void> };

  /** Run `before`/`after` around the job's FIRST save of each planned filament.
   *  A `before` that throws fails that save, as a database error would. */
  function interceptJobSaves(plan: Record<string, Step>) {
    const seen = new Set<string>();
    let nested = 0;
    proto.save = async function (this: { _id?: unknown }, ...args: unknown[]) {
      const id = String(this._id);
      const step = plan[id];
      if (nested > 0 || !step || seen.has(id)) return originalSave.apply(this, args);
      seen.add(id);
      nested++;
      try {
        await step.before?.();
      } finally {
        nested--;
      }
      const out = await originalSave.apply(this, args);
      nested++;
      try {
        await step.after?.();
      } finally {
        nested--;
      }
      return out;
    };
  }

  const postJob = (usage: { filamentId: string; spoolId?: string; grams: number }[]) =>
    postPrintHistory(
      new NextRequest("http://localhost/api/print-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobLabel: "interleaved job", usage }),
      }),
    );

  const manualUsage = async (filamentId: unknown, spoolId: unknown, grams: number) => {
    const res = await logUsage(
      new NextRequest("http://localhost/api/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grams }),
      }),
      { params: Promise.resolve({ id: String(filamentId), spoolId: String(spoolId) }) },
    );
    expect(res.status).toBe(201);
  };

  const editSpool = async (filamentId: unknown, spoolId: unknown, patch: Record<string, unknown>) => {
    const res = await putSpool(
      new NextRequest(`http://localhost/api/filaments/${filamentId}/spools/${spoolId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
      { params: Promise.resolve({ id: String(filamentId), spoolId: String(spoolId) }) },
    );
    expect(res.status).toBe(200);
  };

  const fail = () => {
    throw new Error("simulated write failure");
  };

  const makePair = async (aSpools: object[] = [{ totalWeight: 1000 }], bSpools: object[] = [{ totalWeight: 1000 }]) => {
    const a = await Filament.create({ name: "Interleave A", vendor: "V", type: "PLA", spools: aSpools });
    const b = await Filament.create({ name: "Interleave B", vendor: "V", type: "PLA", spools: bSpools });
    return { a, b };
  };

  const spools = async (id: unknown) => (await Filament.findById(id).lean()).spools;

  it("keeps a manual usage acknowledged between the first save and the failure", async () => {
    const { a, b } = await makePair();
    interceptJobSaves({
      [String(b._id)]: {
        before: async () => {
          await manualUsage(a._id, a.spools[0]._id, 50);
          fail();
        },
      },
    });
    const res = await postJob([
      { filamentId: String(a._id), grams: 100 },
      { filamentId: String(b._id), grams: 100 },
    ]);
    expect(res.status).toBe(500);

    const [aSpool] = await spools(a._id);
    expect(aSpool.totalWeight).toBe(950); // not 1000: the manual 50 g stands
    expect(aSpool.usageHistory.map((e: { source: string; grams: number }) => [e.source, e.grams])).toEqual([
      ["manual", 50],
    ]);
    expect((await spools(b._id))[0].totalWeight).toBe(1000);
    expect(await PrintHistory.countDocuments()).toBe(0);
  });

  it("with only real routes: 409 leaves both concurrent debits, and the retry lands once", async () => {
    const { a, b } = await makePair();
    interceptJobSaves({
      // After A commits, a usage log on B moves B's version on — so the job's
      // stale B save really VersionErrors — and a usage log on A lands in
      // the window before it does.
      [String(a._id)]: { after: () => manualUsage(b._id, b.spools[0]._id, 10) },
      [String(b._id)]: { before: () => manualUsage(a._id, a.spools[0]._id, 50) },
    });
    const job = [
      { filamentId: String(a._id), grams: 100 },
      { filamentId: String(b._id), grams: 100 },
    ];
    const res = await postJob(job);
    expect(res.status).toBe(409);
    expect((await spools(a._id))[0].totalWeight).toBe(950);
    expect((await spools(b._id))[0].totalWeight).toBe(990);

    proto.save = originalSave;
    const retry = await postJob(job);
    expect(retry.status).toBe(201);
    expect((await spools(a._id))[0].totalWeight).toBe(850);
    expect((await spools(b._id))[0].totalWeight).toBe(890);
  });

  it("leaves an untouched sibling spool's concurrent edit alone", async () => {
    const { a, b } = await makePair([{ totalWeight: 1000 }, { totalWeight: 700 }]);
    interceptJobSaves({
      [String(b._id)]: {
        before: async () => {
          await editSpool(a._id, a.spools[1]._id, { totalWeight: 400 });
          fail();
        },
      },
    });
    const res = await postJob([
      { filamentId: String(a._id), grams: 100 },
      { filamentId: String(b._id), grams: 100 },
    ]);
    expect(res.status).toBe(500);
    expect((await spools(a._id)).map((s: { totalWeight: number }) => s.totalWeight)).toEqual([1000, 400]);
  });

  it("adds the debit back on top of a concurrent absolute weight edit", async () => {
    const { a, b } = await makePair();
    interceptJobSaves({
      [String(b._id)]: {
        before: async () => {
          await editSpool(a._id, a.spools[0]._id, { totalWeight: 500 });
          fail();
        },
      },
    });
    await postJob([
      { filamentId: String(a._id), grams: 100 },
      { filamentId: String(b._id), grams: 100 },
    ]);
    // The re-weigh read 500 with this job's 100 g already gone; undoing the
    // job puts that 100 g back on top.
    expect((await spools(a._id))[0].totalWeight).toBe(600);
  });

  it("pulls the entry without touching a weight a concurrent edit cleared", async () => {
    const { a, b } = await makePair();
    interceptJobSaves({
      [String(b._id)]: {
        before: async () => {
          await editSpool(a._id, a.spools[0]._id, { totalWeight: null });
          fail();
        },
      },
    });
    const res = await postJob([
      { filamentId: String(a._id), grams: 100 },
      { filamentId: String(b._id), grams: 100 },
    ]);
    expect(res.status).toBe(500);
    const [aSpool] = await spools(a._id);
    expect(aSpool.totalWeight).toBeNull();
    expect(aSpool.usageHistory ?? []).toHaveLength(0);
  });

  it("restores the exact sum of several rows on one spool, and a clamped debit exactly", async () => {
    const { a, b } = await makePair([{ totalWeight: 1000 }], [{ totalWeight: 30 }]);
    const c = await Filament.create({ name: "Interleave C", vendor: "V", type: "PLA", spools: [{ totalWeight: 500 }] });
    interceptJobSaves({ [String(c._id)]: { before: async () => fail() } });
    const res = await postJob([
      { filamentId: String(a._id), grams: 30 },
      { filamentId: String(a._id), grams: 20 },
      // B holds 30 g: the debit clamps at zero, so only 30 g comes off.
      { filamentId: String(b._id), grams: 100 },
      { filamentId: String(c._id), grams: 10 },
    ]);
    expect(res.status).toBe(500);
    expect((await spools(a._id))[0].totalWeight).toBe(1000);
    expect((await spools(b._id))[0].totalWeight).toBe(30);
    expect((await spools(c._id))[0].totalWeight).toBe(500);
  });

  it("fences a document loaded before the undo, so its stale save can't overwrite it", async () => {
    const { a, b } = await makePair();
    let stale: { spools: { totalWeight: number }[]; save: () => Promise<unknown> } | undefined;
    interceptJobSaves({
      [String(b._id)]: {
        before: async () => {
          stale = await Filament.findById(a._id);
          fail();
        },
      },
    });
    await postJob([
      { filamentId: String(a._id), grams: 100 },
      { filamentId: String(b._id), grams: 100 },
    ]);
    proto.save = originalSave;
    expect((await spools(a._id))[0].totalWeight).toBe(1000);
    stale!.spools[0].totalWeight = 1;
    await expect(stale!.save()).rejects.toBeInstanceOf(mongoose.Error.VersionError);
    expect((await spools(a._id))[0].totalWeight).toBe(1000);
  });

  it("answers a non-retryable 500 when the undo itself fails", async () => {
    const { a, b } = await makePair();
    vi.spyOn(Filament, "updateOne").mockRejectedValueOnce(new Error("db unavailable"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    interceptJobSaves({ [String(b._id)]: { before: async () => fail() } });
    const res = await postJob([
      { filamentId: String(a._id), grams: 100 },
      { filamentId: String(b._id), grams: 100 },
    ]);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not be fully undone/);
    expect(errSpy).toHaveBeenCalled();
  });

  it("answers a non-retryable 500 when the job's entry left a saved spool before the undo", async () => {
    const { a, b } = await makePair();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    interceptJobSaves({
      [String(b._id)]: {
        before: async () => {
          // Stand-in for a first-variant promotion moving the spool (and the
          // job's entry with it) off this filament mid-window.
          await Filament.collection.updateOne(
            { _id: a._id },
            { $set: { "spools.0.usageHistory": [] } },
          );
          fail();
        },
      },
    });
    const res = await postJob([
      { filamentId: String(a._id), grams: 100 },
      { filamentId: String(b._id), grams: 100 },
    ]);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not be fully undone/);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/no ledger entry to undo/);
  });
});

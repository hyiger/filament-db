import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { GET as getNextLabel } from "@/app/api/spools/next-label/route";

/**
 * Route coverage for GET /api/spools/next-label (GH #1060).
 *
 * The load-bearing behavior is the SCOPE: the scan deliberately includes
 * retired spools and trashed/purged filaments' spools — roll numbers are
 * physical and permanent, so a number must never be re-suggested after its
 * record leaves active inventory (restoring a trashed filament would
 * otherwise collide with a reissued number).
 */
describe("GET /api/spools/next-label", () => {
  let Filament: mongoose.Model<Record<string, unknown>>;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    Filament = mod.default as unknown as mongoose.Model<Record<string, unknown>>;
    await Filament.deleteMany({});
  });

  const filament = (over: Record<string, unknown>) => ({
    name: `F-${new mongoose.Types.ObjectId()}`,
    vendor: "V",
    type: "PLA",
    ...over,
  });

  it("returns {next: 1, max: null} on an empty database", async () => {
    const res = await getNextLabel();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: 1, max: null });
  });

  it("computes the max across spools of multiple filaments, ignoring non-numeric labels", async () => {
    await Filament.create(filament({ spools: [{ label: "17" }, { label: "Blue roll" }] }));
    await Filament.create(filament({ spools: [{ label: "204" }, { label: "12a" }] }));
    const res = await getNextLabel();
    expect(await res.json()).toEqual({ next: 205, max: 204 });
  });

  it("counts a RETIRED spool holding the max — its written number is still on the shelf", async () => {
    await Filament.create(filament({ spools: [{ label: "42", retired: true }, { label: "7" }] }));
    const res = await getNextLabel();
    expect(await res.json()).toEqual({ next: 43, max: 42 });
  });

  it("counts spools on TRASHED and PURGED filaments — the never-reuse invariant", async () => {
    await Filament.create(filament({ spools: [{ label: "10" }] }));
    await Filament.create(filament({ spools: [{ label: "50" }], _deletedAt: new Date() }));
    await Filament.create(
      filament({ spools: [{ label: "60" }], _deletedAt: new Date(), _purged: true }),
    );
    const res = await getNextLabel();
    // 60 lives on a purged filament; restoring the trashed one (50) must
    // never find its number reissued, so both count.
    expect(await res.json()).toEqual({ next: 61, max: 60 });
  });

  it("tolerates filaments with no spools array", async () => {
    await Filament.create(filament({}));
    await Filament.create(filament({ spools: [{ label: "3" }] }));
    const res = await getNextLabel();
    expect(await res.json()).toEqual({ next: 4, max: 3 });
  });
});

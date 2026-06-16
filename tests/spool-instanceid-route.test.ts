import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createSpool } from "@/app/api/filaments/[id]/spools/route";
import { PUT as updateSpool } from "@/app/api/filaments/[id]/spools/[spoolId]/route";
import { GET as matchFilaments } from "@/app/api/filaments/match/route";

/**
 * #732 Phase 4 — editing / setting a spool's instanceId.
 *
 * The write paths normally STRIP a client-supplied spool id (anti-spoofing);
 * Phase 4 adds a DELIBERATE, validated path: a user may enter a Prusa roll id
 * (or any charset-valid custom id) or regenerate, uniqueness-checked vs other
 * spools so the match path stays unambiguous.
 */
describe("#732 Phase 4 — spool instanceId edit/create", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", mod.default.schema);
    Filament = mongoose.models.Filament;
  });

  const putReq = (id: string, spoolId: string, body: unknown) =>
    updateSpool(
      new NextRequest(`http://localhost/api/filaments/${id}/spools/${spoolId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id, spoolId }) },
    );

  const postReq = (id: string, body: unknown) =>
    createSpool(
      new NextRequest(`http://localhost/api/filaments/${id}/spools`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );

  async function seed(spools: Array<Record<string, unknown>>) {
    return Filament.create({ name: `F-${Math.random()}`, vendor: "V", type: "PLA", spools });
  }

  // ── PUT (edit) ──────────────────────────────────────────────────────

  it("sets a custom (Prusa) spool id", async () => {
    const f = await seed([{ label: "A", totalWeight: 1000 }]);
    const sid = String(f.spools[0]._id);
    const res = await putReq(String(f._id), sid, { instanceId: "1086170252" });
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools[0].instanceId).toBe("1086170252");
  });

  it("rejects a charset-invalid id with 400", async () => {
    const f = await seed([{ label: "A", totalWeight: 1000 }]);
    const res = await putReq(String(f._id), String(f.spools[0]._id), { instanceId: "bad id!" });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate id used by another spool on the SAME filament (409)", async () => {
    const f = await seed([
      { label: "A", totalWeight: 1000, instanceId: "aaaaaaaaaa" },
      { label: "B", totalWeight: 900, instanceId: "bbbbbbbbbb" },
    ]);
    const res = await putReq(String(f._id), String(f.spools[1]._id), { instanceId: "aaaaaaaaaa" });
    expect(res.status).toBe(409);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools[1].instanceId).toBe("bbbbbbbbbb"); // unchanged
  });

  it("rejects a duplicate id used by a spool on ANOTHER filament (409)", async () => {
    await seed([{ label: "X", totalWeight: 1000, instanceId: "shared0001" }]);
    const f = await seed([{ label: "A", totalWeight: 1000 }]);
    const res = await putReq(String(f._id), String(f.spools[0]._id), { instanceId: "shared0001" });
    expect(res.status).toBe(409);
  });

  it("rejects a spool id that collides with ANOTHER filament's top-level instanceId (409)", async () => {
    // matchFilament resolves spool ids before the filament-level fallback, so a
    // spool id == another filament's id would shadow that filament's tags.
    await Filament.create({
      name: "Has Filament Id",
      vendor: "V",
      type: "PLA",
      instanceId: "fila1d0001",
    });
    const f = await seed([{ label: "A", totalWeight: 1000 }]);
    const res = await putReq(String(f._id), String(f.spools[0]._id), { instanceId: "fila1d0001" });
    expect(res.status).toBe(409);
  });

  it("allows a spool id equal to its OWN filament's instanceId (carry-over)", async () => {
    const f = await Filament.create({
      name: "Own Id Filament",
      vendor: "V",
      type: "PLA",
      instanceId: "ownfil0001",
      spools: [{ label: "A", totalWeight: 1000, instanceId: "differenta" }],
    });
    const res = await putReq(String(f._id), String(f.spools[0]._id), { instanceId: "ownfil0001" });
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools[0].instanceId).toBe("ownfil0001");
  });

  it("allows setting a spool's id to its own current value (no self-conflict)", async () => {
    const f = await seed([{ label: "A", totalWeight: 1000, instanceId: "keepme0001" }]);
    const res = await putReq(String(f._id), String(f.spools[0]._id), { instanceId: "keepme0001" });
    expect(res.status).toBe(200);
  });

  it("allows reusing a TRASHED filament's spool id (scoped to non-deleted)", async () => {
    const trashed = await seed([{ label: "T", totalWeight: 1000, instanceId: "trash00001" }]);
    await Filament.updateOne({ _id: trashed._id }, { $set: { _deletedAt: new Date() } });
    const f = await seed([{ label: "A", totalWeight: 1000 }]);
    const res = await putReq(String(f._id), String(f.spools[0]._id), { instanceId: "trash00001" });
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools[0].instanceId).toBe("trash00001");
  });

  it("regenerates a fresh id with { regenerate: true }", async () => {
    const f = await seed([{ label: "A", totalWeight: 1000, instanceId: "original01" }]);
    const res = await putReq(String(f._id), String(f.spools[0]._id), { regenerate: true });
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools[0].instanceId).toMatch(/^[0-9a-f]{10}$/);
    expect(fresh.spools[0].instanceId).not.toBe("original01");
  });

  // ── POST (create) ───────────────────────────────────────────────────

  it("creates a spool with an explicit id", async () => {
    const f = await seed([]);
    const res = await postReq(String(f._id), { instanceId: "createme01", totalWeight: 1000 });
    expect(res.status).toBe(201);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools.at(-1).instanceId).toBe("createme01");
  });

  it("creates with an id only (no weight) — not a phantom spool", async () => {
    const f = await seed([]);
    const res = await postReq(String(f._id), { instanceId: "idonly0001" });
    expect(res.status).toBe(201);
  });

  it("rejects creating a spool with a duplicate id (409)", async () => {
    const a = await seed([{ label: "A", totalWeight: 1000, instanceId: "dupe00001" }]);
    const res = await postReq(String(a._id), { instanceId: "dupe00001", totalWeight: 500 });
    expect(res.status).toBe(409);
  });

  it("auto-generates an id when none is supplied", async () => {
    const f = await seed([]);
    const res = await postReq(String(f._id), { totalWeight: 1000 });
    expect(res.status).toBe(201);
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools[0].instanceId).toMatch(/^[0-9a-f]{10}$/);
  });

  // ── end-to-end: an edited Prusa id is resolvable by the matcher ──────

  it("a spool edited to a Prusa id resolves via GET /api/filaments/match", async () => {
    const f = await seed([{ label: "A", totalWeight: 1000 }]);
    await putReq(String(f._id), String(f.spools[0]._id), { instanceId: "1086170252" });
    const res = await matchFilaments(
      new NextRequest("http://localhost/api/filaments/match?instanceId=1086170252"),
    );
    const body = await res.json();
    expect(body.match?._id).toBe(String(f._id));
    expect(body.matchedSpool?.instanceId).toBe("1086170252");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as openprinttag } from "@/app/api/filaments/[id]/openprinttag/route";
import { decodeOpenPrintTagBinary } from "@/lib/openprinttag-decode";

/**
 * #732 Phase 3 — GET /api/filaments/{id}/openprinttag encodes the SELECTED
 * spool's instanceId into the tag's spool_uid (falling back to the filament
 * id only for a spool-less filament). The emitted binary is decoded back so
 * the assertion is end-to-end.
 */
describe("GET /api/filaments/[id]/openprinttag — spool-scoped spool_uid (#732)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", mod.default.schema);
    Filament = mongoose.models.Filament;
  });

  function req(id: string, spool?: string) {
    const qs = spool ? `?spool=${encodeURIComponent(spool)}` : "";
    return new NextRequest(`http://localhost/api/filaments/${id}/openprinttag${qs}`);
  }

  async function decodedSpoolUid(res: Response): Promise<string | undefined> {
    const buf = new Uint8Array(await res.arrayBuffer());
    return decodeOpenPrintTagBinary(buf).spoolUid;
  }

  it("returns 400 (not 500) for a malformed filament id (#854)", async () => {
    const res = await openprinttag(req("not-an-object-id"), {
      params: Promise.resolve({ id: "not-an-object-id" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid filament id/i);
  });

  it("defaults to the first non-retired spool's instanceId", async () => {
    const f = await Filament.create({
      name: "Spooled PLA",
      vendor: "Test",
      type: "PLA",
      diameter: 1.75,
      spools: [
        { label: "A", totalWeight: 1000, instanceId: "5p001aaaaa", retired: true },
        { label: "B", totalWeight: 900, instanceId: "5p002bbbbb" },
      ],
    });
    const res = await openprinttag(req(String(f._id)), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(200);
    // First NON-retired spool is B.
    expect(await decodedSpoolUid(res)).toBe("5p002bbbbb");
  });

  it("encodes the explicitly requested spool's instanceId", async () => {
    const f = await Filament.create({
      name: "Pick PLA",
      vendor: "Test",
      type: "PLA",
      diameter: 1.75,
      spools: [
        { label: "A", totalWeight: 1000, instanceId: "5p001aaaaa" },
        { label: "B", totalWeight: 900, instanceId: "5p002bbbbb" },
      ],
    });
    const res = await openprinttag(req(String(f._id), String(f.spools[1]._id)), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(200);
    expect(await decodedSpoolUid(res)).toBe("5p002bbbbb");
  });

  it("honors an explicitly requested RETIRED spool", async () => {
    const f = await Filament.create({
      name: "Retired Pick PLA",
      vendor: "Test",
      type: "PLA",
      diameter: 1.75,
      spools: [
        { label: "A", totalWeight: 1000, instanceId: "5p001aaaaa", retired: true },
        { label: "B", totalWeight: 900, instanceId: "5p002bbbbb" },
      ],
    });
    // Explicitly target the retired spool A — the route must honor the choice.
    const res = await openprinttag(req(String(f._id), String(f.spools[0]._id)), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(200);
    expect(await decodedSpoolUid(res)).toBe("5p001aaaaa");
  });

  it("encodes the SELECTED spool's remaining weight, not another spool's (#732 Codex P2)", async () => {
    const f = await Filament.create({
      name: "Weight Pair PLA",
      vendor: "Test",
      type: "PLA",
      diameter: 1.75,
      spoolWeight: 200,
      spools: [
        { label: "A", totalWeight: 1000, instanceId: "5p001aaaaa" }, // remaining 800
        { label: "B", totalWeight: 600, instanceId: "5p002bbbbb" }, // remaining 400
      ],
    });
    const res = await openprinttag(req(String(f._id), String(f.spools[1]._id)), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(200);
    const decoded = decodeOpenPrintTagBinary(new Uint8Array(await res.arrayBuffer()));
    // The tag identifies spool B AND carries B's remaining weight (600-200=400),
    // not A's (800).
    expect(decoded.spoolUid).toBe("5p002bbbbb");
    expect(decoded.actualWeightGrams).toBe(400);
  });

  it("returns 400 for an unknown ?spool id", async () => {
    const f = await Filament.create({
      name: "Bad Spool PLA",
      vendor: "Test",
      type: "PLA",
      diameter: 1.75,
      spools: [{ label: "A", totalWeight: 1000, instanceId: "5p001aaaaa" }],
    });
    const res = await openprinttag(req(String(f._id), "deadbeefdeadbeefdeadbeef"), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(400);
  });

  it("falls back to the filament instanceId for a spool-less filament", async () => {
    const f = await Filament.create({
      name: "No Spools PLA",
      vendor: "Test",
      type: "PLA",
      diameter: 1.75,
      instanceId: "fa11bac0de",
    });
    const res = await openprinttag(req(String(f._id)), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(res.status).toBe(200);
    expect(await decodedSpoolUid(res)).toBe("fa11bac0de");
  });
});

/**
 * GH #1227 (Codex P1 r3 on PR #1228) — the download refuses an UNREVIEWED tag
 * array: a row written before v1.83 whose numbering the startup pass could not
 * prove still holds the app's old ids, and on the wire they would be read with
 * the spec's meaning. The gate reads the row that supplies the effective array.
 */
describe("GET /api/filaments/[id]/openprinttag — unreviewed tag numbering is refused (GH #1227)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  const col = () => mongoose.connection.collection("filaments");

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", mod.default.schema);
    Filament = mongoose.models.Filament;
    await col().deleteMany({});
  });

  const get = (id: string) =>
    openprinttag(new NextRequest(`http://localhost/api/filaments/${id}/openprinttag`), {
      params: Promise.resolve({ id }),
    });

  it("409 opt_tags_pending_review for a pre-#1227 row awaiting review; 200 once it is settled", async () => {
    // Raw insert: no marker, the ambiguous legacy/spec 2.
    const { insertedId } = await col().insertOne({
      name: "Legacy Transparent", vendor: "V", type: "PETG", optTags: [2],
      instanceId: "abc123def0", _deletedAt: null,
    });
    const refused = await get(String(insertedId));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("opt_tags_pending_review");

    // Settled (what Data health's Convert writes): verified spec ids go out.
    await col().updateOne({ _id: insertedId }, { $set: { optTags: [20], optTagsSpec: true } });
    const ok = await get(String(insertedId));
    expect(ok.status).toBe(200);
    const decoded = decodeOpenPrintTagBinary(new Uint8Array(await ok.arrayBuffer()));
    expect(decoded.tagNames).toContain("transparent");
  });

  it("a variant with an empty own array answers for its PARENT's review state", async () => {
    const { insertedId: parentId } = await col().insertOne({
      name: "Legacy Parent", vendor: "V", type: "PLA", optTags: [2], _deletedAt: null,
    });
    const variant = await Filament.create({
      name: "Legacy Variant", vendor: "V", type: "PLA", parentId, optTags: [], instanceId: "abc123def1",
    });
    expect((await get(String(variant._id))).status).toBe(409);

    await col().updateOne({ _id: parentId }, { $set: { optTagsSpec: true } });
    expect((await get(String(variant._id))).status).toBe(200);

    // A non-empty own array (trivially spec here) wins over the parent's state.
    await col().updateOne({ _id: parentId }, { $unset: { optTagsSpec: "" } });
    await col().updateOne({ _id: variant._id }, { $set: { optTags: [16] } });
    expect((await get(String(variant._id))).status).toBe(200);
  });
});

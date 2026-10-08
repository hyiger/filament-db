import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/filaments/[id]/route";

/**
 * GH #1227 — the detail route's response-only `_optTagsAwaitReview`: on the
 * document itself (the detail page refuses Write NFC / the `.bin` download on
 * it, Codex P1 r3 on PR #1228) and on every `_variants[]` entry (the variant
 * chips derive finish + arrangement from the effective tags, Codex P2 r11).
 * Computed from the row that SUPPLIES the effective array: a variant with an
 * empty own array answers for its parent.
 */
describe("GET /api/filaments/{id} — _optTagsAwaitReview (GH #1227)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  const raw = () => mongoose.connection.collection("filaments");

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", mod.default.schema);
    Filament = mongoose.models.Filament;
  });

  const get = async (id: string) => {
    const res = await GET(new NextRequest(`http://localhost:3456/api/filaments/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    return res.json();
  };

  it("an unmarked legacy-shaped row awaits review; a row written since v1.83 does not", async () => {
    const { insertedId } = await raw().insertOne({
      name: "Unmarked", vendor: "QA", type: "PLA", optTags: [20], _deletedAt: null,
    });
    const verified = await Filament.create({ name: "Verified", vendor: "QA", type: "PLA", optTags: [20] });
    const inert = await raw().insertOne({ name: "Inert", vendor: "QA", type: "PLA", optTags: [16], _deletedAt: null });

    expect((await get(String(insertedId)))._optTagsAwaitReview).toBe(true);
    expect((await get(String(verified._id)))._optTagsAwaitReview).toBe(false);
    expect((await get(String(inert.insertedId)))._optTagsAwaitReview).toBe(false);
  });

  it("a variant with an empty own array answers for its parent — on its own page and in the parent's _variants", async () => {
    const { insertedId: parentId } = await raw().insertOne({
      name: "Unmarked Parent", vendor: "QA", type: "PLA", optTags: [20], _deletedAt: null,
    });
    const child = await Filament.create({ name: "Child", vendor: "QA", type: "PLA", parentId });
    const own = await Filament.create({ name: "Own Tags", vendor: "QA", type: "PLA", parentId, optTags: [16] });

    expect((await get(String(child._id)))._optTagsAwaitReview).toBe(true);
    expect((await get(String(own._id)))._optTagsAwaitReview).toBe(false);

    const parent = await get(String(parentId));
    expect(parent._optTagsAwaitReview).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byName = Object.fromEntries(parent._variants.map((v: any) => [v.name, v]));
    expect(byName["Child"]).toMatchObject({ optTags: [20], _optTagsAwaitReview: true });
    expect(byName["Own Tags"]).toMatchObject({ optTags: [16], _optTagsAwaitReview: false });
    // The marker itself never rides the variants projection.
    for (const v of parent._variants) expect(v).not.toHaveProperty("optTagsSpec");
  });
});

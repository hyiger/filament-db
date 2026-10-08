import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { PUT } from "@/app/api/filaments/[id]/route";

/**
 * GH #1227 — the PUT's handling of `optTags` on rows that still await
 * OpenPrintTag numbering review (no `optTagsSpec: true` marker).
 *
 * A legacy `[2]` (app "transparent") plus a newly ticked spec 16 has no honest
 * storage: all-legacy misfiles the 16, all-spec misfiles the 2 (Codex P1 on
 * PR #1228). So a CHANGED array on such a row is refused, an UNCHANGED one is
 * written as is without laundering the marker, and a row that is verified (or
 * trivially spec) is stamped on every optTags write.
 */
describe("PUT /api/filaments/{id} — optTags numbering guard (GH #1227)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  const col = () => mongoose.connection.collection("filaments");

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
    await col().deleteMany({});
  });

  const put = (id: string, body: Record<string, unknown>) =>
    PUT(
      new NextRequest(`http://localhost:3456/api/filaments/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );

  it("refuses a CHANGED array on an unreviewed row with 409 opt_tags_pending_review", async () => {
    // Raw insert: a pre-#1227 row, no marker.
    const { insertedId } = await col().insertOne({
      name: "Legacy Transparent", vendor: "V", type: "PETG", optTags: [2], _deletedAt: null,
    });
    const res = await put(String(insertedId), {
      name: "Legacy Transparent", vendor: "V", type: "PETG", optTags: [2, 16],
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("opt_tags_pending_review");
    const row = await col().findOne({ _id: insertedId });
    expect(row?.optTags).toEqual([2]);
    expect(row?.optTagsSpec).toBeUndefined();
  });

  it("writes an UNCHANGED array on an unreviewed row as is — and does not launder the marker", async () => {
    const { insertedId } = await col().insertOne({
      name: "Legacy Keep", vendor: "V", type: "PETG", optTags: [2, 16], _deletedAt: null,
    });
    // The edit form resubmits every seeded field; a note edit must still save.
    const res = await put(String(insertedId), {
      name: "Legacy Keep", vendor: "V", type: "PETG", optTags: [16, 2], colorName: "Smoke",
    });
    expect(res.status).toBe(200);
    const row = await col().findOne({ _id: insertedId });
    expect(row?.colorName).toBe("Smoke");
    expect(row?.optTags).toEqual([16, 2]);
    expect(row?.optTagsSpec).toBeUndefined();
  });

  it("stamps a verified row, and an unmarked row whose array is trivially spec", async () => {
    const verified = await Filament.create({ name: "Verified", vendor: "V", type: "PLA", optTags: [20] });
    expect((await col().findOne({ _id: verified._id }))?.optTagsSpec).toBe(true); // schema default
    const res = await put(String(verified._id), { name: "Verified", vendor: "V", type: "PLA", optTags: [20, 16] });
    expect(res.status).toBe(200);
    expect(await col().findOne({ _id: verified._id })).toMatchObject({ optTags: [20, 16], optTagsSpec: true });

    // Unmarked but only fixed-point ids (or a spec-only id): nothing legacy to protect.
    const { insertedId } = await col().insertOne({
      name: "Trivial Unmarked", vendor: "V", type: "PLA", optTags: [4], _deletedAt: null,
    });
    const res2 = await put(String(insertedId), { name: "Trivial Unmarked", vendor: "V", type: "PLA", optTags: [4, 16] });
    expect(res2.status).toBe(200);
    expect(await col().findOne({ _id: insertedId })).toMatchObject({ optTags: [4, 16], optTagsSpec: true });
  });

  it("ignores a client-sent optTagsSpec (server-owned)", async () => {
    const { insertedId } = await col().insertOne({
      name: "Forged", vendor: "V", type: "PETG", optTags: [2], _deletedAt: null,
    });
    const res = await put(String(insertedId), {
      name: "Forged", vendor: "V", type: "PETG", optTags: [2], optTagsSpec: true,
    });
    expect(res.status).toBe(200);
    expect((await col().findOne({ _id: insertedId }))?.optTagsSpec).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/opt-tag-review/route";
import { POST } from "@/app/api/opt-tag-review/[id]/route";
import { DELETE } from "@/app/api/opt-tag-review/dropped/route";

/**
 * GH #1227 — the Data health surface for optTags whose numbering the startup
 * pass could not prove. The helpers' branches are pinned in
 * tests/optTagRenumber.test.ts; these pin the HTTP contract and that the GET
 * settles decisive rows before listing.
 */
describe("/api/opt-tag-review", () => {
  const col = () => mongoose.connection.collection("filaments");
  const markers = () => mongoose.connection.collection("_migrations");
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
    POST(
      new NextRequest(`http://localhost:3456/api/opt-tag-review/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      params(id),
    );

  beforeEach(async () => {
    await col().deleteMany({});
    await markers().deleteMany({});
  });

  it("GET settles decisive rows first, then lists the pending ones with both readings and the recorded drops", async () => {
    await col().insertMany([
      // Decisive through OPT provenance (a link with no snapshot predates
      // snapshots); 18 alone would only be a hint (Codex P1 r6).
      { name: "Legacy", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "legacy" } },
      { name: "Pending", vendor: "V", type: "PETG", optTags: [2] },
      { name: "Trivial", vendor: "V", type: "PLA", optTags: [4] },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]).toMatchObject({
      name: "Pending",
      verdict: "ambiguous",
      stored: [2],
      asLegacy: { tags: [20], dropped: [] },
      asSpec: [2],
    });
    // The decisive row was converted by the GET's pass, and its drop recorded.
    const legacy = await col().findOne({ name: "Legacy" });
    expect(legacy?.optTags).toEqual([57]);
    expect(legacy?.optTagsSpec).toBe(true);
    expect(body.dropped).toEqual([expect.objectContaining({ name: "Legacy", tags: [9] })]);
    expect((await col().findOne({ name: "Trivial" }))?.optTagsSpec).toBe(true);
  });

  it("POST convert / keep apply the answer against the exact array the page showed", async () => {
    const { insertedIds } = await col().insertMany([
      { name: "A", vendor: "V", type: "PLA", optTags: [2, 9] },
      { name: "B", vendor: "V", type: "PLA", optTags: [12] },
    ]);
    const a = await post(String(insertedIds[0]), { action: "convert", expectedTags: [2, 9] });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ outcome: "converted", tags: [20], dropped: [9] });
    expect(await col().findOne({ _id: insertedIds[0] })).toMatchObject({ optTags: [20], optTagsSpec: true });

    const b = await post(String(insertedIds[1]), { action: "keep", expectedTags: [12] });
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ outcome: "kept", tags: [12] });
    expect(await col().findOne({ _id: insertedIds[1] })).toMatchObject({ optTags: [12], optTagsSpec: true });
  });

  it("POST is 409 tags_changed when the stored array differs from expectedTags, 404 when gone", async () => {
    const { insertedId } = await col().insertOne({ name: "C", vendor: "V", type: "PLA", optTags: [2, 16] });
    const res = await post(String(insertedId), { action: "convert", expectedTags: [2] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("tags_changed");
    expect((await col().findOne({ _id: insertedId }))?.optTags).toEqual([2, 16]);

    const gone = await post(String(new mongoose.Types.ObjectId()), { action: "keep", expectedTags: [] });
    expect(gone.status).toBe(404);
  });

  it("POST validates id, action, expectedTags and JSON, and rejects cross-site callers", async () => {
    const { insertedId } = await col().insertOne({ name: "D", vendor: "V", type: "PLA", optTags: [2] });
    const id = String(insertedId);
    expect((await post("not-an-id", { action: "keep", expectedTags: [2] })).status).toBe(400);
    expect((await post(id, { action: "guess", expectedTags: [2] })).status).toBe(400);
    expect((await post(id, { action: "keep", expectedTags: [-1] })).status).toBe(400);
    expect((await post(id, { action: "keep" })).status).toBe(400);
    expect((await post(id, "{not json")).status).toBe(400);
    expect(
      (await post(id, { action: "keep", expectedTags: [2] }, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect((await col().findOne({ _id: insertedId }))?.optTagsSpec).toBeUndefined();
  });

  it("DELETE /dropped clears the recorded drops and is CSRF-guarded", async () => {
    await markers().insertOne({
      _id: "optTagRenumber" as never,
      dropped: [{ filamentId: "x", name: "X", tags: [9], at: new Date() }],
    });
    const blocked = await DELETE(
      new NextRequest("http://localhost:3456/api/opt-tag-review/dropped", {
        method: "DELETE",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect(blocked.status).toBe(403);
    const ok = await DELETE(
      new NextRequest("http://localhost:3456/api/opt-tag-review/dropped", { method: "DELETE" }),
    );
    expect(ok.status).toBe(200);
    expect((await markers().findOne({ _id: "optTagRenumber" as never }))?.dropped).toEqual([]);
  });

  it("DELETE /dropped with filamentIds removes only the displayed records (Codex P2 r7)", async () => {
    await markers().insertOne({
      _id: "optTagRenumber" as never,
      dropped: [
        { filamentId: "seen", name: "Seen", tags: [9], at: new Date() },
        { filamentId: "later", name: "Appended after the page loaded", tags: [5], at: new Date() },
      ],
    });
    const res = await DELETE(
      new NextRequest("http://localhost:3456/api/opt-tag-review/dropped", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filamentIds: ["seen"] }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await markers().findOne({ _id: "optTagRenumber" as never }))?.dropped.map((d: { name: string }) => d.name)).toEqual([
      "Appended after the page loaded",
    ]);
    const bad = await DELETE(
      new NextRequest("http://localhost:3456/api/opt-tag-review/dropped", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filamentIds: [1] }),
      }),
    );
    expect(bad.status).toBe(400);
  });
});

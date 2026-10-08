import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/opt-tag-review/route";
import { POST } from "@/app/api/opt-tag-review/[id]/route";
import { DELETE } from "@/app/api/opt-tag-review/dropped/route";

/**
 * GH #1227 — the Data health surface for optTags whose numbering the startup
 * pass could not settle (every non-trivial array — no stored content proves a
 * numbering). The helpers' branches are pinned in tests/optTagRenumber.test.ts;
 * these pin the HTTP contract and that the GET marks trivial rows before
 * listing.
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

  it("GET marks trivial rows first, then lists the pending ones with both readings, hints and the recorded drops", async () => {
    await col().insertMany([
      // OPT provenance (a link with no snapshot) and the deprecated 18 are both
      // HINTS (Codex P1 r6 + r12) — listed, never converted by the GET's pass.
      { name: "Linked", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "linked" } },
      // Stored in the SCHEMA shape (`openprinttagSnapshot: null`, `settings: {}`)
      // — what every row the pre-v1.83 app saved looks like; the pass must
      // mark and the resolution must match it (a child-path projection over
      // the null container used to read it as absent and match nothing).
      { name: "Pending", vendor: "V", type: "PETG", optTags: [2], openprinttagSnapshot: null, settings: {} },
      { name: "Trivial", vendor: "V", type: "PLA", optTags: [4], openprinttagSnapshot: null, settings: {} },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending.map((r: { name: string }) => r.name)).toEqual(["Linked", "Pending"]);
    expect(body.pending[0]).toMatchObject({
      name: "Linked",
      verdict: "ambiguous",
      hints: ["opt-provenance", "legacy-only-id"],
      matchesOptProvenance: true,
      legacyOnlyIds: [18],
      specOnlyIds: [],
      stored: [18, 9],
      asLegacy: { tags: [57], dropped: [9] },
      asSpec: [18, 9],
    });
    expect(body.pending[1]).toMatchObject({
      name: "Pending",
      verdict: "ambiguous",
      hints: [],
      matchesOptProvenance: false,
      stored: [2],
      asLegacy: { tags: [20], dropped: [] },
      asSpec: [2],
    });
    // Nothing was converted, so nothing was dropped.
    expect(await col().findOne({ name: "Linked" })).toMatchObject({ optTags: [18, 9] });
    expect((await col().findOne({ name: "Linked" }))?.optTagsSpec).toBeUndefined();
    expect(body.dropped).toEqual([]);
    // The trivial row was marked by the GET's pass.
    expect((await col().findOne({ name: "Trivial" }))?.optTagsSpec).toBe(true);
  });

  it("POST convert / keep apply the answer against the exact array the page showed", async () => {
    const { insertedIds } = await col().insertMany([
      { name: "A", vendor: "V", type: "PLA", optTags: [2, 9], openprinttagSnapshot: null, settings: {} }, // schema shape
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

  it("POST is 409 tags_changed when the echoed hints no longer hold (Codex P2 r14), and accepts them when they do", async () => {
    const { insertedId } = await col().insertOne({
      name: "Relinked", vendor: "V", type: "PLA", optTags: [2],
      settings: { openprinttag_slug: "a" }, openprinttagSnapshot: { optTags: [2] },
    });
    // The page saw the opt-provenance hint; a re-link then spec-marks the snapshot.
    await col().updateOne({ _id: insertedId }, { $set: { openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" } } });
    const stale = await post(String(insertedId), { action: "convert", expectedTags: [2], expectedHints: ["opt-provenance"] });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe("tags_changed");
    expect((await col().findOne({ _id: insertedId }))?.optTags).toEqual([2]);
    const fresh = await post(String(insertedId), { action: "convert", expectedTags: [2], expectedHints: [] });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({ outcome: "converted", tags: [20], dropped: [] });
  });

  it("POST validates id, action, expectedTags, expectedHints and JSON, and rejects cross-site callers", async () => {
    const { insertedId } = await col().insertOne({ name: "D", vendor: "V", type: "PLA", optTags: [2] });
    const id = String(insertedId);
    expect((await post("not-an-id", { action: "keep", expectedTags: [2] })).status).toBe(400);
    expect((await post(id, { action: "guess", expectedTags: [2] })).status).toBe(400);
    expect((await post(id, { action: "keep", expectedTags: [-1] })).status).toBe(400);
    expect((await post(id, { action: "keep" })).status).toBe(400);
    expect((await post(id, { action: "keep", expectedTags: [2], expectedHints: ["bogus"] })).status).toBe(400);
    expect((await post(id, { action: "keep", expectedTags: [2], expectedHints: "opt-provenance" })).status).toBe(400);
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

  it("DELETE /dropped with records removes only the exact displayed records — row AND version (Codex P2 r7 + r16)", async () => {
    const seenAt = new Date("2026-10-08T12:00:00.000Z");
    const laterAt = new Date("2026-10-08T13:00:00.000Z");
    await markers().insertOne({
      _id: "optTagRenumber" as never,
      dropped: [
        { filamentId: "seen", name: "Seen", tags: [9], at: seenAt },
        { filamentId: "later", name: "Appended after the page loaded", tags: [5], at: seenAt },
        // The same row converted again after the page loaded: same id, new version.
        { filamentId: "replaced", name: "Replaced since", tags: [6], at: laterAt },
      ],
    });
    const res = await DELETE(
      new NextRequest("http://localhost:3456/api/opt-tag-review/dropped", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          records: [
            { filamentId: "seen", at: seenAt.toISOString() },
            { filamentId: "replaced", at: seenAt.toISOString() }, // the version the page saw, not the one stored
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await markers().findOne({ _id: "optTagRenumber" as never }))?.dropped.map((d: { name: string }) => d.name)).toEqual([
      "Appended after the page loaded",
      "Replaced since",
    ]);
    for (const body of [
      { records: [{ filamentId: 1, at: seenAt.toISOString() }] },
      { records: [{ filamentId: "seen", at: "not a date" }] },
      { records: [{ filamentId: "seen" }] },
      { records: "seen" },
      { filamentIds: ["seen"] }, // the pre-r16 shape is gone
    ]) {
      const bad = await DELETE(
        new NextRequest("http://localhost:3456/api/opt-tag-review/dropped", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(bad.status, JSON.stringify(body)).toBe(400);
    }
  });
});

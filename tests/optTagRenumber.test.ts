import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  renumberOptTags,
  describeRenumberSummary,
  scanUnverifiedOptTags,
  resolveOptTagNumbering,
  readDroppedLegacyTags,
  dismissDroppedLegacyTags,
  OPT_TAG_RENUMBER_MARKER_ID,
  type MinimalRenumberDb,
} from "@/lib/optTagRenumber";

/**
 * GH #1227 — the pass that brings stored `optTags` onto the OpenPrintTag spec
 * numbering. Raw inserts throughout: these are the states the pre-#1227 app
 * (and vendor NFC reads) actually produced, with no `optTagsSpec` marker.
 */
describe("renumberOptTags", () => {
  const db = () => mongoose.connection.db as unknown as MinimalRenumberDb;
  const col = () => mongoose.connection.collection("filaments");
  const markers = () => mongoose.connection.collection("_migrations");
  const NOW = new Date("2026-10-08T12:00:00.000Z");
  const OLD = new Date("2026-01-01T00:00:00.000Z");

  beforeEach(async () => {
    await col().deleteMany({});
    await markers().deleteMany({});
  });

  const byName = (n: string) => col().findOne({ name: n });

  it("converts provably-legacy rows, marks spec/trivial rows, leaves ambiguous rows unmarked — and is idempotent", async () => {
    await col().insertMany([
      // 18 (app MARBLE) is deprecated upstream → provably legacy. 9 FLEXIBLE drops.
      { name: "Legacy Marble", vendor: "V", type: "PLA", optTags: [18, 2, 9], updatedAt: OLD },
      // Spec-only 30 → written by a vendor tag, not this app.
      { name: "PC Blend CF", vendor: "Prusament", type: "PC", optTags: [31, 12, 4, 30], updatedAt: OLD },
      // Only fixed points → nothing to translate.
      { name: "Plain Abrasive", vendor: "V", type: "PLA", optTags: [4, 16], updatedAt: OLD },
      { name: "No Tags", vendor: "V", type: "PLA", optTags: [], updatedAt: OLD },
      // Valid under both readings, nothing outside the array → the user's call.
      { name: "Ambiguous Transparent", vendor: "V", type: "PETG", optTags: [2], updatedAt: OLD },
      // Legacy-only + spec-only together → no single numbering explains it.
      { name: "Inconsistent", vendor: "V", type: "PLA", optTags: [18, 30], updatedAt: OLD },
    ]);

    const first = await renumberOptTags(db(), NOW);
    expect(first).toMatchObject({
      scanned: 6,
      converted: 1,
      verified: 3,
      ambiguous: 1,
      inconsistent: 1,
      skipped: 0,
    });
    expect(first.dropped).toEqual([
      { filamentId: expect.any(String), name: "Legacy Marble", tags: [9], at: NOW },
    ]);

    const marble = await byName("Legacy Marble");
    expect(marble?.optTags).toEqual([57, 20]); // imitates_marble, transparent
    expect(marble?.optTagsSpec).toBe(true);
    expect(marble?.updatedAt).toEqual(NOW); // propagates by LWW

    const pc = await byName("PC Blend CF");
    expect(pc?.optTags).toEqual([31, 12, 4, 30]); // untouched
    expect(pc?.optTagsSpec).toBe(true);
    expect(pc?.updatedAt).toEqual(OLD); // only the marker changed — no LWW bump

    expect((await byName("Plain Abrasive"))?.optTagsSpec).toBe(true);
    expect((await byName("No Tags"))?.optTagsSpec).toBe(true);

    const amb = await byName("Ambiguous Transparent");
    expect(amb?.optTags).toEqual([2]);
    expect(amb?.optTagsSpec).toBeUndefined();
    expect((await byName("Inconsistent"))?.optTagsSpec).toBeUndefined();

    // Idempotent: the second pass sees only the two unsettled rows and writes nothing.
    const second = await renumberOptTags(db(), new Date("2026-10-09T00:00:00.000Z"));
    expect(second).toMatchObject({ scanned: 2, converted: 0, verified: 0, ambiguous: 1, inconsistent: 1 });
    expect((await byName("Legacy Marble"))?.optTags).toEqual([57, 20]); // NOT [57, 46] — no double remap

    // The run is recorded with the drops.
    const marker = await markers().findOne({ _id: OPT_TAG_RENUMBER_MARKER_ID as never });
    expect(marker?.lastRun).toMatchObject({ scanned: 2 });
    expect(marker?.dropped).toHaveLength(1);
    expect(marker?.dropped[0]).toMatchObject({ name: "Legacy Marble", tags: [9] });
  });

  it("uses OpenPrintTag provenance as proof, surfaces a backfill-derivation match as a hint only, and translates the snapshot", async () => {
    await col().insertMany([
      // Imported from the OPT database: the snapshot (legacy by construction)
      // equals the stored array → the importer wrote the array.
      {
        name: "OPT Imported", vendor: "V", type: "PLA", optTags: [17, 27],
        settings: { openprinttag_slug: "v-pla" }, openprinttagSnapshot: { optTags: [27, 17], density: 1.24 },
      },
      // Pre-snapshot (v1.36) import: slug, no snapshot array.
      { name: "OPT Old Import", vendor: "V", type: "PLA", optTags: [3], settings: { openprinttag_slug: "v-old" } },
      // The backfill script's exact output for this name + type — likely legacy,
      // but a vendor tag could carry the same set, so NOT converted (Codex P1).
      { name: "Prusament PLA Galaxy Black", vendor: "Prusament", type: "PLA", optTags: [12, 15] },
      // Snapshot DIFFERS → edited in the legacy form, or an NFC row linked later: ambiguous.
      {
        name: "OPT Edited", vendor: "V", type: "PLA", optTags: [2, 17],
        settings: { openprinttag_slug: "v-ed" }, openprinttagSnapshot: { optTags: [17] },
      },
      // Spec-decided row with a legacy snapshot: the snapshot is still translated.
      {
        name: "Vendor Tag Linked", vendor: "V", type: "PC", optTags: [30, 4],
        settings: { openprinttag_slug: "v-pc" }, openprinttagSnapshot: { optTags: [2] },
      },
    ]);

    const s = await renumberOptTags(db(), NOW);
    expect(s).toMatchObject({ scanned: 5, converted: 2, verified: 1, ambiguous: 2, inconsistent: 0 });

    const imported = await byName("OPT Imported");
    expect(imported?.optTags).toEqual([17, 28]);
    expect(imported?.openprinttagSnapshot).toEqual({ optTags: [28, 17], density: 1.24 });
    expect((await byName("OPT Old Import"))?.optTags).toEqual([19]);
    const galaxy = await byName("Prusament PLA Galaxy Black");
    expect(galaxy?.optTags).toEqual([12, 15]); // untouched, unmarked — Data health with the hint
    expect(galaxy?.optTagsSpec).toBeUndefined();
    const pending = await scanUnverifiedOptTags(db());
    expect(pending.find((r) => r.name === "Prusament PLA Galaxy Black")).toMatchObject({
      verdict: "ambiguous",
      matchesBackfill: true,
      asLegacy: { tags: [62], dropped: [15] },
    });
    expect(pending.find((r) => r.name === "OPT Edited")?.matchesBackfill).toBe(false);
    expect(s.dropped).toEqual([]);
    const edited = await byName("OPT Edited");
    expect(edited?.optTags).toEqual([2, 17]);
    expect(edited?.optTagsSpec).toBeUndefined();
    expect(edited?.openprinttagSnapshot).toEqual({ optTags: [17] }); // waits for the user's answer
    const linked = await byName("Vendor Tag Linked");
    expect(linked?.optTags).toEqual([30, 4]);
    expect(linked?.optTagsSpec).toBe(true);
    expect(linked?.openprinttagSnapshot).toEqual({ optTags: [20] });
    expect(linked?.updatedAt).toEqual(NOW); // the snapshot changed, so the peer should see it
  });

  it("includes trashed rows (they can be restored) and counts a lost conditional write as skipped", async () => {
    await col().insertMany([
      { name: "Trashed Legacy", vendor: "V", type: "PLA", optTags: [18], _deletedAt: OLD },
    ]);
    const s = await renumberOptTags(db(), NOW);
    expect(s).toMatchObject({ scanned: 1, converted: 1 });
    expect((await byName("Trashed Legacy"))?.optTags).toEqual([57]);

    // A write whose exact-array condition no longer matches (an edit landed
    // between read and write) is a skip, not a conversion, and leaves the
    // flag's settle condition false so the next connect revisits the row.
    // 9 FLEXIBLE drops on conversion, so a drop record WOULD be written.
    await col().insertOne({ name: "Raced", vendor: "V", type: "PLA", optTags: [18, 2, 9] });
    const real = mongoose.connection.db!;
    const racing: MinimalRenumberDb = {
      collection: (name) => {
        const c = real.collection(name);
        if (name !== "filaments") return c as unknown as ReturnType<MinimalRenumberDb["collection"]>;
        type Filter = Record<string, unknown>;
        type Opts = { projection?: Record<string, unknown> };
        return {
          find: (f: Filter, o?: Opts) => c.find(f, o),
          findOne: (f: Filter, o?: Opts) => c.findOne(f, o),
          updateOne: async (filter: Filter, update: Filter, options?: { upsert?: boolean }) => {
            // Simulate the concurrent edit: change the array first, then run the real write.
            await c.updateOne({ _id: (filter as { _id: unknown })._id as never }, { $set: { optTags: [18, 2, 9, 16] } });
            return c.updateOne(filter, update, options);
          },
        } as unknown as ReturnType<MinimalRenumberDb["collection"]>;
      },
    };
    const raced = await renumberOptTags(racing, NOW);
    expect(raced).toMatchObject({ scanned: 1, converted: 0, skipped: 1 });
    const row = await byName("Raced");
    expect(row?.optTags).toEqual([18, 2, 9, 16]); // the edit survived, untouched
    expect(row?.optTagsSpec).toBeUndefined();
    // No drop was recorded for a conversion that did not land (the pre-write
    // record is pulled back on a skip).
    expect(await readDroppedLegacyTags(db())).toEqual([]);
    // The next pass picks it up — and records the drop exactly once.
    expect(await renumberOptTags(db(), NOW)).toMatchObject({ scanned: 1, converted: 1, skipped: 0 });
    expect((await byName("Raced"))?.optTags).toEqual([57, 20, 16]);
    expect(await readDroppedLegacyTags(db())).toEqual([expect.objectContaining({ name: "Raced", tags: [9] })]);
  });

  it("describeRenumberSummary is quiet when nothing was scanned", async () => {
    expect(describeRenumberSummary(await renumberOptTags(db(), NOW))).toBeNull();
    await col().insertOne({ name: "L", vendor: "V", type: "PLA", optTags: [18, 9] });
    const line = describeRenumberSummary(await renumberOptTags(db(), NOW));
    expect(line).toContain("converted 1");
    expect(line).toContain("L [9]");
  });
});

describe("scanUnverifiedOptTags + resolveOptTagNumbering (Data health)", () => {
  const db = () => mongoose.connection.db as unknown as MinimalRenumberDb;
  const col = () => mongoose.connection.collection("filaments");
  const markers = () => mongoose.connection.collection("_migrations");
  const NOW = new Date("2026-10-08T12:00:00.000Z");

  beforeEach(async () => {
    await col().deleteMany({});
    await markers().deleteMany({});
  });

  it("lists only the unsettled rows, with both readings, trashed flagged and purged excluded", async () => {
    await col().insertMany([
      { name: "Zed Ambiguous", vendor: "V", type: "TPU", optTags: [9, 4] },
      { name: "Alpha Inconsistent", vendor: "V", type: "PLA", optTags: [18, 30], _deletedAt: new Date() },
      { name: "Purged", vendor: "V", type: "PLA", optTags: [2], _purged: true, _deletedAt: new Date() },
      { name: "Verified", vendor: "V", type: "PLA", optTags: [2], optTagsSpec: true },
      { name: "Trivial", vendor: "V", type: "PLA", optTags: [4] },
    ]);
    const pending = await scanUnverifiedOptTags(db());
    expect(pending.map((p) => p.name)).toEqual(["Alpha Inconsistent", "Zed Ambiguous"]);
    expect(pending[1]).toMatchObject({
      vendor: "V",
      type: "TPU",
      trashed: false,
      verdict: "ambiguous",
      stored: [9, 4],
      asLegacy: { tags: [4], dropped: [9] },
      asSpec: [9, 4],
    });
    expect(pending[0]).toMatchObject({ trashed: true, verdict: "inconsistent" });
  });

  it("convert translates + marks (recording drops); keep marks as is; both translate the snapshot", async () => {
    const { insertedIds } = await col().insertMany([
      { name: "Conv", vendor: "V", type: "TPU", optTags: [9, 2], openprinttagSnapshot: { optTags: [2] } },
      { name: "Keep", vendor: "V", type: "PLA", optTags: [12], openprinttagSnapshot: { optTags: [12] } },
    ]);
    const conv = await resolveOptTagNumbering(db(), insertedIds[0], "convert", [2, 9], NOW);
    expect(conv).toEqual({ outcome: "converted", tags: [20], dropped: [9] });
    const convRow = await col().findOne({ _id: insertedIds[0] });
    expect(convRow).toMatchObject({ optTags: [20], optTagsSpec: true, updatedAt: NOW, openprinttagSnapshot: { optTags: [20] } });
    expect(await readDroppedLegacyTags(db())).toEqual([
      { filamentId: String(insertedIds[0]), name: "Conv", tags: [9], at: NOW },
    ]);

    const keep = await resolveOptTagNumbering(db(), insertedIds[1], "keep", [12], NOW);
    expect(keep).toEqual({ outcome: "kept", tags: [12] });
    const keepRow = await col().findOne({ _id: insertedIds[1] });
    expect(keepRow).toMatchObject({ optTags: [12], optTagsSpec: true, openprinttagSnapshot: { optTags: [62] } });

    await dismissDroppedLegacyTags(db());
    expect(await readDroppedLegacyTags(db())).toEqual([]);
  });

  it("refuses when the row changed since the scan, is already verified, or is gone", async () => {
    const { insertedIds } = await col().insertMany([
      { name: "Edited", vendor: "V", type: "PLA", optTags: [2, 16] },
      { name: "Done", vendor: "V", type: "PLA", optTags: [2], optTagsSpec: true },
    ]);
    expect(await resolveOptTagNumbering(db(), insertedIds[0], "convert", [2], NOW)).toEqual({ outcome: "changed" });
    expect((await col().findOne({ _id: insertedIds[0] }))?.optTags).toEqual([2, 16]); // untouched
    expect(await resolveOptTagNumbering(db(), insertedIds[1], "keep", [2], NOW)).toEqual({ outcome: "changed" });
    expect(await resolveOptTagNumbering(db(), new mongoose.Types.ObjectId(), "keep", [], NOW)).toEqual({ outcome: "not_found" });
  });
});

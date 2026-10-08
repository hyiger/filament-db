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
 * GH #1227 — the pass that marks stored `optTags` already on the OpenPrintTag
 * spec numbering (and converts NOTHING — no stored content proves the legacy
 * numbering; see the classifier's docblock), plus the Data health resolution
 * that applies the user's answer. Raw inserts throughout: these are the states
 * the pre-#1227 app (and vendor NFC reads) actually produced, with no
 * `optTagsSpec` marker.
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

  it("marks trivially-spec rows, leaves every other row unmarked — converts nothing — and is idempotent", async () => {
    await col().insertMany([
      // OPT provenance (a pre-v1.83 snapshot equal to the array) is a HINT
      // since Codex P1 r12: the link route stores a snapshot without touching
      // the array, so an NFC-created row linked before the upgrade reads the
      // same. The user converts it on Data health; the pass does not.
      {
        name: "Legacy Marble", vendor: "V", type: "PLA", optTags: [18, 2, 9], updatedAt: OLD,
        settings: { openprinttag_slug: "marble" }, openprinttagSnapshot: { optTags: [9, 2, 18] },
      },
      // Spec-only 30 is a HINT, not proof — the legacy CSV importer could store
      // it beside a legacy 12 (Codex P1 r3) → ambiguous, listed with the hint.
      { name: "PC Blend CF", vendor: "Prusament", type: "PC", optTags: [31, 12, 4, 30], updatedAt: OLD },
      // Only fixed points → nothing to translate.
      { name: "Plain Abrasive", vendor: "V", type: "PLA", optTags: [4, 16], updatedAt: OLD },
      { name: "No Tags", vendor: "V", type: "PLA", optTags: [], updatedAt: OLD },
      // Valid under both readings, nothing outside the array → the user's call.
      { name: "Ambiguous Transparent", vendor: "V", type: "PETG", optTags: [2], updatedAt: OLD },
      // 18 and a spec-only 30: two hints, no proof → the user's call.
      { name: "Two Hints", vendor: "V", type: "PLA", optTags: [18, 30], updatedAt: OLD },
    ]);

    const first = await renumberOptTags(db(), NOW);
    expect(first).toEqual({ scanned: 6, verified: 2, ambiguous: 4, skipped: 0 });

    const marble = await byName("Legacy Marble");
    expect(marble?.optTags).toEqual([18, 2, 9]); // untouched — the user's call, with the provenance hint
    expect(marble?.optTagsSpec).toBeUndefined();
    expect(marble?.openprinttagSnapshot).toEqual({ optTags: [9, 2, 18] }); // waits with the row
    expect(marble?.updatedAt).toEqual(OLD);
    const pending = await scanUnverifiedOptTags(db());
    expect(pending.find((r) => r.name === "Legacy Marble")).toMatchObject({
      matchesOptProvenance: true,
      legacyOnlyIds: [18],
      asLegacy: { tags: [57, 20], dropped: [9] },
    });

    const pc = await byName("PC Blend CF");
    expect(pc?.optTags).toEqual([31, 12, 4, 30]); // untouched
    expect(pc?.optTagsSpec).toBeUndefined(); // the user's call, on Data health with the spec-only hint
    expect(pending.find((r) => r.name === "PC Blend CF")).toMatchObject({ matchesOptProvenance: false, specOnlyIds: [30] });

    // The pass never touches updatedAt (Codex P1 r7): both hybrid peers run it
    // before copying, so a synthetic timestamp could only let a stale document
    // win LWW over the other side's genuinely newer edits.
    expect(await byName("Plain Abrasive")).toMatchObject({ optTags: [4, 16], optTagsSpec: true, updatedAt: OLD });
    expect(await byName("No Tags")).toMatchObject({ optTags: [], optTagsSpec: true, updatedAt: OLD });

    expect(await byName("Ambiguous Transparent")).toMatchObject({ optTags: [2] });
    expect((await byName("Ambiguous Transparent"))?.optTagsSpec).toBeUndefined();
    expect(await byName("Two Hints")).toMatchObject({ optTags: [18, 30] });
    expect((await byName("Two Hints"))?.optTagsSpec).toBeUndefined();

    // Idempotent: the second pass sees only the four unsettled rows and writes nothing.
    const second = await renumberOptTags(db(), new Date("2026-10-09T00:00:00.000Z"));
    expect(second).toEqual({ scanned: 4, verified: 0, ambiguous: 4, skipped: 0 });
    expect((await byName("Legacy Marble"))?.optTags).toEqual([18, 2, 9]);

    // The run is recorded; the pass never drops anything, so there is no record of drops.
    const marker = await markers().findOne({ _id: OPT_TAG_RENUMBER_MARKER_ID as never });
    expect(marker?.lastRun).toMatchObject({ scanned: 4 });
    expect(marker?.dropped).toBeUndefined();
    expect(await readDroppedLegacyTags(db())).toEqual([]);
  });

  it("OpenPrintTag provenance is a hint, never a conversion; a trivial row's legacy snapshot is still translated", async () => {
    await col().insertMany([
      // Imported from the OPT database before v1.83: the snapshot (legacy by
      // construction) equals the stored array. LIKELY the importer wrote the
      // array — but a vendor-NFC row linked before the upgrade reads the same.
      {
        name: "OPT Imported", vendor: "V", type: "PLA", optTags: [17, 27],
        settings: { openprinttag_slug: "v-pla" }, openprinttagSnapshot: { optTags: [27, 17], density: 1.24 },
      },
      // Pre-snapshot (v1.36) import shape: slug, no snapshot object. A bare slug
      // also rides the slicer round-trip and the share import, so: a hint.
      { name: "OPT Old Import", vendor: "V", type: "PLA", optTags: [3], settings: { openprinttag_slug: "v-old" } },
      // The backfill script's exact output for this name + type — likely legacy,
      // but a vendor tag could carry the same set, so NOT converted (Codex P1).
      { name: "Prusament PLA Galaxy Black", vendor: "Prusament", type: "PLA", optTags: [12, 15] },
      // Snapshot DIFFERS → edited in the legacy form, or an NFC row linked later: no hint.
      {
        name: "OPT Edited", vendor: "V", type: "PLA", optTags: [2, 17],
        settings: { openprinttag_slug: "v-ed" }, openprinttagSnapshot: { optTags: [17] },
      },
      // Trivial row (30 and 4 are both remap-invariant) with a legacy snapshot:
      // marked, and the snapshot is translated.
      {
        name: "Vendor Tag Linked", vendor: "V", type: "PC", optTags: [30, 4], updatedAt: OLD,
        settings: { openprinttag_slug: "v-pc" }, openprinttagSnapshot: { optTags: [2] },
      },
    ]);

    const s = await renumberOptTags(db(), NOW);
    expect(s).toEqual({ scanned: 5, verified: 1, ambiguous: 4, skipped: 0 });

    const imported = await byName("OPT Imported");
    expect(imported?.optTags).toEqual([17, 27]); // untouched
    expect(imported?.optTagsSpec).toBeUndefined();
    expect(imported?.openprinttagSnapshot).toEqual({ optTags: [27, 17], density: 1.24 }); // waits with the row
    expect((await byName("OPT Old Import"))?.optTags).toEqual([3]);
    const galaxy = await byName("Prusament PLA Galaxy Black");
    expect(galaxy?.optTags).toEqual([12, 15]); // untouched, unmarked — Data health with the hint
    expect(galaxy?.optTagsSpec).toBeUndefined();

    const pending = await scanUnverifiedOptTags(db());
    expect(pending.map((r) => [r.name, r.matchesOptProvenance, r.matchesBackfill])).toEqual([
      ["OPT Edited", false, false],
      ["OPT Imported", true, false],
      ["OPT Old Import", true, false],
      ["Prusament PLA Galaxy Black", false, true],
    ]);
    expect(pending.find((r) => r.name === "Prusament PLA Galaxy Black")).toMatchObject({
      verdict: "ambiguous",
      asLegacy: { tags: [62], dropped: [15] },
    });

    const linked = await byName("Vendor Tag Linked");
    expect(linked?.optTags).toEqual([30, 4]);
    expect(linked?.optTagsSpec).toBe(true);
    // The legacy snapshot is translated AND stamped so it is never translated twice.
    expect(linked?.openprinttagSnapshot).toEqual({ optTags: [20], tagsNumbering: "spec" });
    expect(linked?.updatedAt).toEqual(OLD); // a per-peer rewrite, not an edit to propagate

    // The conversion the USER asks for (the bulk "imported from OpenPrintTag"
    // action is this per row) translates the snapshot alongside the array.
    expect(await resolveOptTagNumbering(db(), imported!._id, "convert", [17, 27], NOW)).toEqual({
      outcome: "converted",
      tags: [17, 28],
      dropped: [],
    });
    expect(await byName("OPT Imported")).toMatchObject({
      optTags: [17, 28],
      optTagsSpec: true,
      updatedAt: NOW,
      openprinttagSnapshot: { optTags: [28, 17], density: 1.24, tagsNumbering: "spec" },
    });
  });

  it("includes trashed rows (they can be restored)", async () => {
    await col().insertMany([
      { name: "Trashed Trivial", vendor: "V", type: "PLA", optTags: [4], _deletedAt: OLD },
      { name: "Trashed Pending", vendor: "V", type: "PLA", optTags: [18], _deletedAt: OLD, settings: { openprinttag_slug: "t" } },
    ]);
    expect(await renumberOptTags(db(), NOW)).toEqual({ scanned: 2, verified: 1, ambiguous: 1, skipped: 0 });
    expect(await byName("Trashed Trivial")).toMatchObject({ optTags: [4], optTagsSpec: true, _deletedAt: OLD });
    expect(await byName("Trashed Pending")).toMatchObject({ optTags: [18], _deletedAt: OLD });
    expect((await byName("Trashed Pending"))?.optTagsSpec).toBeUndefined();
    expect(await scanUnverifiedOptTags(db())).toEqual([
      expect.objectContaining({ name: "Trashed Pending", trashed: true, matchesOptProvenance: true, legacyOnlyIds: [18] }),
    ]);
  });

  it("marks and resolves rows stored in the SCHEMA shape — `openprinttagSnapshot: null`, `settings: {}` — which is every row the pre-v1.83 app saved", async () => {
    // The other fixtures here are bare raw inserts (fields absent). A row the
    // old app wrote through Mongoose carries the schema defaults instead, and
    // a child-path projection over a `null` container drops the container, so
    // the pin read "absent" and the conditional write never matched: CI on PR
    // #1228 showed the pass skipping such a row on EVERY connect once a
    // fixture was written through the schema. Pin the stored shape verbatim.
    await col().insertMany([
      { name: "Schema Trivial", vendor: "V", type: "PLA", optTags: [4], openprinttagSnapshot: null, settings: {}, updatedAt: OLD },
      { name: "Schema Pending", vendor: "V", type: "PETG", optTags: [2], openprinttagSnapshot: null, settings: {}, updatedAt: OLD },
      // A linked row saved by the old app after v1.36 but before any snapshot
      // was written: slug present, container still the `null` default.
      { name: "Schema Linked", vendor: "V", type: "PLA", optTags: [18, 9], openprinttagSnapshot: null, settings: { openprinttag_slug: "s" }, updatedAt: OLD },
    ]);
    expect(await renumberOptTags(db(), NOW)).toEqual({ scanned: 3, verified: 1, ambiguous: 2, skipped: 0 });
    expect(await byName("Schema Trivial")).toMatchObject({ optTags: [4], optTagsSpec: true, openprinttagSnapshot: null, updatedAt: OLD });
    expect((await byName("Schema Pending"))?.optTagsSpec).toBeUndefined();
    // A `null` container is "no snapshot object": the link alone carries the hint.
    expect((await scanUnverifiedOptTags(db())).map((r) => [r.name, r.matchesOptProvenance])).toEqual([
      ["Schema Linked", true],
      ["Schema Pending", false],
    ]);
    // Settled: the second pass has nothing left to skip.
    expect(await renumberOptTags(db(), NOW)).toEqual({ scanned: 2, verified: 0, ambiguous: 2, skipped: 0 });

    // Data health resolves the same shape (same projection, same pins).
    const pending = (await byName("Schema Pending"))!;
    expect(await resolveOptTagNumbering(db(), pending._id, "keep", [2], NOW)).toEqual({ outcome: "kept", tags: [2] });
    expect(await byName("Schema Pending")).toMatchObject({ optTags: [2], optTagsSpec: true, openprinttagSnapshot: null });
    const linked = (await byName("Schema Linked"))!;
    expect(await resolveOptTagNumbering(db(), linked._id, "convert", [18, 9], NOW)).toEqual({ outcome: "converted", tags: [57], dropped: [9] });
    expect(await byName("Schema Linked")).toMatchObject({ optTags: [57], optTagsSpec: true, openprinttagSnapshot: null });
    expect(await readDroppedLegacyTags(db())).toEqual([expect.objectContaining({ name: "Schema Linked", tags: [9] })]);
  });

  it("a snapshot written since v1.83 hints nothing; a translated snapshot is never translated twice (Codex P1 r4)", async () => {
    await col().insertMany([
      // An NFC-created spec [2] LINKED after upgrading: the link route's
      // snapshot equals it and says it is spec-numbered → no provenance hint.
      {
        name: "Linked After", vendor: "V", type: "PLA", optTags: [2],
        settings: { openprinttag_slug: "l" }, openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" },
      },
      // A legacy snapshot equal to the array: the hint, and nothing more.
      {
        name: "Legacy Snap", vendor: "V", type: "PLA", optTags: [18, 2],
        settings: { openprinttag_slug: "m" }, openprinttagSnapshot: { optTags: [18, 2] },
      },
    ]);
    expect(await renumberOptTags(db(), NOW)).toEqual({ scanned: 2, verified: 0, ambiguous: 2, skipped: 0 });
    const after = await byName("Linked After");
    expect(after?.optTags).toEqual([2]); // NOT remapped to 20
    expect(after?.optTagsSpec).toBeUndefined();
    const snap = await byName("Legacy Snap");
    expect(snap?.openprinttagSnapshot).toEqual({ optTags: [18, 2] }); // untouched until the user decides
    expect((await scanUnverifiedOptTags(db())).map((r) => [r.name, r.matchesOptProvenance])).toEqual([
      ["Legacy Snap", true],
      ["Linked After", false],
    ]);

    // Convert translates the legacy snapshot and stamps it.
    expect(await resolveOptTagNumbering(db(), snap!._id, "convert", [18, 2], NOW)).toEqual({
      outcome: "converted",
      tags: [57, 20],
      dropped: [],
    });
    expect((await byName("Legacy Snap"))?.openprinttagSnapshot).toEqual({ optTags: [57, 20], tagsNumbering: "spec" });
    // Keep runs the snapshot step too — the marker stops a second translation
    // of an already-spec snapshot.
    expect(await resolveOptTagNumbering(db(), after!._id, "keep", [2], NOW)).toEqual({ outcome: "kept", tags: [2] });
    expect((await byName("Linked After"))?.openprinttagSnapshot).toEqual({ optTags: [2], tagsNumbering: "spec" });
  });

  it("skips a row whose classifier inputs changed between the read and the write — array, snapshot or container alike (Codex P1 r6/r10)", async () => {
    // Read as trivial [4]; replaced with an ambiguous legacy [2] before the
    // write lands (another desktop, the sync service). Pinning only the id and
    // marker would have stamped the [2] as verified spec = antibacterial.
    await col().insertOne({ name: "Swapped", vendor: "V", type: "PLA", optTags: [4] });
    const real = mongoose.connection.db!;
    type Filter = Record<string, unknown>;
    type Opts = { projection?: Record<string, unknown> };
    const interposing = (before: (id: unknown) => Promise<unknown>): MinimalRenumberDb => ({
      collection: (name) => {
        const c = real.collection(name);
        if (name !== "filaments") return c as unknown as ReturnType<MinimalRenumberDb["collection"]>;
        return {
          find: (f: Filter, o?: Opts) => c.find(f, o),
          findOne: (f: Filter, o?: Opts) => c.findOne(f, o),
          updateOne: async (filter: Filter, update: Filter, options?: { upsert?: boolean }) => {
            await before((filter as { _id: unknown })._id);
            return c.updateOne(filter, update, options);
          },
        } as unknown as ReturnType<MinimalRenumberDb["collection"]>;
      },
    });
    const swapping = interposing((id) => real.collection("filaments").updateOne({ _id: id as never }, { $set: { optTags: [2] } }));
    expect(await renumberOptTags(swapping, NOW)).toEqual({ scanned: 1, verified: 0, ambiguous: 0, skipped: 1 });
    const swapped = await byName("Swapped");
    expect(swapped?.optTags).toEqual([2]);
    expect(swapped?.optTagsSpec).toBeUndefined(); // reclassified next pass: ambiguous → Data health
    expect(await renumberOptTags(db(), NOW)).toEqual({ scanned: 1, verified: 0, ambiguous: 1, skipped: 0 });

    // The snapshot is pinned too: a trivial row whose legacy snapshot the pass
    // would translate is re-linked to a spec-marked snapshot between the read
    // and the write. Writing the stale translation would turn a spec [2] into [20].
    await col().deleteMany({ name: "Swapped" }); // isolate the next sub-scenario's counts
    await col().insertOne({
      name: "Relinked", vendor: "V", type: "PLA", optTags: [4],
      settings: { openprinttag_slug: "a" }, openprinttagSnapshot: { optTags: [2] },
    });
    const relinking = interposing((id) =>
      real.collection("filaments").updateOne(
        { _id: id as never },
        { $set: { "settings.openprinttag_slug": "b", openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" } } },
      ),
    );
    expect(await renumberOptTags(relinking, NOW)).toEqual({ scanned: 1, verified: 0, ambiguous: 0, skipped: 1 });
    expect(await byName("Relinked")).toMatchObject({ optTags: [4], openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" } }); // intact
    expect((await byName("Relinked"))?.optTagsSpec).toBeUndefined();
    expect(await renumberOptTags(db(), NOW)).toEqual({ scanned: 1, verified: 1, ambiguous: 0, skipped: 0 });
    expect(await byName("Relinked")).toMatchObject({ optTagsSpec: true, openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" } }); // never re-translated

    // The snapshot CONTAINER is pinned too (Codex P1 r10): a row read with NO
    // snapshot object gains one (a whole-document copy landing in between).
    // Both shapes satisfy the children's `$exists: false` pins; only the
    // container pin tells them apart.
    await col().deleteMany({ name: "Relinked" });
    await col().insertOne({ name: "Snapshot Gained", vendor: "V", type: "PLA", optTags: [4], settings: { openprinttag_slug: "g" } });
    const gaining = interposing((id) =>
      real.collection("filaments").updateOne({ _id: id as never }, { $set: { openprinttagSnapshot: { optTags: [2] } } }),
    );
    expect(await renumberOptTags(gaining, NOW)).toEqual({ scanned: 1, verified: 0, ambiguous: 0, skipped: 1 });
    expect(await byName("Snapshot Gained")).toMatchObject({ optTags: [4], openprinttagSnapshot: { optTags: [2] } }); // untouched
    expect((await byName("Snapshot Gained"))?.optTagsSpec).toBeUndefined();
    // The next pass reads the row as it now stands and translates the snapshot it actually saw.
    expect(await renumberOptTags(db(), NOW)).toEqual({ scanned: 1, verified: 1, ambiguous: 0, skipped: 0 });
    expect(await byName("Snapshot Gained")).toMatchObject({ optTagsSpec: true, openprinttagSnapshot: { optTags: [20], tagsNumbering: "spec" } });
  });

  it("describeRenumberSummary is quiet when nothing was scanned and never reports a conversion", async () => {
    expect(describeRenumberSummary(await renumberOptTags(db(), NOW))).toBeNull();
    await col().insertMany([
      { name: "T", vendor: "V", type: "PLA", optTags: [4] },
      { name: "L", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "l" } },
    ]);
    const line = describeRenumberSummary(await renumberOptTags(db(), NOW));
    expect(line).toContain("verified 1");
    expect(line).toContain("awaiting review 1");
    expect(line).not.toContain("converted");
    expect(line).not.toContain("skipped");
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
      // A spec-only id beside an ambiguous one: listed with the hint (Codex P1 r3).
      { name: "Alpha Spec Hint", vendor: "V", type: "PLA", optTags: [2, 30], _deletedAt: new Date() },
      { name: "Purged", vendor: "V", type: "PLA", optTags: [2], _purged: true, _deletedAt: new Date() },
      { name: "Verified", vendor: "V", type: "PLA", optTags: [2], optTagsSpec: true },
      { name: "Trivial", vendor: "V", type: "PLA", optTags: [4] },
    ]);
    const pending = await scanUnverifiedOptTags(db());
    expect(pending.map((p) => p.name)).toEqual(["Alpha Spec Hint", "Zed Ambiguous"]);
    expect(pending[1]).toMatchObject({
      vendor: "V",
      type: "TPU",
      trashed: false,
      verdict: "ambiguous",
      matchesOptProvenance: false,
      stored: [9, 4],
      asLegacy: { tags: [4], dropped: [9] },
      asSpec: [9, 4],
    });
    expect(pending[1].specOnlyIds).toEqual([]);
    expect(pending[1].legacyOnlyIds).toEqual([]);
    expect(pending[0]).toMatchObject({
      trashed: true,
      verdict: "ambiguous",
      matchesOptProvenance: false,
      matchesBackfill: false,
      specOnlyIds: [30],
      legacyOnlyIds: [],
      stored: [2, 30],
      asLegacy: { tags: [20, 30], dropped: [] },
      asSpec: [2, 30],
    });
  });

  it("refuses when the snapshot or link changed under it, so a re-linked spec snapshot is never overwritten with a stale remap (Codex P2 r8)", async () => {
    const { insertedId } = await col().insertOne({
      name: "Relink Manual", vendor: "V", type: "PLA", optTags: [2],
      settings: { openprinttag_slug: "a" }, openprinttagSnapshot: { optTags: [2] },
    });
    const real = mongoose.connection.db!;
    type Filter = Record<string, unknown>;
    type Opts = { projection?: Record<string, unknown> };
    const relinking: MinimalRenumberDb = {
      collection: (name) => {
        const c = real.collection(name);
        if (name !== "filaments") return c as unknown as ReturnType<MinimalRenumberDb["collection"]>;
        return {
          find: (f: Filter, o?: Opts) => c.find(f, o),
          findOne: (f: Filter, o?: Opts) => c.findOne(f, o),
          updateOne: async (filter: Filter, update: Filter, options?: { upsert?: boolean }) => {
            // The link route re-links the row between the read and the write.
            await c.updateOne(
              { _id: (filter as { _id: unknown })._id as never },
              { $set: { "settings.openprinttag_slug": "b", openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" } } },
            );
            return c.updateOne(filter, update, options);
          },
        } as unknown as ReturnType<MinimalRenumberDb["collection"]>;
      },
    };
    expect(await resolveOptTagNumbering(relinking, insertedId, "convert", [2], NOW)).toEqual({ outcome: "changed" });
    expect(await col().findOne({ _id: insertedId })).toMatchObject({
      optTags: [2],
      openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" }, // intact, not remapped to [20]
    });
    expect((await col().findOne({ _id: insertedId }))?.optTagsSpec).toBeUndefined();
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

  it("refuses when the hints the page showed no longer hold — a re-link between the scan and the click (Codex P2 r14)", async () => {
    // Listed with the `opt-provenance` hint (a legacy snapshot equal to the
    // array), which is what the bulk "imported from OpenPrintTag" action
    // selects on. Before the click, a re-link swaps the snapshot for a
    // spec-marked one: the array is still [2], so the array pin matches, and
    // the write pins the NEW snapshot — only the echoed hints catch it.
    const { insertedId } = await col().insertOne({
      name: "Relinked Hint", vendor: "V", type: "PLA", optTags: [2],
      settings: { openprinttag_slug: "a" }, openprinttagSnapshot: { optTags: [2] },
    });
    const shown = (await scanUnverifiedOptTags(db())).find((r) => r.name === "Relinked Hint")!;
    expect(shown.hints).toEqual(["opt-provenance"]);
    expect(shown.matchesOptProvenance).toBe(true);
    await col().updateOne({ _id: insertedId }, { $set: { openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" } } });
    expect(await resolveOptTagNumbering(db(), insertedId, "convert", [2], NOW, shown.hints)).toEqual({ outcome: "changed" });
    expect(await col().findOne({ _id: insertedId })).toMatchObject({ optTags: [2], openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" } });
    expect((await col().findOne({ _id: insertedId }))?.optTagsSpec).toBeUndefined();
    // A fresh scan shows no hint; a decision made against THAT applies.
    const rescanned = (await scanUnverifiedOptTags(db())).find((r) => r.name === "Relinked Hint")!;
    expect(rescanned.hints).toEqual([]);
    expect(await resolveOptTagNumbering(db(), insertedId, "convert", [2], NOW, rescanned.hints)).toEqual({ outcome: "converted", tags: [20], dropped: [] });
    // Order within the set does not matter; an omitted echo (an older caller) is not checked.
    const { insertedId: twoHints } = await col().insertOne({ name: "Two Hints", vendor: "V", type: "PLA", optTags: [18, 30], settings: { openprinttag_slug: "t" } });
    expect(await resolveOptTagNumbering(db(), twoHints, "keep", [18, 30], NOW, ["spec-only-id", "legacy-only-id", "opt-provenance"])).toEqual({ outcome: "kept", tags: [18, 30] });
    const { insertedId: unchecked } = await col().insertOne({ name: "Unchecked", vendor: "V", type: "PLA", optTags: [2], settings: { openprinttag_slug: "u" } });
    expect(await resolveOptTagNumbering(db(), unchecked, "keep", [2], NOW)).toEqual({ outcome: "kept", tags: [2] });
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

  type Filter = Record<string, unknown>;
  type Opts = { projection?: Record<string, unknown> };
  /** A `filaments` collection whose `updateOne` runs `around` first; everything else is real. */
  const wrapping = (around: (filter: Filter, update: Filter) => Promise<unknown>): MinimalRenumberDb => {
    const real = mongoose.connection.db!;
    return {
      collection: (name) => {
        const c = real.collection(name);
        if (name !== "filaments") return c as unknown as ReturnType<MinimalRenumberDb["collection"]>;
        return {
          find: (f: Filter, o?: Opts) => c.find(f, o),
          findOne: (f: Filter, o?: Opts) => c.findOne(f, o),
          updateOne: async (filter: Filter, update: Filter, options?: { upsert?: boolean }) => {
            await around(filter, update);
            return c.updateOne(filter, update, options);
          },
        } as unknown as ReturnType<MinimalRenumberDb["collection"]>;
      },
    };
  };
  const byName = (n: string) => col().findOne({ name: n });
  const OLD = new Date("2026-01-01T00:00:00.000Z");

  it("a conversion write that THROWS pulls back its pre-written drop record; a retry records it exactly once (Codex P2 r4)", async () => {
    const { insertedId } = await col().insertOne({ name: "Throws", vendor: "V", type: "TPU", optTags: [9, 2] }); // 9 FLEXIBLE drops
    let throwOnce = true;
    const failing = wrapping(async () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("socket closed");
      }
    });
    await expect(resolveOptTagNumbering(failing, insertedId, "convert", [9, 2], NOW)).rejects.toThrow("socket closed");
    expect(await readDroppedLegacyTags(db())).toEqual([]); // pulled back
    expect((await byName("Throws"))?.optTagsSpec).toBeUndefined();

    // A stale record the cleanup could not remove (database gone) is REPLACED
    // by the retry, not stacked beside a second notice.
    await markers().updateOne(
      { _id: OPT_TAG_RENUMBER_MARKER_ID as never },
      // The driver's typed $push wants the array's element type declared; this is a raw fixture write.
      { $push: { dropped: { filamentId: String(insertedId), name: "Throws", tags: [9], at: OLD } } } as never,
      { upsert: true },
    );
    expect(await resolveOptTagNumbering(db(), insertedId, "convert", [9, 2], NOW)).toMatchObject({ outcome: "converted", dropped: [9] });
    expect(await readDroppedLegacyTags(db())).toEqual([{ filamentId: String(insertedId), name: "Throws", tags: [9], at: NOW }]);
  });

  it("an ACK-LOST conversion keeps its drop record — the write committed (Codex P2 r5)", async () => {
    // The write COMMITS but the driver throws before the acknowledgement
    // arrives. The record must SURVIVE — nothing revisits a marked row, so
    // pulling it would hide the removed tags for good.
    const { insertedId } = await col().insertOne({ name: "Ack Lost", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "ack" } });
    const real = mongoose.connection.db!;
    let ackLostOnce = true;
    const ackLost: MinimalRenumberDb = {
      collection: (name) => {
        const c = real.collection(name);
        if (name !== "filaments") return c as unknown as ReturnType<MinimalRenumberDb["collection"]>;
        return {
          find: (f: Filter, o?: Opts) => c.find(f, o),
          findOne: (f: Filter, o?: Opts) => c.findOne(f, o),
          updateOne: async (filter: Filter, update: Filter, options?: { upsert?: boolean }) => {
            const res = await c.updateOne(filter, update, options);
            if (ackLostOnce) {
              ackLostOnce = false;
              throw new Error("connection reset before ack");
            }
            return res;
          },
        } as unknown as ReturnType<MinimalRenumberDb["collection"]>;
      },
    };
    await expect(resolveOptTagNumbering(ackLost, insertedId, "convert", [18, 9], NOW)).rejects.toThrow("connection reset before ack");
    expect(await byName("Ack Lost")).toMatchObject({ optTags: [57], optTagsSpec: true }); // the write landed
    expect(await readDroppedLegacyTags(db())).toEqual([expect.objectContaining({ name: "Ack Lost", tags: [9] })]);
    // The retry finds the row settled and leaves the one record alone.
    expect(await resolveOptTagNumbering(db(), insertedId, "convert", [18, 9], NOW)).toEqual({ outcome: "changed" });
    expect(await readDroppedLegacyTags(db())).toHaveLength(1);
  });

  it("two concurrent conversions of one row leave exactly ONE drop record — the replacement is atomic (Codex P2 r10)", async () => {
    const { insertedId } = await col().insertOne({ name: "Twice", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "tw" } });
    // Both read the row unmarked; each records (an atomic replace, so the
    // second supersedes the first instead of stacking beside it); one
    // conversion lands, the other's conditional write matches nothing and
    // reconciles as "landed" — keeping the single record that remains.
    const [a, b] = await Promise.all([
      resolveOptTagNumbering(db(), insertedId, "convert", [18, 9], NOW),
      resolveOptTagNumbering(db(), insertedId, "convert", [18, 9], new Date("2026-10-08T12:00:00.001Z")),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["changed", "converted"]);
    expect(await byName("Twice")).toMatchObject({ optTags: [57], optTagsSpec: true });
    const notices = await readDroppedLegacyTags(db());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ name: "Twice", tags: [9] });
  });

  it("an unmatched write that lost to a COMPETING identical conversion keeps the one remaining drop record (Codex P2 r8)", async () => {
    // A records, B records (replacing A's), A converts, B's conditional write
    // matches nothing. Pulling B's record here would leave the converted row
    // with no notice at all.
    const { insertedId } = await col().insertOne({ name: "Competing", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "c" } });
    const real = mongoose.connection.db!;
    const competing = wrapping(async (filter, update) => {
      // Competitor A lands the identical conversion first …
      await real.collection("filaments").updateOne({ _id: (filter as { _id: unknown })._id as never }, update as never);
      // … so B's conditional write (unmarked rows only) matches nothing.
    });
    expect(await resolveOptTagNumbering(competing, insertedId, "convert", [18, 9], NOW)).toEqual({ outcome: "changed" });
    expect(await byName("Competing")).toMatchObject({ optTags: [57], optTagsSpec: true });
    expect(await readDroppedLegacyTags(db())).toEqual([expect.objectContaining({ name: "Competing", tags: [9] })]);
  });

  it("refuses when a rename or re-type lands between the read and the write — the backfill hint depends on both (Codex P2 r15)", async () => {
    // Listed with the `backfill-derivation` hint for name + type; the echoed
    // hints pass against the read, then a sync renames the row before the
    // write. Unpinned, the write would apply a decision made on a hint the
    // row no longer carries.
    const { insertedId } = await col().insertOne({ name: "Prusament PLA Galaxy Black", vendor: "Prusament", type: "PLA", optTags: [12, 15] });
    const shown = (await scanUnverifiedOptTags(db())).find((r) => r.name === "Prusament PLA Galaxy Black")!;
    expect(shown.hints).toEqual(["backfill-derivation"]);
    const real = mongoose.connection.db!;
    const renaming = wrapping(async (filter) => {
      await real.collection("filaments").updateOne({ _id: (filter as { _id: unknown })._id as never }, { $set: { name: "Renamed" } });
    });
    expect(await resolveOptTagNumbering(renaming, insertedId, "convert", [12, 15], NOW, shown.hints)).toEqual({ outcome: "changed" });
    expect(await col().findOne({ _id: insertedId })).toMatchObject({ name: "Renamed", optTags: [12, 15] });
    expect((await col().findOne({ _id: insertedId }))?.optTagsSpec).toBeUndefined();
    expect(await readDroppedLegacyTags(db())).toEqual([]); // the pre-written record was pulled back
    // The same for the material type.
    await col().updateOne({ _id: insertedId }, { $set: { name: "Prusament PLA Galaxy Black" } });
    const retyping = wrapping(async (filter) => {
      await real.collection("filaments").updateOne({ _id: (filter as { _id: unknown })._id as never }, { $set: { type: "PETG" } });
    });
    expect(await resolveOptTagNumbering(retyping, insertedId, "convert", [12, 15], NOW, shown.hints)).toEqual({ outcome: "changed" });
    expect(await col().findOne({ _id: insertedId })).toMatchObject({ type: "PETG", optTags: [12, 15] });
    // Re-read, the row carries no hint; a decision made against THAT applies.
    const rescanned = (await scanUnverifiedOptTags(db())).find((r) => String(r.filamentId) === String(insertedId))!;
    expect(rescanned.hints).toEqual([]);
    expect(await resolveOptTagNumbering(db(), insertedId, "convert", [12, 15], NOW, rescanned.hints)).toEqual({ outcome: "converted", tags: [62], dropped: [15] });
  });

  it("dismisses only the EXACT records the page displayed — row and version; no list clears all (Codex P2 r7 + r16)", async () => {
    const { insertedIds } = await col().insertMany([
      { name: "Seen", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "s" } },
      { name: "Later", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "l" } },
    ]);
    await resolveOptTagNumbering(db(), insertedIds[0], "convert", [18, 9], NOW);
    const shown = (await readDroppedLegacyTags(db())).map((d) => ({ filamentId: d.filamentId, at: d.at }));
    expect(shown).toEqual([{ filamentId: String(insertedIds[0]), at: NOW }]);
    // A record appended after the page loaded survives the dismissal.
    await resolveOptTagNumbering(db(), insertedIds[1], "convert", [18, 9], NOW);
    await dismissDroppedLegacyTags(db(), shown);
    expect((await readDroppedLegacyTags(db())).map((d) => d.name)).toEqual(["Later"]);
    await dismissDroppedLegacyTags(db(), []); // nothing displayed → nothing removed
    expect(await readDroppedLegacyTags(db())).toHaveLength(1);

    // A REPLACEMENT for the same row survives too (Codex P2 r16): the row is
    // made reviewable again (a snapshot restore, a newer unverified hybrid
    // revision) and converted once more AFTER the page loaded — the new
    // record carries the same filamentId with a new `at`, and the stale
    // page's dismissal names the version it saw.
    const LATER = new Date("2026-10-08T13:00:00.000Z");
    const stale = (await readDroppedLegacyTags(db())).map((d) => ({ filamentId: d.filamentId, at: d.at }));
    await col().updateOne({ _id: insertedIds[1] }, { $set: { optTags: [9, 2] }, $unset: { optTagsSpec: "" } });
    expect(await resolveOptTagNumbering(db(), insertedIds[1], "convert", [9, 2], LATER)).toMatchObject({ outcome: "converted", dropped: [9] });
    expect(await readDroppedLegacyTags(db())).toEqual([expect.objectContaining({ name: "Later", at: LATER })]);
    await dismissDroppedLegacyTags(db(), stale); // the version the page showed is gone already
    expect(await readDroppedLegacyTags(db())).toEqual([expect.objectContaining({ name: "Later", at: LATER })]);
    // No list → everything (API callers that read the whole list themselves).
    await dismissDroppedLegacyTags(db());
    expect(await readDroppedLegacyTags(db())).toEqual([]);
  });
});

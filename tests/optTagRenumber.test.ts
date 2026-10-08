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
  mergeDroppedLegacyTags,
  reconcileMergedDroppedLegacyTags,
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
      // OPT provenance: a pre-v1.83 snapshot equal to the array → provably
      // legacy (18 alone is only a hint since Codex P1 r6). 9 FLEXIBLE drops.
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
    expect(first).toMatchObject({
      scanned: 6,
      converted: 1,
      verified: 2,
      ambiguous: 3,
      skipped: 0,
    });
    expect(first.dropped).toEqual([
      { filamentId: expect.any(String), name: "Legacy Marble", tags: [9], at: NOW },
    ]);

    const marble = await byName("Legacy Marble");
    expect(marble?.optTags).toEqual([57, 20]); // imitates_marble, transparent
    expect(marble?.optTagsSpec).toBe(true);
    // The pass never touches updatedAt (Codex P1 r7): both hybrid peers run it
    // before copying, so a synthetic timestamp could only let a stale document
    // win LWW over the other side's genuinely newer edits.
    expect(marble?.updatedAt).toEqual(OLD);

    const pc = await byName("PC Blend CF");
    expect(pc?.optTags).toEqual([31, 12, 4, 30]); // untouched
    expect(pc?.optTagsSpec).toBeUndefined(); // the user's call, on Data health with the spec-only hint
    expect(pc?.updatedAt).toEqual(OLD);

    expect((await byName("Plain Abrasive"))?.optTagsSpec).toBe(true);
    expect((await byName("No Tags"))?.optTagsSpec).toBe(true);

    const amb = await byName("Ambiguous Transparent");
    expect(amb?.optTags).toEqual([2]);
    expect(amb?.optTagsSpec).toBeUndefined();
    const twoHints = await byName("Two Hints");
    expect(twoHints?.optTags).toEqual([18, 30]); // untouched, unmarked
    expect(twoHints?.optTagsSpec).toBeUndefined();

    // Idempotent: the second pass sees only the three unsettled rows and writes nothing.
    const second = await renumberOptTags(db(), new Date("2026-10-09T00:00:00.000Z"));
    expect(second).toMatchObject({ scanned: 3, converted: 0, verified: 0, ambiguous: 3 });
    expect((await byName("Legacy Marble"))?.optTags).toEqual([57, 20]); // NOT [57, 46] — no double remap

    // The run is recorded with the drops.
    const marker = await markers().findOne({ _id: OPT_TAG_RENUMBER_MARKER_ID as never });
    expect(marker?.lastRun).toMatchObject({ scanned: 3 });
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
      // Trivial row (30 and 4 are both remap-invariant) with a legacy snapshot:
      // the snapshot is still translated.
      {
        name: "Vendor Tag Linked", vendor: "V", type: "PC", optTags: [30, 4], updatedAt: OLD,
        settings: { openprinttag_slug: "v-pc" }, openprinttagSnapshot: { optTags: [2] },
      },
    ]);

    const s = await renumberOptTags(db(), NOW);
    expect(s).toMatchObject({ scanned: 5, converted: 2, verified: 1, ambiguous: 2 });

    const imported = await byName("OPT Imported");
    expect(imported?.optTags).toEqual([17, 28]);
    // The legacy snapshot is translated AND stamped so it is never translated twice.
    expect(imported?.openprinttagSnapshot).toEqual({ optTags: [28, 17], density: 1.24, tagsNumbering: "spec" });
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
    expect(linked?.openprinttagSnapshot).toEqual({ optTags: [20], tagsNumbering: "spec" });
    expect(linked?.updatedAt).toEqual(OLD); // a per-peer rewrite, not an edit to propagate
  });

  it("includes trashed rows (they can be restored) and counts a lost conditional write as skipped", async () => {
    await col().insertMany([
      // Pre-v1.36 import (link, no snapshot) → provably legacy.
      { name: "Trashed Legacy", vendor: "V", type: "PLA", optTags: [18], _deletedAt: OLD, settings: { openprinttag_slug: "t" } },
    ]);
    const s = await renumberOptTags(db(), NOW);
    expect(s).toMatchObject({ scanned: 1, converted: 1 });
    expect((await byName("Trashed Legacy"))?.optTags).toEqual([57]);

    // A write whose exact-array condition no longer matches (an edit landed
    // between read and write) is a skip, not a conversion, and leaves the
    // flag's settle condition false so the next connect revisits the row.
    // 9 FLEXIBLE drops on conversion, so a drop record WOULD be written.
    await col().insertOne({ name: "Raced", vendor: "V", type: "PLA", optTags: [18, 2, 9], settings: { openprinttag_slug: "r" } });
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

  it("a snapshot written since v1.83 is not legacy proof, and a translated snapshot is never translated twice (Codex P1 r4)", async () => {
    await col().insertMany([
      // An NFC-created spec [2] LINKED after upgrading: the link route's
      // snapshot equals it and says it is spec-numbered → the user's call.
      {
        name: "Linked After", vendor: "V", type: "PLA", optTags: [2],
        settings: { openprinttag_slug: "l" }, openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" },
      },
      // A legacy snapshot equal to the array (decisive): translated and stamped.
      {
        name: "Legacy Snap", vendor: "V", type: "PLA", optTags: [18, 2],
        settings: { openprinttag_slug: "m" }, openprinttagSnapshot: { optTags: [18, 2] },
      },
    ]);
    const s = await renumberOptTags(db(), NOW);
    expect(s).toMatchObject({ scanned: 2, converted: 1, ambiguous: 1 });
    const after = await byName("Linked After");
    expect(after?.optTags).toEqual([2]); // NOT remapped to 20
    expect(after?.optTagsSpec).toBeUndefined();
    expect((await byName("Legacy Snap"))?.openprinttagSnapshot).toEqual({ optTags: [57, 20], tagsNumbering: "spec" });

    // Keep on Data health runs the snapshot step again — the marker stops a
    // second translation of an already-spec snapshot.
    const r = await resolveOptTagNumbering(db(), after!._id, "keep", [2], NOW);
    expect(r.outcome).toBe("kept");
    expect((await byName("Linked After"))?.openprinttagSnapshot).toEqual({ optTags: [2], tagsNumbering: "spec" });
  });

  it("a conversion write that THROWS pulls back its pre-written drop record; a retry records it exactly once (Codex P2 r4)", async () => {
    await col().insertOne({ name: "Throws", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "th" } }); // 9 FLEXIBLE drops
    const real = mongoose.connection.db!;
    let throwOnce = true;
    type Filter = Record<string, unknown>;
    type Opts = { projection?: Record<string, unknown> };
    const failing: MinimalRenumberDb = {
      collection: (name) => {
        const c = real.collection(name);
        if (name !== "filaments") return c as unknown as ReturnType<MinimalRenumberDb["collection"]>;
        return {
          find: (f: Filter, o?: Opts) => c.find(f, o),
          findOne: (f: Filter, o?: Opts) => c.findOne(f, o),
          updateOne: async (filter: Filter, update: Filter, options?: { upsert?: boolean }) => {
            if (throwOnce) {
              throwOnce = false;
              throw new Error("socket closed");
            }
            return c.updateOne(filter, update, options);
          },
        } as unknown as ReturnType<MinimalRenumberDb["collection"]>;
      },
    };
    await expect(renumberOptTags(failing, NOW)).rejects.toThrow("socket closed");
    expect(await readDroppedLegacyTags(db())).toEqual([]); // pulled back
    const throwsId = (await byName("Throws"))!._id;
    expect((await byName("Throws"))?.optTagsSpec).toBeUndefined();

    // A stale record the cleanup could not remove (database gone) is REPLACED
    // by the retry, not stacked beside a second notice.
    await markers().updateOne(
      { _id: OPT_TAG_RENUMBER_MARKER_ID as never },
      // The driver's typed $push wants the array's element type declared; this is a raw fixture write.
      { $push: { dropped: { filamentId: String(throwsId), name: "Throws", tags: [9], at: OLD } } } as never,
      { upsert: true },
    );
    expect(await renumberOptTags(db(), NOW)).toMatchObject({ converted: 1 });
    expect(await readDroppedLegacyTags(db())).toEqual([expect.objectContaining({ name: "Throws", tags: [9], at: NOW })]);

    // The manual resolution path cleans up the same way.
    await col().insertOne({ name: "Throws Manual", vendor: "V", type: "TPU", optTags: [9, 2] });
    const manualId = (await byName("Throws Manual"))!._id;
    throwOnce = true;
    await expect(resolveOptTagNumbering(failing, manualId, "convert", [9, 2], NOW)).rejects.toThrow("socket closed");
    expect((await readDroppedLegacyTags(db())).map((d) => d.name)).toEqual(["Throws"]);
    expect(await resolveOptTagNumbering(db(), manualId, "convert", [9, 2], NOW)).toMatchObject({
      outcome: "converted",
      dropped: [9],
    });
    expect((await readDroppedLegacyTags(db())).map((d) => d.name)).toEqual(["Throws", "Throws Manual"]);

    // ACK LOST (Codex P2 r5): the write COMMITS but the driver throws before
    // the acknowledgement arrives. The record must SURVIVE — the pass never
    // revisits a marked row, so pulling it would hide the removed tags for good.
    await col().insertOne({ name: "Ack Lost", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "ack" } });
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
    await expect(renumberOptTags(ackLost, NOW)).rejects.toThrow("connection reset before ack");
    const ack = await byName("Ack Lost");
    expect(ack?.optTags).toEqual([57]); // the write landed
    expect(ack?.optTagsSpec).toBe(true);
    expect((await readDroppedLegacyTags(db())).map((d) => d.name)).toEqual(["Throws", "Throws Manual", "Ack Lost"]);
    // Nothing left to convert, and the record stays exactly once.
    expect(await renumberOptTags(db(), NOW)).toMatchObject({ scanned: 0 });
    expect((await readDroppedLegacyTags(db())).filter((d) => d.name === "Ack Lost")).toHaveLength(1);
  });

  it("skips a row whose classifier inputs changed between the read and the write — marker or array alike (Codex P1 r6)", async () => {
    // Read as trivial [4]; replaced with an ambiguous legacy [2] before the
    // write lands (another desktop, the sync service). Pinning only the id and
    // marker would have stamped the [2] as verified spec = antibacterial.
    await col().insertOne({ name: "Swapped", vendor: "V", type: "PLA", optTags: [4] });
    const real = mongoose.connection.db!;
    type Filter = Record<string, unknown>;
    type Opts = { projection?: Record<string, unknown> };
    const swapping: MinimalRenumberDb = {
      collection: (name) => {
        const c = real.collection(name);
        if (name !== "filaments") return c as unknown as ReturnType<MinimalRenumberDb["collection"]>;
        return {
          find: (f: Filter, o?: Opts) => c.find(f, o),
          findOne: (f: Filter, o?: Opts) => c.findOne(f, o),
          updateOne: async (filter: Filter, update: Filter, options?: { upsert?: boolean }) => {
            await c.updateOne({ _id: (filter as { _id: unknown })._id as never }, { $set: { optTags: [2] } });
            return c.updateOne(filter, update, options);
          },
        } as unknown as ReturnType<MinimalRenumberDb["collection"]>;
      },
    };
    expect(await renumberOptTags(swapping, NOW)).toMatchObject({ scanned: 1, verified: 0, skipped: 1 });
    const swapped = await byName("Swapped");
    expect(swapped?.optTags).toEqual([2]);
    expect(swapped?.optTagsSpec).toBeUndefined(); // reclassified next pass: ambiguous → Data health
    expect(await renumberOptTags(db(), NOW)).toMatchObject({ scanned: 1, ambiguous: 1, skipped: 0 });

    // A legacy verdict justified by a snapshot is skipped when the snapshot it
    // rested on is replaced (here: re-linked to a spec-marked one).
    await col().deleteMany({ name: "Swapped" }); // isolate the next sub-scenario's counts
    await col().insertOne({
      name: "Relinked", vendor: "V", type: "PLA", optTags: [2],
      settings: { openprinttag_slug: "a" }, openprinttagSnapshot: { optTags: [2] },
    });
    const relinking: MinimalRenumberDb = {
      collection: (name) => {
        const c = real.collection(name);
        if (name !== "filaments") return c as unknown as ReturnType<MinimalRenumberDb["collection"]>;
        return {
          find: (f: Filter, o?: Opts) => c.find(f, o),
          findOne: (f: Filter, o?: Opts) => c.findOne(f, o),
          updateOne: async (filter: Filter, update: Filter, options?: { upsert?: boolean }) => {
            await c.updateOne(
              { _id: (filter as { _id: unknown })._id as never },
              { $set: { "settings.openprinttag_slug": "b", openprinttagSnapshot: { optTags: [2], tagsNumbering: "spec" } } },
            );
            return c.updateOne(filter, update, options);
          },
        } as unknown as ReturnType<MinimalRenumberDb["collection"]>;
      },
    };
    expect(await renumberOptTags(relinking, NOW)).toMatchObject({ scanned: 1, converted: 0, skipped: 1 });
    const relinked = await byName("Relinked");
    expect(relinked?.optTags).toEqual([2]); // not remapped
    expect(relinked?.optTagsSpec).toBeUndefined();
    expect(await renumberOptTags(db(), NOW)).toMatchObject({ scanned: 1, ambiguous: 1 }); // spec snapshot: no proof

    // The snapshot CONTAINER is pinned too (Codex P1 r10): a linked row with
    // NO snapshot object is a legacy proof (pre-v1.36 import), while a
    // snapshot object WITHOUT an `optTags` entry proves nothing — and both
    // satisfy the children's `$exists: false` pins. A whole-document copy
    // landing between the read and the write with a tag-less pre-upgrade
    // snapshot must not let the stale verdict convert a now-ambiguous array.
    await col().deleteMany({ name: "Relinked" });
    await col().insertOne({
      name: "Snapshot Gained", vendor: "V", type: "PLA", optTags: [2], settings: { openprinttag_slug: "g" },
    });
    const gaining: MinimalRenumberDb = {
      collection: (name) => {
        const c = real.collection(name);
        if (name !== "filaments") return c as unknown as ReturnType<MinimalRenumberDb["collection"]>;
        return {
          find: (f: Filter, o?: Opts) => c.find(f, o),
          findOne: (f: Filter, o?: Opts) => c.findOne(f, o),
          updateOne: async (filter: Filter, update: Filter, options?: { upsert?: boolean }) => {
            await c.updateOne(
              { _id: (filter as { _id: unknown })._id as never },
              { $set: { openprinttagSnapshot: { density: 1.24 } } }, // pre-v1.83 shape, no optTags
            );
            return c.updateOne(filter, update, options);
          },
        } as unknown as ReturnType<MinimalRenumberDb["collection"]>;
      },
    };
    expect(await renumberOptTags(gaining, NOW)).toMatchObject({ scanned: 1, converted: 0, skipped: 1 });
    expect(await byName("Snapshot Gained")).toMatchObject({ optTags: [2], openprinttagSnapshot: { density: 1.24 } });
    expect((await byName("Snapshot Gained"))?.optTagsSpec).toBeUndefined();
    expect(await renumberOptTags(db(), NOW)).toMatchObject({ scanned: 1, ambiguous: 1 }); // the user's call now
  });

  it("a drop recorded on the remote peer is merged, re-pointed at the local copy through syncId, and dismissable by what the page showed (Codex P2 r7)", async () => {
    // The remote pass converted a remote-only row; its record carries the
    // REMOTE _id, which resolves to nothing here, plus the row's syncId.
    const remoteEntry = { filamentId: "64b000000000000000000001", syncId: "sync-remote-1", name: "Remote Only", tags: [9], at: NOW };
    await mergeDroppedLegacyTags(db(), [remoteEntry]);
    expect(await readDroppedLegacyTags(db())).toEqual([expect.objectContaining({ filamentId: remoteEntry.filamentId, syncId: "sync-remote-1" })]);
    // Re-merging on the next cycle replaces, never stacks.
    await mergeDroppedLegacyTags(db(), [{ ...remoteEntry, at: new Date("2026-10-08T13:00:00.000Z") }]);
    expect(await readDroppedLegacyTags(db())).toHaveLength(1);

    // The row is pulled with a fresh local _id; the record follows it, persistently.
    const { insertedId } = await col().insertOne({ name: "Remote Only", vendor: "V", type: "PLA", optTags: [20], optTagsSpec: true, syncId: "sync-remote-1" });
    expect((await readDroppedLegacyTags(db()))[0].filamentId).toBe(String(insertedId));
    const stored = await markers().findOne({ _id: OPT_TAG_RENUMBER_MARKER_ID as never });
    expect(stored?.dropped[0].filamentId).toBe(String(insertedId));

    // Dismiss only what the page displayed: a record appended meanwhile survives.
    await col().insertOne({ name: "Later", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "later" } });
    const shown = (await readDroppedLegacyTags(db())).map((d) => d.filamentId);
    expect(shown).toEqual([String(insertedId)]);
    await renumberOptTags(db(), NOW); // appends "Later"'s drop after the page loaded
    await dismissDroppedLegacyTags(db(), shown);
    expect((await readDroppedLegacyTags(db())).map((d) => d.name)).toEqual(["Later"]);
    // No list → everything (API callers that read the whole list themselves).
    await dismissDroppedLegacyTags(db());
    expect(await readDroppedLegacyTags(db())).toEqual([]);
  });

  it("a local and a remote notice for the same row coexist until the LWW step decides, then the loser's goes (Codex P2 r9)", async () => {
    const LATER = new Date("2026-10-08T13:00:00.000Z");
    // The local pass converts the LOCAL revision of a row both peers hold
    // (pre-v1.36 import: link, no snapshot) — 9 FLEXIBLE drops.
    const { insertedId } = await col().insertOne({
      name: "Both Sides", vendor: "V", type: "PLA", optTags: [9, 2], syncId: "sync-both",
      settings: { openprinttag_slug: "both" }, updatedAt: OLD,
    });
    expect(await renumberOptTags(db(), NOW)).toMatchObject({ converted: 1 });
    // The remote pass converted a DIVERGENT remote revision, dropping 8 (HEAT_RESISTANT).
    const remoteEntry = { filamentId: "64b000000000000000000002", syncId: "sync-both", name: "Both Sides", tags: [8], at: LATER };
    await mergeDroppedLegacyTags(db(), [remoteEntry]);
    // Neither replaced the other; both are re-pointed at the local copy.
    let notices = await readDroppedLegacyTags(db());
    expect(notices.map((d) => d.tags)).toEqual([[9], [8]]);
    expect(notices.map((d) => d.filamentId)).toEqual([String(insertedId), String(insertedId)]);
    expect(notices.map((d) => d.peer)).toEqual([undefined, "remote"]);
    // Re-merging the same remote record after the re-point still replaces, never stacks.
    await mergeDroppedLegacyTags(db(), [remoteEntry]);
    expect(await readDroppedLegacyTags(db())).toHaveLength(2);

    // The local revision stood (it won LWW, or the timestamps tied): the
    // remote notice described the revision LWW discarded.
    expect(await reconcileMergedDroppedLegacyTags(db(), [remoteEntry], () => false)).toEqual({ remoteWon: 0, localWon: 1 });
    notices = await readDroppedLegacyTags(db());
    expect(notices.map((d) => d.tags)).toEqual([[9]]);

    // The cycle REWROTE the local row with the remote revision: the local
    // notice described a document that no longer exists anywhere.
    await mergeDroppedLegacyTags(db(), [remoteEntry]);
    expect(await reconcileMergedDroppedLegacyTags(db(), [remoteEntry], () => true)).toEqual({ remoteWon: 1, localWon: 0 });
    notices = await readDroppedLegacyTags(db());
    expect(notices.map((d) => d.tags)).toEqual([[8]]);

    // A remote record for a row this database has not pulled yet is left alone.
    const unpulled = { filamentId: "64b000000000000000000003", syncId: "sync-elsewhere", name: "Elsewhere", tags: [9], at: LATER };
    await mergeDroppedLegacyTags(db(), [unpulled]);
    expect(await reconcileMergedDroppedLegacyTags(db(), [unpulled], () => false)).toEqual({ remoteWon: 0, localWon: 0 });
    expect((await readDroppedLegacyTags(db())).map((d) => d.name)).toEqual(["Both Sides", "Elsewhere"]);
  });

  it("two passes converting the same row concurrently leave exactly ONE drop record — the replacement is atomic (Codex P2 r10)", async () => {
    await col().insertOne({ name: "Twice", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "tw" } });
    // Both read the row unmarked; each records (an atomic replace, so the
    // second supersedes the first instead of stacking beside it); one
    // conversion lands, the other's conditional write matches nothing and
    // reconciles as "landed" — keeping the single record that remains.
    const [a, b] = await Promise.all([
      renumberOptTags(db(), NOW),
      renumberOptTags(db(), new Date("2026-10-08T12:00:00.001Z")),
    ]);
    expect(a.converted + b.converted).toBe(1);
    expect(await byName("Twice")).toMatchObject({ optTags: [57], optTagsSpec: true });
    const notices = await readDroppedLegacyTags(db());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ name: "Twice", tags: [9] });
  });

  it("an unmatched write that lost to a COMPETING identical conversion keeps the one remaining drop record (Codex P2 r8)", async () => {
    // A records, B records (replacing A's), A converts, B's conditional write
    // matches nothing. Pulling B's record here would leave the converted row
    // with no notice at all.
    await col().insertOne({ name: "Competing", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "c" } });
    const real = mongoose.connection.db!;
    type Filter = Record<string, unknown>;
    type Opts = { projection?: Record<string, unknown> };
    const competing: MinimalRenumberDb = {
      collection: (name) => {
        const c = real.collection(name);
        if (name !== "filaments") return c as unknown as ReturnType<MinimalRenumberDb["collection"]>;
        return {
          find: (f: Filter, o?: Opts) => c.find(f, o),
          findOne: (f: Filter, o?: Opts) => c.findOne(f, o),
          updateOne: async (filter: Filter, update: Filter, options?: { upsert?: boolean }) => {
            // Competitor A lands the identical conversion first …
            await c.updateOne({ _id: (filter as { _id: unknown })._id as never }, update as never);
            // … so B's conditional write (unmarked rows only) matches nothing.
            return c.updateOne(filter, update, options);
          },
        } as unknown as ReturnType<MinimalRenumberDb["collection"]>;
      },
    };
    expect(await renumberOptTags(competing, NOW)).toMatchObject({ scanned: 1, converted: 0, skipped: 1 });
    expect(await byName("Competing")).toMatchObject({ optTags: [57], optTagsSpec: true });
    expect(await readDroppedLegacyTags(db())).toEqual([expect.objectContaining({ name: "Competing", tags: [9] })]);
  });

  it("describeRenumberSummary is quiet when nothing was scanned", async () => {
    expect(describeRenumberSummary(await renumberOptTags(db(), NOW))).toBeNull();
    await col().insertOne({ name: "L", vendor: "V", type: "PLA", optTags: [18, 9], settings: { openprinttag_slug: "l" } });
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
      stored: [9, 4],
      asLegacy: { tags: [4], dropped: [9] },
      asSpec: [9, 4],
    });
    expect(pending[1].specOnlyIds).toEqual([]);
    expect(pending[1].legacyOnlyIds).toEqual([]);
    expect(pending[0]).toMatchObject({
      trashed: true,
      verdict: "ambiguous",
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

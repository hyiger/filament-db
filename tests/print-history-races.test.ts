import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createFilament } from "@/app/api/filaments/route";
import { POST as postPrintHistory } from "@/app/api/print-history/route";
import { DELETE as deletePrintHistory } from "@/app/api/print-history/[id]/route";
import { lockedKeyCount } from "@/lib/filamentMutex";

/**
 * GH #605 round 12 — print-history spool writes vs promotion.
 *
 * The print-history POST (debit) and DELETE (refund) mutate spool
 * subdocuments OUTSIDE the /filaments/{id}/spools/* directory round 11
 * locked, so their saves could still interleave with an in-flight
 * promotion's snapshot → copy → clear sequence:
 *
 *   - a debit committing between the snapshot and the clear was SILENTLY
 *     ERASED (the promoted copy was minted from the pre-debit snapshot;
 *     the parent's spools were cleared after the 201 was acknowledged —
 *     the debit + usageHistory entry then existed on NEITHER document);
 *   - a refund was erased the same way, or SKIPPED entirely when the
 *     promotion had already moved the row's spool onto the promoted
 *     variant (remapExternalSpoolRefs rewrites the row's filamentId in
 *     the DB, but the handler's already-loaded entry still named the
 *     parent) — a 200 "Deleted and refunded" with no refund anywhere.
 *
 * Serialized (POST: the single-filament persist holds the family key
 * across the whole persist; multi-filament jobs save sequentially, one
 * key at a time. DELETE: each row's load-mutate-save holds the current
 * owner's key and chases at most one remap hop), every race resolves to
 * a lawful end state — the same harness as
 * tests/spool-subroute-races.test.ts, each race in BOTH submission
 * orders. Family grams are conserved in every branch: a 2xx implies the
 * debit/refund exists on exactly one live document; a non-2xx implies
 * nothing changed and (for POST) no PrintHistory row exists.
 */
describe("GH #605 round 12 — print-history debit/refund vs promotion", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PrintHistory: any;

  beforeEach(async () => {
    const mods = [
      ["Filament", await import("@/models/Filament")],
      ["Nozzle", await import("@/models/Nozzle")],
      ["Printer", await import("@/models/Printer")],
      ["BedType", await import("@/models/BedType")],
      ["Location", await import("@/models/Location")],
      ["PrintHistory", await import("@/models/PrintHistory")],
    ] as const;
    for (const [name, mod] of mods) {
      if (!mongoose.models[name]) mongoose.model(name, mod.default.schema);
    }
    Filament = mongoose.models.Filament;
    PrintHistory = mongoose.models.PrintHistory;
  });

  function jsonReq(url: string, body: unknown, method: string) {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function seedCarryingParent(name: string) {
    return Filament.create({
      name,
      vendor: "V",
      type: "PLA",
      color: "#336699",
      spools: [
        { label: "roll 1", totalWeight: 1000 },
        { label: "roll 2", totalWeight: 750 },
      ],
    });
  }

  function variantPost(base: string, id: string) {
    return createFilament(
      jsonReq(
        "http://localhost/api/filaments",
        {
          name: `${base} — Red`,
          vendor: "V",
          type: "PLA",
          color: "#FF0000",
          parentId: id,
          promoteParent: true,
        },
        "POST",
      ),
    );
  }

  function jobPost(jobLabel: string, usage: Array<Record<string, unknown>>) {
    return postPrintHistory(
      jsonReq("http://localhost/api/print-history", { jobLabel, usage }, "POST"),
    );
  }

  /** Race `mutate` against the confirmed first-variant POST that promotes
   *  the carrying parent, in the given submission order. Returns both
   *  responses plus the promoted copy (parent-cleanliness asserted). */
  async function raceAgainstPromotion(
    base: string,
    id: string,
    mutationFirst: boolean,
    mutate: () => Promise<Response>,
  ) {
    // Sequentially started, concurrently awaited — the mutex serializes
    // whichever reaches the critical section first; assertions are
    // end-state invariants that hold for both interleavings.
    const [mutRes, variantRes] = mutationFirst
      ? await (() => {
          const m = mutate();
          const v = variantPost(base, id);
          return Promise.all([m, v]);
        })()
      : await (async () => {
          const v = variantPost(base, id);
          const m = mutate();
          const [rv, rm] = await Promise.all([v, m]);
          return [rm, rv] as const;
        })();

    expect(variantRes.status).toBe(201);

    // The parent always ends a clean template.
    const freshParent = await Filament.findById(id).lean();
    expect(freshParent.color).toBeNull();
    expect(freshParent.spools).toEqual([]);

    const promoted = await Filament.findOne({
      name: `${base} — Original`,
      _deletedAt: null,
    }).lean();
    expect(promoted).toBeTruthy();

    return { mutRes, promoted };
  }

  // ── POST debit vs promotion ───────────────────────────────────────────────

  for (const postFirst of [true, false]) {
    it(`print-history POST vs promoting first-variant POST (${postFirst ? "job" : "variant"} submitted first): the debit rides the promotion or the POST fails cleanly — never silently erased`, async () => {
      const base = `PH Debit Race ${postFirst ? "A" : "B"}`;
      const jobLabel = `raced debit ${postFirst ? "A" : "B"}`;
      const parent = await seedCarryingParent(base);
      const id = String(parent._id);
      const spoolId = String(parent.spools[0]._id);

      const { mutRes, promoted } = await raceAgainstPromotion(base, id, postFirst, () =>
        jobPost(jobLabel, [{ filamentId: id, spoolId, grams: 120 }]),
      );

      // Either the debit landed before the promotion's snapshot (201 — and
      // the promoted copy carries BOTH halves, weight + ledger entry), or
      // the promotion won and the POST failed cleanly: 400 when pass 1
      // already saw the cleared template ("Spool not found"), 409 when the
      // in-lock save hit the promotion's __v bump (OCC). Never a 201 whose
      // debit exists nowhere; never a PrintHistory row without its debit.
      expect([201, 400, 409]).toContain(mutRes.status);

      const copySpool = promoted.spools.find(
        (s: { _id: unknown }) => String(s._id) === spoolId,
      );
      expect(copySpool).toBeTruthy();
      const entries = copySpool.usageHistory ?? [];
      const rows = await PrintHistory.find({ jobLabel }).lean();

      if (mutRes.status === 201) {
        expect(copySpool.totalWeight).toBe(880);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ grams: 120, source: "job" });
        expect(rows).toHaveLength(1);
        expect(String(entries[0].jobId)).toBe(String(rows[0]._id));
      } else {
        // Failed cleanly: no debit anywhere, no job row (tombstoned or not).
        expect(copySpool.totalWeight).toBe(1000);
        expect(entries).toHaveLength(0);
        expect(rows).toHaveLength(0);
      }
      // Untouched sibling spool moved verbatim either way.
      expect(
        promoted.spools.find((s: { label: string }) => s.label === "roll 2")
          .totalWeight,
      ).toBe(750);

      expect(lockedKeyCount()).toBe(0);
    });
  }

  // ── DELETE refund vs promotion ────────────────────────────────────────────

  for (const deleteFirst of [true, false]) {
    it(`print-history DELETE vs promoting first-variant POST (${deleteFirst ? "DELETE" : "variant"} submitted first): the refund follows the moved spool — never erased, never skipped`, async () => {
      const base = `PH Refund Race ${deleteFirst ? "A" : "B"}`;
      const jobLabel = `raced refund ${deleteFirst ? "A" : "B"}`;
      const parent = await seedCarryingParent(base);
      const id = String(parent._id);
      const spoolId = String(parent.spools[0]._id);

      // Record the job first (no race yet): debits roll 1 to 880.
      const jobRes = await jobPost(jobLabel, [
        { filamentId: id, spoolId, grams: 120 },
      ]);
      expect(jobRes.status).toBe(201);
      const historyId = String((await jobRes.json())._id);

      const { mutRes, promoted } = await raceAgainstPromotion(
        base,
        id,
        deleteFirst,
        () =>
          deletePrintHistory(
            new NextRequest(`http://localhost/api/print-history/${historyId}`, {
              method: "DELETE",
            }),
            { params: Promise.resolve({ id: historyId }) },
          ),
      );

      // BOTH orderings converge on the same end state: the refund lands on
      // whichever live document carries the spool. DELETE-first refunds the
      // parent and the promotion copies the refunded spool; promotion-first
      // remaps the job row onto the promoted variant and the DELETE chases
      // the remap under the variant's key. Deterministic 200 — the lock
      // means the refund save can never hit the promotion's __v bump.
      expect(mutRes.status).toBe(200);

      const copySpool = promoted.spools.find(
        (s: { _id: unknown }) => String(s._id) === spoolId,
      );
      expect(copySpool).toBeTruthy();
      expect(copySpool.totalWeight).toBe(1000);
      expect(copySpool.usageHistory ?? []).toHaveLength(0);

      // The job is tombstoned, and no live document anywhere still carries
      // its ledger entry (the erased-refund failure mode left one on the
      // promoted copy).
      const tombstoned = await PrintHistory.findById(historyId).lean();
      expect(tombstoned._deletedAt).not.toBeNull();
      const carriers = await Filament.find({
        "spools.usageHistory.jobId": historyId,
      }).lean();
      expect(carriers).toHaveLength(0);

      expect(lockedKeyCount()).toBe(0);
    });
  }

  // ── multi-material POST vs promotion of one of its filaments ─────────────

  for (const postFirst of [true, false]) {
    it(`multi-material POST vs promotion of one filament (${postFirst ? "job" : "variant"} submitted first): all-or-nothing — the unrelated filament's debit lands iff the job does`, async () => {
      const base = `PH Multi Race ${postFirst ? "A" : "B"}`;
      const jobLabel = `raced multi ${postFirst ? "A" : "B"}`;
      const parent = await seedCarryingParent(base);
      const id = String(parent._id);
      const spoolId = String(parent.spools[0]._id);
      const other = await Filament.create({
        name: `${base} — Bystander`,
        vendor: "V",
        type: "PETG",
        color: "#00FF00",
        spools: [{ label: "b1", totalWeight: 500 }],
      });
      const otherId = String(other._id);
      const otherSpoolId = String(other.spools[0]._id);

      const { mutRes, promoted } = await raceAgainstPromotion(base, id, postFirst, () =>
        jobPost(jobLabel, [
          { filamentId: id, spoolId, grams: 100 },
          { filamentId: otherId, spoolId: otherSpoolId, grams: 50 },
        ]),
      );

      // 201: both debits landed (the promoting filament's rode the
      // promotion onto the copy). 400/409: the job failed cleanly and the
      // rollback restored the bystander — never a half-landed job, never a
      // bystander debit without its PrintHistory row, never a 201 with an
      // erased debit.
      expect([201, 400, 409]).toContain(mutRes.status);

      const copySpool = promoted.spools.find(
        (s: { _id: unknown }) => String(s._id) === spoolId,
      );
      expect(copySpool).toBeTruthy();
      const bystander = await Filament.findById(otherId).lean();
      const bystanderSpool = bystander.spools[0];
      const rows = await PrintHistory.find({ jobLabel }).lean();

      if (mutRes.status === 201) {
        expect(rows).toHaveLength(1);
        expect(rows[0].usage).toHaveLength(2);
        expect(copySpool.totalWeight).toBe(900);
        expect(copySpool.usageHistory ?? []).toHaveLength(1);
        expect(bystanderSpool.totalWeight).toBe(450);
        expect(bystanderSpool.usageHistory ?? []).toHaveLength(1);
        expect(String(bystanderSpool.usageHistory[0].jobId)).toBe(
          String(rows[0]._id),
        );
      } else {
        expect(rows).toHaveLength(0);
        expect(copySpool.totalWeight).toBe(1000);
        expect(copySpool.usageHistory ?? []).toHaveLength(0);
        expect(bystanderSpool.totalWeight).toBe(500);
        expect(bystanderSpool.usageHistory ?? []).toHaveLength(0);
      }

      expect(lockedKeyCount()).toBe(0);
    });
  }
});

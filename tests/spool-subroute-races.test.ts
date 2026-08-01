import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createFilament } from "@/app/api/filaments/route";
import {
  PUT as putSpool,
  DELETE as deleteSpool,
} from "@/app/api/filaments/[id]/spools/[spoolId]/route";
import { POST as postDryCycle } from "@/app/api/filaments/[id]/spools/[spoolId]/dry-cycles/route";
import { POST as postUsage } from "@/app/api/filaments/[id]/spools/[spoolId]/usage/route";
import { lockedKeyCount } from "@/lib/filamentMutex";

/**
 * GH #605 round 11 (F1) — the EXISTING-spool mutations (PUT / DELETE /
 * dry-cycle POST / usage POST on /spools/{spoolId}) now run under the same
 * per-filament mutex the promotion paths hold. Before the lock, their
 * positional writes could interleave with an in-flight promotion's
 * snapshot → copy → clear sequence:
 *
 *   - an edit or a dry-cycle/usage append landing between the snapshot and
 *     the clear was SILENTLY LOST (the promoted copy was minted from the
 *     pre-write snapshot; the parent's spools were cleared right after a
 *     2xx was already acknowledged);
 *   - a delete whose exists-precheck passed pre-snapshot could 200 while
 *     the promotion copied the spool onto the variant — a RESURRECTED
 *     spool the client believed deleted.
 *
 * Serialized, every race resolves to one of exactly two orderings, both
 * lawful (the same harness as tests/template-model-races.test.ts): the
 * mutation runs first and the promotion's fresh snapshot carries its
 * effect onto the promoted variant, or the promotion runs first and the
 * mutation 404s (post-promotion staleness — the round-4 contract). Never
 * a 2xx whose effect exists nowhere; never a 200-deleted spool that still
 * exists somewhere. Each race runs in BOTH submission orders.
 */
describe("GH #605 round 11 — existing-spool mutations vs promotion", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

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

  /** Run `mutate` against a fresh carrying parent, racing the confirmed
   *  first-variant POST that promotes it, in the given submission order.
   *  Returns both responses plus the promoted copy + fresh parent docs. */
  async function raceAgainstPromotion(
    base: string,
    mutationFirst: boolean,
    mutate: (id: string, spoolId: string) => Promise<Response>,
  ) {
    const parent = await seedCarryingParent(base);
    const id = String(parent._id);
    const spoolId = String(parent.spools[0]._id);

    // Sequentially started, concurrently awaited — the mutex serializes
    // whichever reaches the critical section first; assertions are
    // end-state invariants that hold for both interleavings.
    const [mutRes, variantRes] = mutationFirst
      ? await (() => {
          const m = mutate(id, spoolId);
          const v = variantPost(base, id);
          return Promise.all([m, v]);
        })()
      : await (async () => {
          const v = variantPost(base, id);
          const m = mutate(id, spoolId);
          const [rv, rm] = await Promise.all([v, m]);
          return [rm, rv] as const;
        })();

    expect(variantRes.status).toBe(201);

    // The parent always ends a clean template.
    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBeNull();
    expect(freshParent.spools).toEqual([]);

    const promoted = await Filament.findOne({
      name: `${base} — Original`,
      _deletedAt: null,
    }).lean();
    expect(promoted).toBeTruthy();

    return { mutRes, parent, id, spoolId, promoted };
  }

  // ── spool PUT vs promotion ────────────────────────────────────────────────

  for (const putFirst of [true, false]) {
    it(`spool PUT vs promoting first-variant POST (${putFirst ? "PUT" : "variant"} submitted first): edit rides the promotion or 404s — never silently dropped`, async () => {
      const { mutRes, spoolId, promoted } = await raceAgainstPromotion(
        `Spool Edit Race ${putFirst ? "A" : "B"}`,
        putFirst,
        (id, sid) =>
          putSpool(
            jsonReq(
              `http://localhost/api/filaments/${id}/spools/${sid}`,
              { label: "edited roll", totalWeight: 500 },
              "PUT",
            ),
            { params: Promise.resolve({ id, spoolId: sid }) },
          ),
      );

      // Either the edit landed before the promotion's snapshot (200 — and
      // the promoted copy carries it) or the spools had already moved (404,
      // the round-4 staleness contract). Never a 200 whose edit vanished.
      expect([200, 404]).toContain(mutRes.status);
      const copySpool = promoted.spools.find(
        (s: { _id: unknown }) => String(s._id) === spoolId,
      );
      expect(copySpool).toBeTruthy();
      if (mutRes.status === 200) {
        expect(copySpool.label).toBe("edited roll");
        expect(copySpool.totalWeight).toBe(500);
      } else {
        expect(copySpool.label).toBe("roll 1");
        expect(copySpool.totalWeight).toBe(1000);
      }

      expect(lockedKeyCount()).toBe(0);
    });
  }

  // ── spool DELETE vs promotion ─────────────────────────────────────────────

  for (const deleteFirst of [true, false]) {
    it(`spool DELETE vs promoting first-variant POST (${deleteFirst ? "DELETE" : "variant"} submitted first): 200 means the spool exists nowhere — never resurrected`, async () => {
      const { mutRes, spoolId, promoted } = await raceAgainstPromotion(
        `Spool Delete Race ${deleteFirst ? "A" : "B"}`,
        deleteFirst,
        (id, sid) =>
          deleteSpool(
            new NextRequest(`http://localhost/api/filaments/${id}/spools/${sid}`, {
              method: "DELETE",
            }),
            { params: Promise.resolve({ id, spoolId: sid }) },
          ),
      );

      expect([200, 404]).toContain(mutRes.status);
      // The definitive resurrection probe: after a 200, no live document
      // anywhere carries the spool subdoc id; after a 404 it lives exactly
      // once, on the promoted copy.
      const carriers = await Filament.find({ "spools._id": spoolId }).lean();
      if (mutRes.status === 200) {
        expect(carriers).toHaveLength(0);
        expect(promoted.spools).toHaveLength(1);
        expect(promoted.spools[0].label).toBe("roll 2");
      } else {
        expect(carriers).toHaveLength(1);
        expect(String(carriers[0]._id)).toBe(String(promoted._id));
        expect(promoted.spools).toHaveLength(2);
      }

      expect(lockedKeyCount()).toBe(0);
    });
  }

  // ── dry-cycle POST vs promotion ───────────────────────────────────────────

  for (const postFirst of [true, false]) {
    it(`dry-cycle POST vs promoting first-variant POST (${postFirst ? "dry-cycle" : "variant"} submitted first): the cycle rides the promotion or 404s`, async () => {
      const { mutRes, spoolId, promoted } = await raceAgainstPromotion(
        `Dry Cycle Race ${postFirst ? "A" : "B"}`,
        postFirst,
        (id, sid) =>
          postDryCycle(
            jsonReq(
              `http://localhost/api/filaments/${id}/spools/${sid}/dry-cycles`,
              { tempC: 55, durationMin: 240, notes: "raced cycle" },
              "POST",
            ),
            { params: Promise.resolve({ id, spoolId: sid }) },
          ),
      );

      expect([201, 404]).toContain(mutRes.status);
      const copySpool = promoted.spools.find(
        (s: { _id: unknown }) => String(s._id) === spoolId,
      );
      expect(copySpool).toBeTruthy();
      const cycles = copySpool.dryCycles ?? [];
      if (mutRes.status === 201) {
        // Acknowledged → the ledger entry moved with the spool.
        expect(cycles).toHaveLength(1);
        expect(cycles[0].notes).toBe("raced cycle");
        expect(cycles[0].tempC).toBe(55);
      } else {
        expect(cycles).toHaveLength(0);
      }

      expect(lockedKeyCount()).toBe(0);
    });
  }

  // ── usage POST vs promotion ───────────────────────────────────────────────

  for (const postFirst of [true, false]) {
    it(`usage POST vs promoting first-variant POST (${postFirst ? "usage" : "variant"} submitted first): the debit+entry ride the promotion or 404`, async () => {
      const { mutRes, spoolId, promoted } = await raceAgainstPromotion(
        `Usage Race ${postFirst ? "A" : "B"}`,
        postFirst,
        (id, sid) =>
          postUsage(
            jsonReq(
              `http://localhost/api/filaments/${id}/spools/${sid}/usage`,
              { grams: 120, jobLabel: "raced benchy" },
              "POST",
            ),
            { params: Promise.resolve({ id, spoolId: sid }) },
          ),
      );

      expect([201, 404]).toContain(mutRes.status);
      const copySpool = promoted.spools.find(
        (s: { _id: unknown }) => String(s._id) === spoolId,
      );
      expect(copySpool).toBeTruthy();
      const entries = copySpool.usageHistory ?? [];
      if (mutRes.status === 201) {
        // Acknowledged → both halves (debit + ledger entry) moved with the
        // spool; a lock-less interleave could lose them BOTH after a 201.
        expect(copySpool.totalWeight).toBe(880);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          grams: 120,
          jobLabel: "raced benchy",
          source: "manual",
        });
      } else {
        expect(copySpool.totalWeight).toBe(1000);
        expect(entries).toHaveLength(0);
      }

      expect(lockedKeyCount()).toBe(0);
    });
  }
});

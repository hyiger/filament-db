import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createFilament } from "@/app/api/filaments/route";
import { POST as createSpool } from "@/app/api/filaments/[id]/spools/route";
import { PUT as putFilament, DELETE as deleteFilament } from "@/app/api/filaments/[id]/route";
import { POST as promotePOST } from "@/app/api/filaments/[id]/promote/route";
import { lockedKeyCount, runExclusive, filamentLockKey } from "@/lib/filamentMutex";

/**
 * GH #605 review round 2 — the check-then-act races, made DETERMINISTIC by
 * the per-filament mutex (src/lib/filamentMutex.ts). Every template-model
 * critical section (spool push, promotion gate + create, /promote,
 * totalWeight strip + write) now serializes on the family's parent id, so
 * concurrent requests resolve to one of exactly two orderings — and BOTH
 * orderings must land in a lawful end state:
 *
 *   P1-a  spool POST vs first-variant promotion: no spool is ever lost —
 *         it either 400s (template_no_spools) or rides the promotion onto
 *         the promoted variant; the parent always ends clean.
 *   P1-b  two /promote calls: exactly one promotion copy is minted; the
 *         loser gets the existing 400 nothing_to_convert.
 *   P1-c  totalWeight PUT vs promotion: the parent never re-materializes
 *         inventory — the value either moves onto the promoted variant
 *         (PUT first) or is stripped (promotion first).
 *
 * Each race runs in BOTH submission orders (sequentially started,
 * concurrently awaited — the mutex awards the key in queue order within
 * the process). Assertions are end-state invariants, so they hold for
 * whichever side entered the critical section first.
 */
describe("GH #605 — template-model race serialization", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mods = [
      ["Filament", await import("@/models/Filament")],
      ["Nozzle", await import("@/models/Nozzle")],
      ["Printer", await import("@/models/Printer")],
      ["BedType", await import("@/models/BedType")],
      ["Location", await import("@/models/Location")],
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

  function spoolPost(id: string, body: Record<string, unknown>) {
    return createSpool(
      jsonReq(`http://localhost/api/filaments/${id}/spools`, body, "POST"),
      { params: Promise.resolve({ id }) },
    );
  }

  function variantPost(body: Record<string, unknown>) {
    return createFilament(jsonReq("http://localhost/api/filaments", body, "POST"));
  }

  function putReq(id: string, body: Record<string, unknown>) {
    return putFilament(jsonReq(`http://localhost/api/filaments/${id}`, body, "PUT"), {
      params: Promise.resolve({ id }),
    });
  }

  function promoteReq(id: string) {
    return promotePOST(
      new NextRequest(`http://localhost/api/filaments/${id}/promote`, { method: "POST" }),
      { params: Promise.resolve({ id }) },
    );
  }

  async function seedCarryingParent(name: string, extra: Record<string, unknown> = {}) {
    return Filament.create({
      name,
      vendor: "V",
      type: "PLA",
      color: "#336699",
      spools: [
        { label: "roll 1", totalWeight: 1000 },
        { label: "roll 2", totalWeight: 750 },
      ],
      ...extra,
    });
  }

  // ── P1-a: spool POST vs first-variant promotion ──────────────────────────

  for (const spoolFirst of [true, false]) {
    it(`spool POST vs promoting first-variant POST (${spoolFirst ? "spool" : "variant"} submitted first): no spool lost, parent ends clean`, async () => {
      const parent = await seedCarryingParent("Race PLA");
      const id = String(parent._id);

      const spoolBody = { label: "raced roll", totalWeight: 500 };
      const variantBody = {
        name: "Race PLA — Red",
        vendor: "V",
        type: "PLA",
        color: "#FF0000",
        parentId: id,
        promoteParent: true,
      };

      // Sequentially started, concurrently awaited — the mutex serializes
      // whichever reaches the critical section first; the invariants below
      // hold for both interleavings.
      const [spoolRes, variantRes] = spoolFirst
        ? await (() => {
            const s = spoolPost(id, spoolBody);
            const v = variantPost(variantBody);
            return Promise.all([s, v]);
          })()
        : await (async () => {
            const v = variantPost(variantBody);
            const s = spoolPost(id, spoolBody);
            const [rv, rs] = await Promise.all([v, s]);
            return [rs, rv] as const;
          })();

      // The confirmed variant create always succeeds.
      expect(variantRes.status).toBe(201);

      // The spool either landed (before the promotion's fresh snapshot) or
      // was refused as a template write — never silently dropped, never
      // stranded on the template.
      expect([201, 400]).toContain(spoolRes.status);
      if (spoolRes.status === 400) {
        expect((await spoolRes.json()).error).toBe("template_no_spools");
      }

      // Parent ends clean either way: promoted to a colorless,
      // inventory-free template.
      const freshParent = await Filament.findById(parent._id).lean();
      expect(freshParent.color).toBeNull();
      expect(freshParent.spools).toEqual([]);

      // No spool lost: the family carries the 2 seeded rolls, plus the
      // raced roll exactly when its POST reported 201 — and if it landed,
      // it lives on the PROMOTED variant (the fresh in-lock snapshot copied
      // it across).
      const promoted = await Filament.findOne({ name: "Race PLA — Original" }).lean();
      expect(promoted).toBeTruthy();
      const variants = await Filament.find({ parentId: parent._id, _deletedAt: null }).lean();
      expect(variants).toHaveLength(2);
      const familySpools = variants.flatMap((v: { spools: Array<{ label: string }> }) => v.spools);
      const expectedCount = 2 + (spoolRes.status === 201 ? 1 : 0);
      expect(familySpools).toHaveLength(expectedCount);
      const racedOnPromoted = promoted.spools.some(
        (s: { label: string }) => s.label === "raced roll",
      );
      expect(racedOnPromoted).toBe(spoolRes.status === 201);

      // The mutex fully drains — no leaked per-key chains.
      expect(lockedKeyCount()).toBe(0);
    });
  }

  // ── P1-b: two concurrent /promote on the same carrying parent ────────────

  it("two concurrent /promote calls: exactly one promotion copy, one 200 + one 400 nothing_to_convert", async () => {
    const parent = await seedCarryingParent("Double Promote PLA");
    // /promote requires an existing live variant (a legacy parent).
    await Filament.create({
      name: "Double Promote PLA — Blue",
      vendor: "V",
      type: "PLA",
      color: "#0000FF",
      parentId: parent._id,
    });
    const id = String(parent._id);

    const first = promoteReq(id);
    const second = promoteReq(id);
    const [res1, res2] = await Promise.all([first, second]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 400]);
    const loser = res1.status === 400 ? res1 : res2;
    expect((await loser.json()).error).toBe("nothing_to_convert");

    // Exactly ONE promotion copy — no "(2)" duplicate carrying a second
    // copy of the spools.
    const copies = await Filament.find({
      name: { $regex: /^Double Promote PLA — Original/ },
      _deletedAt: null,
    }).lean();
    expect(copies).toHaveLength(1);
    expect(copies[0].name).toBe("Double Promote PLA — Original");
    expect(copies[0].spools).toHaveLength(2);

    const freshParent = await Filament.findById(parent._id).lean();
    expect(freshParent.color).toBeNull();
    expect(freshParent.spools).toEqual([]);

    expect(lockedKeyCount()).toBe(0);
  });

  it("/promote racing a promoting first-variant POST: still exactly one promotion copy", async () => {
    const parent = await seedCarryingParent("Cross Promote PLA");
    // A pre-existing live variant so /promote passes its not_a_template
    // guard regardless of ordering.
    await Filament.create({
      name: "Cross Promote PLA — Blue",
      vendor: "V",
      type: "PLA",
      color: "#0000FF",
      parentId: parent._id,
    });
    const id = String(parent._id);

    // The parent already has a variant, so the create path's FIRST-variant
    // gate won't run its own promotion — but both routes still key on the
    // same id, so the /promote and the create serialize (the create can
    // never observe a half-promoted parent).
    const p = promoteReq(id);
    const v = variantPost({
      name: "Cross Promote PLA — Green",
      vendor: "V",
      type: "PLA",
      color: "#00FF00",
      parentId: id,
    });
    const [promoteRes, variantRes] = await Promise.all([p, v]);

    expect(promoteRes.status).toBe(200);
    expect(variantRes.status).toBe(201);

    const copies = await Filament.find({
      name: { $regex: /^Cross Promote PLA — Original/ },
      _deletedAt: null,
    }).lean();
    expect(copies).toHaveLength(1);

    expect(lockedKeyCount()).toBe(0);
  });

  // ── P1-c: totalWeight PUT vs first-variant promotion ─────────────────────

  for (const putFirst of [true, false]) {
    it(`PUT {totalWeight} vs promoting first-variant POST (${putFirst ? "PUT" : "variant"} submitted first): parent never re-materializes inventory`, async () => {
      const parent = await seedCarryingParent(`Weight Race PLA ${putFirst ? "A" : "B"}`);
      const id = String(parent._id);
      const base = `Weight Race PLA ${putFirst ? "A" : "B"}`;

      const putBody = { totalWeight: 500 };
      const variantBody = {
        name: `${base} — Red`,
        vendor: "V",
        type: "PLA",
        color: "#FF0000",
        parentId: id,
        promoteParent: true,
      };

      const [putRes, variantRes] = putFirst
        ? await (() => {
            const pu = putReq(id, putBody);
            const v = variantPost(variantBody);
            return Promise.all([pu, v]);
          })()
        : await (async () => {
            const v = variantPost(variantBody);
            const pu = putReq(id, putBody);
            const [rv, rp] = await Promise.all([v, pu]);
            return [rp, rv] as const;
          })();

      expect(putRes.status).toBe(200);
      expect(variantRes.status).toBe(201);

      // THE invariant: the template never ends up holding inventory.
      const freshParent = await Filament.findById(parent._id).lean();
      expect(freshParent.totalWeight ?? null).toBeNull();
      expect(freshParent.color).toBeNull();
      expect(freshParent.spools).toEqual([]);

      // The written weight either moved onto the promoted variant (PUT won
      // the key — the promotion's fresh snapshot copied it) or was stripped
      // at the write (promotion won — the PUT reports the strip).
      const promoted = await Filament.findOne({ name: `${base} — Original` }).lean();
      expect(promoted).toBeTruthy();
      const putResBody = await putRes.json();
      if (putResBody._strippedTemplateFields) {
        expect(putResBody._strippedTemplateFields).toEqual(["totalWeight"]);
        expect(promoted.totalWeight ?? null).toBeNull();
      } else {
        expect(promoted.totalWeight).toBe(500);
      }

      expect(lockedKeyCount()).toBe(0);
    });
  }

  // ── round 8 F1: reparent vs first-variant POST ───────────────────────────

  it("a reparent landing between the POST's pre-lock validation and the gate: the in-lock re-fetch refuses the grandchild (round 8 F1)", async () => {
    const parent = await seedCarryingParent("Nest Race PLA");
    const grandparent = await Filament.create({
      name: "Nest Race Root",
      vendor: "V",
      type: "PLA",
      color: null,
    });
    const id = String(parent._id);

    // Hold the parent's key so the POST passes its pre-lock validation
    // (the parent is still a root at that point) and queues at the gate;
    // the concurrent reparent lands while it waits.
    let release!: () => void;
    const holdUntil = new Promise<void>((r) => (release = r));
    const holder = runExclusive(filamentLockKey(id), async () => {
      await holdUntil;
    });
    const post = variantPost({
      name: "Nest Race PLA — Red",
      vendor: "V",
      type: "PLA",
      color: "#FF0000",
      parentId: id,
      promoteParent: true,
    });
    await new Promise((r) => setTimeout(r, 30));
    await Filament.updateOne({ _id: parent._id }, { $set: { parentId: grandparent._id } });
    release();
    await holder;

    // Same no-nesting 400 the pre-lock check produces — whether the POST
    // was already queued (gate re-fetch, the raced path) or slow enough to
    // see the reparent pre-lock, the observable is identical.
    const res = await post;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Cannot set a variant as parent (no nested inheritance)",
    );

    // No grandchild, no promotion copy; the (now-variant) parent keeps its
    // carried state untouched.
    expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
    const fresh = await Filament.findById(parent._id).lean();
    expect(String(fresh.parentId)).toBe(String(grandparent._id));
    expect(fresh.color).toBe("#336699");
    expect(fresh.spools).toHaveLength(2);
    expect(lockedKeyCount()).toBe(0);
  });

  // ── round 8 F3: DELETE vs first-variant POST ─────────────────────────────

  for (const deleteFirst of [true, false]) {
    it(`soft DELETE vs promoting first-variant POST (${deleteFirst ? "delete" : "variant"} submitted first): never a trashed parent with a live variant`, async () => {
      const base = `Trash Race PLA ${deleteFirst ? "A" : "B"}`;
      const parent = await seedCarryingParent(base);
      const id = String(parent._id);

      const variantBody = {
        name: `${base} — Red`,
        vendor: "V",
        type: "PLA",
        color: "#FF0000",
        parentId: id,
        promoteParent: true,
      };
      const del = () =>
        deleteFilament(
          new NextRequest(`http://localhost/api/filaments/${id}`, { method: "DELETE" }),
          { params: Promise.resolve({ id }) },
        );

      const [delRes, variantRes] = deleteFirst
        ? await (() => {
            const d = del();
            const v = variantPost(variantBody);
            return Promise.all([d, v]);
          })()
        : await (async () => {
            const v = variantPost(variantBody);
            const d = del();
            const [rv, rd] = await Promise.all([v, d]);
            return [rd, rv] as const;
          })();

      // Exactly one side wins, and the loser gets its designed refusal.
      expect([200, 400]).toContain(delRes.status);
      expect([201, 400]).toContain(variantRes.status);
      if (delRes.status === 200) {
        // Delete won: a childless doc went to trash; the POST's parent
        // vanished (pre-lock or at the gate's in-lock re-fetch) → 400.
        expect(variantRes.status).toBe(400);
        // Nothing was minted — not even a promotion copy.
        expect(await Filament.countDocuments({ parentId: parent._id })).toBe(0);
      } else {
        // Create won: the DELETE's in-lock hasVariants re-check refused.
        expect(variantRes.status).toBe(201);
        expect((await delRes.json()).error).toMatch(/has color variants/);
      }

      // THE invariant (what the resurrect exemptions + restore guards rely
      // on): a trashed doc never has live variants — asserted explicitly,
      // for whichever side entered the critical section first.
      const freshParent = await Filament.findById(parent._id).lean();
      const liveVariants = await Filament.countDocuments({
        parentId: parent._id,
        _deletedAt: null,
      });
      if (freshParent._deletedAt != null) {
        expect(liveVariants).toBe(0);
      } else {
        // Create won: the promoted template holds its two live variants
        // (the promotion copy + the requested one) and no inventory.
        expect(liveVariants).toBe(2);
        expect(freshParent.spools).toEqual([]);
        expect(freshParent.color).toBeNull();
      }

      expect(lockedKeyCount()).toBe(0);
    });
  }
});

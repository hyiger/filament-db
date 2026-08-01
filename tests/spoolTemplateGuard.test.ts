import { describe, it, expect, vi } from "vitest";
import { pushSpoolWithTemplateGuard } from "@/lib/spoolTemplateGuard";

/**
 * Review F3 on GH #605 — the spool-POST template guard's check-push-recheck-
 * compensate sequence (src/lib/spoolTemplateGuard.ts).
 *
 * The naive check-then-act guard raced a concurrent first-variant creation:
 * hasVariants read false, the variant landed, the $push then stranded a
 * fresh spool on a just-promoted template. The helper re-checks AFTER the
 * push and compensates by $pulling the exact spool it added.
 *
 * The variant-check is injected, so the race is simulated deterministically
 * with a stub that returns false on the first call and true on the second.
 * The model is a recording mock — the compensation's shape ($pull by the
 * fresh subdoc _id) is pinned exactly.
 */
describe("pushSpoolWithTemplateGuard (review F3 on GH #605)", () => {
  const SPOOL = { instanceId: "aabbccddee", label: "roll", totalWeight: 1000 };

  /** A mock model whose findOneAndUpdate resolves to `afterDoc` (via .lean())
   *  and records every call. */
  function mockModel(afterDoc: unknown) {
    return {
      calls: [] as Array<{ op: string; args: unknown[] }>,
      findOneAndUpdate(...args: unknown[]) {
        this.calls.push({ op: "push", args });
        return { lean: async () => afterDoc };
      },
      async updateOne(...args: unknown[]) {
        this.calls.push({ op: "pull", args });
        return { acknowledged: true };
      },
    };
  }

  it("pre-check already a template → refuses without pushing anything", async () => {
    const model = mockModel(null);
    const check = vi.fn().mockResolvedValue(true);

    const result = await pushSpoolWithTemplateGuard(model, "f1", SPOOL, check);

    expect(result).toEqual({ outcome: "template" });
    expect(model.calls).toEqual([]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(model, "f1");
  });

  it("no race → pushes once, re-checks, returns the post-push document", async () => {
    const after = { _id: "f1", spools: [{ _id: "s1", ...SPOOL }] };
    const model = mockModel(after);
    const check = vi.fn().mockResolvedValue(false);

    const result = await pushSpoolWithTemplateGuard(model, "f1", SPOOL, check);

    expect(result).toEqual({ outcome: "created", filament: after });
    expect(model.calls.map((c) => c.op)).toEqual(["push"]);
    expect(model.calls[0].args).toEqual([
      { _id: "f1", _deletedAt: null },
      { $push: { spools: SPOOL } },
      { returnDocument: "after" },
    ]);
    // Both the pre-check and the revalidation ran.
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("missing/trashed filament → not_found, no compensation attempted", async () => {
    const model = mockModel(null);
    const check = vi.fn().mockResolvedValue(false);

    const result = await pushSpoolWithTemplateGuard(model, "f1", SPOOL, check);

    expect(result).toEqual({ outcome: "not_found" });
    expect(model.calls.map((c) => c.op)).toEqual(["push"]);
    // The post-push re-check never runs for a document that wasn't there.
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("COMPENSATION: variant landed between check and push → $pulls the exact spool just added, reports template", async () => {
    // The post-push doc carries a concurrent writer's spool too — the pull
    // must match OUR fresh subdoc _id, never the neighbour's.
    const after = {
      _id: "f1",
      spools: [
        { _id: "other", instanceId: "1122334455", label: "concurrent" },
        { _id: "fresh", ...SPOOL },
      ],
    };
    const model = mockModel(after);
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = await pushSpoolWithTemplateGuard(model, "f1", SPOOL, check);

    expect(result).toEqual({ outcome: "template" });
    expect(model.calls.map((c) => c.op)).toEqual(["push", "pull"]);
    expect(model.calls[1].args).toEqual([
      { _id: "f1" },
      { $pull: { spools: { _id: "fresh" } } },
    ]);
  });

  it("compensation is skipped when the pushed spool can't be located (defensive)", async () => {
    // A post-push doc that somehow doesn't contain our instanceId — nothing
    // safe to pull; still refuse as a template.
    const after = { _id: "f1", spools: [{ _id: "other", instanceId: "1122334455" }] };
    const model = mockModel(after);
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = await pushSpoolWithTemplateGuard(model, "f1", SPOOL, check);

    expect(result).toEqual({ outcome: "template" });
    expect(model.calls.map((c) => c.op)).toEqual(["push"]);
  });

  it("compensation is skipped when the post-push doc has no spools array (defensive)", async () => {
    const after = { _id: "f1" };
    const model = mockModel(after);
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = await pushSpoolWithTemplateGuard(model, "f1", SPOOL, check);

    expect(result).toEqual({ outcome: "template" });
    expect(model.calls.map((c) => c.op)).toEqual(["push"]);
  });

  it("a push error propagates unchanged (nothing was written, nothing to compensate)", async () => {
    const model = {
      calls: [] as Array<{ op: string }>,
      findOneAndUpdate() {
        return {
          lean: async () => {
            throw new Error("boom");
          },
        };
      },
      async updateOne() {
        this.calls.push({ op: "pull" });
        return { acknowledged: true };
      },
    };
    const check = vi.fn().mockResolvedValue(false);

    await expect(pushSpoolWithTemplateGuard(model, "f1", SPOOL, check)).rejects.toThrow("boom");
    expect(model.calls).toEqual([]);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

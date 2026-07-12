import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as getFilament, PUT as putFilament } from "@/app/api/filaments/[id]/route";

/**
 * GH #160 regression guard.
 *
 * Mongoose validators (e.g. tdsUrl scheme guard) and pre-update hooks throw
 * plain Errors that the route's catch-all used to swallow as 500 with the
 * detail message tucked under `detail`. That made monitoring noisy (the
 * server is fine — the user's input was bad) and made it impossible for
 * the form renderer to distinguish "your URL is invalid" from "the server
 * is down". The fix routes those errors through `errorResponseFromCaught`,
 * which returns 400 with the validator message in `error`.
 */
describe("PUT /api/filaments/[id] — client-input rejections return 400", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when tdsUrl uses a non-http(s) scheme", async () => {
    const filament = await Filament.create({
      name: "Test PLA",
      vendor: "Generic",
      type: "PLA",
    });

    const req = new NextRequest(`http://localhost/api/filaments/${filament._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tdsUrl: "javascript:alert(1)" }),
    });
    const res = await putFilament(req, { params: Promise.resolve({ id: String(filament._id) }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must be a valid http\(s\) URL/i);
    // The 5xx fallback shape (`{error, detail}`) must NOT be used here;
    // monitoring branches on shape and a 400 should look different from a 500.
    expect(body.detail).toBeUndefined();
  });

  it("returns 400 for Mongoose schema validator failures", async () => {
    const filament = await Filament.create({
      name: "Test PLA",
      vendor: "Generic",
      type: "PLA",
    });

    // diameter is a number; a non-numeric string fails Mongoose's CastError
    // path. We want any client-input validation failure to be 4xx, not 5xx.
    const req = new NextRequest(`http://localhost/api/filaments/${filament._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tdsUrl: "ftp://example.com/file.pdf" }),
    });
    const res = await putFilament(req, { params: Promise.resolve({ id: String(filament._id) }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must be a valid http\(s\) URL/i);
  });

  it("still returns 200 for a valid tdsUrl update", async () => {
    const filament = await Filament.create({
      name: "Test PLA",
      vendor: "Generic",
      type: "PLA",
    });

    const req = new NextRequest(`http://localhost/api/filaments/${filament._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tdsUrl: "https://example.com/tds.pdf" }),
    });
    const res = await putFilament(req, { params: Promise.resolve({ id: String(filament._id) }) });

    expect(res.status).toBe(200);
  });

  it("GET with an invalid ObjectId path param returns 400, not 500 (GH #202)", async () => {
    // Pre-fix the route used `errorResponse(..., 500, getErrorMessage)` and
    // Mongoose's CastError leaked through as a 500 server-fault status —
    // bad UX (renderers couldn't tell input from server failure) and bad
    // for monitoring (alerts on copy-paste typos).
    const req = new NextRequest("http://localhost/api/filaments/notavalidobjectid");
    const res = await getFilament(req, { params: Promise.resolve({ id: "notavalidobjectid" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    // Mongoose's CastError message includes "Cast to ObjectId failed"
    expect(body.error).toMatch(/Cast to ObjectId failed/i);
  });

  it("PUT with an invalid ObjectId path param returns 400, not 500 (GH #202)", async () => {
    const req = new NextRequest("http://localhost/api/filaments/notavalidobjectid", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "anything" }),
    });
    const res = await putFilament(req, { params: Promise.resolve({ id: "notavalidobjectid" }) });
    expect(res.status).toBe(400);
  });

  it("PUT renaming to an existing name surfaces a specific 409 instead of the generic 'Failed to update filament' 500 (PR #357)", async () => {
    // User-reported: renaming a filament to a name already in use only
    // showed "Failed to update filament" — the duplicate-key error
    // wasn't being unwrapped, so the toast couldn't tell the user
    // *why* the save failed. The POST handler always called
    // handleDuplicateKeyError; the PUT didn't. Lock down the symmetry.
    //
    // The unique-on-non-deleted-name index is declared on the schema
    // but not auto-built by the in-memory MongoDB for these tests
    // (`tests/setup.ts` wipes `mongoose.models` between tests, so the
    // dbConnect-side `syncIndexes` migration doesn't run). Force-build
    // it here so the duplicate-key error actually fires.
    await Filament.syncIndexes();
    await Filament.create({ name: "Galaxy Black", vendor: "Test", type: "PLA" });
    const second = await Filament.create({ name: "Spectrum Orange", vendor: "Test", type: "PLA" });

    const req = new NextRequest(`http://localhost/api/filaments/${second._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Galaxy Black" }),
    });
    const res = await putFilament(req, { params: Promise.resolve({ id: String(second._id) }) });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
    expect(body.error).toMatch(/Galaxy Black/);
    // The 5xx-fallback shape (`{ error, detail }`) must NOT be used —
    // monitoring branches on shape, and a clean 409 should look
    // distinct from a server fault.
    expect(body.detail).toBeUndefined();
  });

  // ── GH #1004 F7: concurrent re-parent can't create an A⇄B cycle ──
  //
  // The parentId validation is check-then-act. Two opposing re-parent PUTs
  // (A→B and B→A) can each pass validation against pre-write state and both
  // persist, forming a mutual cycle that resolveFilament (single-level by
  // design) assumes cannot exist. A post-write re-assertion reverts + 409s.

  function putReq(id: string, body: unknown) {
    return putFilament(
      new NextRequest(`http://localhost/api/filaments/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("F7: re-parenting to a valid root still succeeds (no false 409)", async () => {
    const parent = await Filament.create({ name: "Root P", vendor: "T", type: "PLA" });
    const child = await Filament.create({ name: "Child C", vendor: "T", type: "PLA" });

    const res = await putReq(String(child._id), { parentId: String(parent._id) });
    expect(res.status).toBe(200);

    const reloaded = await Filament.findById(child._id).lean();
    expect(String(reloaded.parentId)).toBe(String(parent._id));
  });

  it("F7: rolls parentId back to a safe root (null) + 409 when the post-write re-assert finds a violation", async () => {
    // The child STARTS as a variant of oldParent (X), so a "roll back to a safe
    // root (null)" is observably different from "restore the old parent (X)" —
    // pinning the Codex P2 (×2) fix.
    const oldParent = await Filament.create({ name: "Old Parent X", vendor: "T", type: "PLA" });
    const newParent = await Filament.create({ name: "New Parent B", vendor: "T", type: "PLA" });
    const child = await Filament.create({
      name: "Child C", vendor: "T", type: "PLA", parentId: oldParent._id,
    });

    // Deterministically simulate the check-then-act race: the pre-write
    // variant-count reads 0 (validation passes), but by the post-write
    // re-assertion this doc has gained a child (a concurrent PUT pointed a
    // variant at it). A re-parent PUT calls countDocuments exactly twice —
    // the pre-write guard, then the post-write re-check — in that order.
    //
    // Spy on the SAME model object the route uses (its module default). The
    // beforeEach re-registers a DIFFERENT object after setup's model reset,
    // so spying on the test's `Filament` would miss the route's calls.
    const routeFilament = (await import("@/models/Filament")).default;
    vi.spyOn(routeFilament, "countDocuments")
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    // Observe the rollback filter + update (spy calls through, revert still runs).
    const updateSpy = vi.spyOn(routeFilament, "updateOne");

    const res = await putReq(String(child._id), { parentId: String(newParent._id) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/concurrent|cycle|nested/i);

    // Codex P2 (×2) on PR #1012: the rollback must (a) be scoped to the parent
    // THIS request wrote + a live row, so a concurrent newer re-parent isn't
    // clobbered, and (b) set parentId to a SAFE root (null), NOT restore the old
    // parent — which a concurrent PUT could have turned into a variant.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const rollbackFilter = updateSpy.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(String(rollbackFilter.parentId)).toBe(String(newParent._id));
    expect(rollbackFilter._deletedAt).toBeNull();
    const rollbackUpdate = updateSpy.mock.calls[0][1] as unknown as { $set?: { parentId?: unknown } };
    expect(rollbackUpdate.$set).toBeDefined();
    expect(rollbackUpdate.$set!.parentId).toBeNull();

    // The child is left as a ROOT (null) — NOT restored to old parent X.
    const reloaded = await Filament.findById(child._id).lean();
    expect(reloaded.parentId ?? null).toBeNull();
  });

  it("F7: runs the post-write re-assert even on an ECHOED (unchanged) parentId (Codex P2 r3)", async () => {
    // The edit form re-submits parentId on every save, so a stale save can echo
    // the child's CURRENT parent (reparenting == false). If a race meanwhile
    // invalidated the relationship, a `reparenting`-gated check would skip it.
    // Gating on the WRITTEN parentId re-validates every parented write.
    const parentX = await Filament.create({ name: "Parent X", vendor: "T", type: "PLA" });
    const child = await Filament.create({
      name: "Child C", vendor: "T", type: "PLA", parentId: parentX._id,
    });

    const routeFilament = (await import("@/models/Filament")).default;
    // Pre-write variant-count 0 (validation passes); post-write re-check sees 1
    // (the child concurrently gained a variant). countDocuments runs twice even
    // on an echoed write — the pre-write guard is gated on body.parentId, not
    // reparenting — so the mock order still lines up.
    vi.spyOn(routeFilament, "countDocuments")
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    // Echo the SAME parent the child already has — reparenting is false, so the
    // OLD `reparenting`-gated check would skip and return 200.
    const res = await putReq(String(child._id), { parentId: String(parentX._id) });
    expect(res.status).toBe(409);

    // Healed to a safe root even though parentId didn't change.
    const reloaded = await Filament.findById(child._id).lean();
    expect(reloaded.parentId ?? null).toBeNull();
  });

  it("F7: two opposing concurrent re-parents never persist a mutual A⇄B cycle", async () => {
    const a = await Filament.create({ name: "A", vendor: "T", type: "PLA" });
    const b = await Filament.create({ name: "B", vendor: "T", type: "PLA" });

    await Promise.all([
      putReq(String(a._id), { parentId: String(b._id) }),
      putReq(String(b._id), { parentId: String(a._id) }),
    ]);

    const [ra, rb] = await Promise.all([
      Filament.findById(a._id).lean(),
      Filament.findById(b._id).lean(),
    ]);
    const aToB = String(ra.parentId ?? "") === String(b._id);
    const bToA = String(rb.parentId ?? "") === String(a._id);
    // The invariant that must always hold: never both directions at once.
    expect(aToB && bToA).toBe(false);
  });
});

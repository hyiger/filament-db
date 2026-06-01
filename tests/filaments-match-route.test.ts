import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as matchFilaments } from "@/app/api/filaments/match/route";

/**
 * Route-level tests for /api/filaments/match — the endpoint the NFC scan
 * flow uses to match a decoded tag against the filament DB.
 *
 * Regression focus: a confident `match` must require type agreement.
 * Vendor alone is not enough — a scanned PC spool once matched the user's
 * only Bambu PLA filament because the vendor-only fallback promoted a
 * lone vendor hit to a definitive match.
 */
describe("/api/filaments/match", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  function matchReq(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    return new NextRequest(`http://localhost/api/filaments/match?${qs}`);
  }

  const names = (list: { name: string }[]) => list.map((c) => c.name).sort();

  it("returns a confident match on an exact (case-insensitive) name", async () => {
    await Filament.create({ name: "Bambu PC Black", vendor: "Bambu Lab", type: "PC" });
    const res = await matchFilaments(
      matchReq({ name: "bambu pc black", vendor: "Bambu Lab", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match?.name).toBe("Bambu PC Black");
    expect(body.candidates).toEqual([]);
  });

  it("promotes a single vendor+type hit to the match", async () => {
    await Filament.create({ name: "Bambu PC Black", vendor: "Bambu Lab", type: "PC" });
    const res = await matchFilaments(
      matchReq({ name: "PC", vendor: "Bambu Lab", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match?.name).toBe("Bambu PC Black");
    expect(body.candidates).toEqual([]);
  });

  it("returns multiple vendor+type hits as candidates, with no auto-match", async () => {
    await Filament.create({ name: "Bambu PC Black", vendor: "Bambu Lab", type: "PC" });
    await Filament.create({ name: "Bambu PC Clear", vendor: "Bambu Lab", type: "PC" });
    const res = await matchFilaments(
      matchReq({ name: "PC", vendor: "Bambu Lab", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(names(body.candidates)).toEqual(["Bambu PC Black", "Bambu PC Clear"]);
  });

  it("does NOT auto-match on vendor alone when the type differs", async () => {
    // The DB's only Bambu filament is PLA. A PC tag must not match it —
    // it may only be offered as a candidate for the user to confirm.
    await Filament.create({ name: "PLA Silk+", vendor: "Bambu Lab", type: "PLA" });
    const res = await matchFilaments(
      matchReq({ name: "PC", vendor: "Bambu Lab", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(names(body.candidates)).toEqual(["PLA Silk+"]);
  });

  it("returns no match and no candidates for an unknown vendor", async () => {
    await Filament.create({ name: "PLA Silk+", vendor: "Bambu Lab", type: "PLA" });
    const res = await matchFilaments(
      matchReq({ name: "PC", vendor: "Polymaker", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(body.candidates).toEqual([]);
  });

  it("GH PR #487: returns a confident match on exact instanceId", async () => {
    // The label-printer dialog's instance-ID QR mode encodes the bare
    // 5-byte hex. Without this branch the QR resolves to nothing because
    // /api/filaments/match originally only knew about name/vendor/type.
    await Filament.create({
      name: "Comgrow PLA Red",
      vendor: "Comgrow",
      type: "PLA",
      instanceId: "bbf3c4352f",
    });
    const res = await matchFilaments(matchReq({ instanceId: "bbf3c4352f" }));
    const body = await res.json();
    expect(body.match?.name).toBe("Comgrow PLA Red");
    expect(body.candidates).toEqual([]);
  });

  it("PR #487: instanceId match is case-insensitive", async () => {
    await Filament.create({
      name: "ABS+",
      vendor: "eSun",
      type: "ABS+",
      instanceId: "deadbeef42",
    });
    const res = await matchFilaments(matchReq({ instanceId: "DEADBEEF42" }));
    const body = await res.json();
    expect(body.match?.name).toBe("ABS+");
  });

  it("PR #487 r15: case-insensitivity works in BOTH directions (uppercase stored / lowercase queried)", async () => {
    // The schema generates lowercase hex going forward, but legacy /
    // re-imported filaments may carry uppercase or mixed-case values.
    // Both directions must match — the comparison can't normalise just
    // one side. (Codex P2 round 14 on PR #487.)
    await Filament.create({
      name: "Legacy uppercase",
      vendor: "Test",
      type: "PLA",
      instanceId: "DEADBEEF42",
    });
    const res = await matchFilaments(matchReq({ instanceId: "deadbeef42" }));
    const body = await res.json();
    expect(body.match?.name).toBe("Legacy uppercase");
  });

  it("PR #487: instanceId no-match falls through to name/vendor/type", async () => {
    // A label-printer QR for a filament that no longer exists shouldn't
    // 404 — fall through so the scanner UI can still offer suggestions
    // from whatever else the caller provided.
    await Filament.create({
      name: "Bambu PC Black",
      vendor: "Bambu Lab",
      type: "PC",
    });
    const res = await matchFilaments(
      matchReq({
        instanceId: "0000000000",
        name: "Bambu PC Black",
      }),
    );
    const body = await res.json();
    // No instanceId hit, but the name fallback fires.
    expect(body.match?.name).toBe("Bambu PC Black");
  });

  it("PR #487: malformed instanceId values are rejected (no regex injection)", async () => {
    // Stray query values shouldn't blow up the regex or accidentally
    // match anything — the validator restricts to 1–32 hex chars.
    const res = await matchFilaments(
      matchReq({ instanceId: ".*; drop table filaments; --" }),
    );
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(body.candidates).toEqual([]);
  });

  it("PR #487: instanceId excludes soft-deleted filaments", async () => {
    await Filament.create({
      name: "Trashed",
      vendor: "Test",
      type: "PLA",
      instanceId: "deadbeefab",
      _deletedAt: new Date(),
    });
    const res = await matchFilaments(matchReq({ instanceId: "deadbeefab" }));
    const body = await res.json();
    expect(body.match).toBeNull();
  });

  it("excludes soft-deleted filaments from matches and candidates", async () => {
    await Filament.create({
      name: "Bambu PC Black",
      vendor: "Bambu Lab",
      type: "PC",
      _deletedAt: new Date(),
    });
    const res = await matchFilaments(
      matchReq({ name: "PC", vendor: "Bambu Lab", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(body.candidates).toEqual([]);
  });
});

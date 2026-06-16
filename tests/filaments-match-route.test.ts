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

  it("PR #487: non-hex instance IDs (legacy imports) still match", async () => {
    // The schema doesn't enforce hex — importFilaments.ts assigns
    // row.instanceId verbatim, and existing rows may carry strings
    // like "custom-id-123". The match endpoint must resolve them.
    // (Codex P2 round 15 on PR #487.)
    await Filament.create({
      name: "Imported custom ID",
      vendor: "Test",
      type: "PLA",
      instanceId: "custom-id-123",
    });
    const res = await matchFilaments(
      matchReq({ instanceId: "custom-id-123" }),
    );
    const body = await res.json();
    expect(body.match?.name).toBe("Imported custom ID");
  });

  it("PR #487: regex-special characters in stored instanceId are matched literally", async () => {
    // escapeRegex protects against accidental regex semantics — a
    // stored value `a.b*c` must match the literal string, not "a"
    // followed by any char, etc.
    await Filament.create({
      name: "Has regex chars",
      vendor: "Test",
      type: "PLA",
      instanceId: "a.b*c",
    });
    const res = await matchFilaments(matchReq({ instanceId: "a.b*c" }));
    const body = await res.json();
    expect(body.match?.name).toBe("Has regex chars");
  });

  it("PR #487: regex-special queries don't match unrelated stored IDs", async () => {
    // The opposite direction: a malformed query like ".*" must NOT
    // match every filament. escapeRegex makes the query literal.
    await Filament.create({
      name: "Unrelated",
      vendor: "Test",
      type: "PLA",
      instanceId: "deadbeef42",
    });
    const res = await matchFilaments(matchReq({ instanceId: ".*" }));
    const body = await res.json();
    expect(body.match).toBeNull();
  });

  it("PR #487 r17: case-only collision picks the exact-case row deterministically", async () => {
    // Legacy data can hold both "ABC" and "abc" because the partial
    // unique index on instanceId is case-sensitive. A query for one
    // of them must return THAT one, not the other — the exact-case
    // match runs before the case-insensitive fallback. (Codex P2
    // round 16 on PR #487.)
    await Filament.create({
      name: "Upper case",
      vendor: "Test",
      type: "PLA",
      instanceId: "ABC123",
    });
    await Filament.create({
      name: "Lower case",
      vendor: "Test",
      type: "PLA",
      instanceId: "abc123",
    });
    const upper = await matchFilaments(matchReq({ instanceId: "ABC123" }));
    expect((await upper.json()).match?.name).toBe("Upper case");
    const lower = await matchFilaments(matchReq({ instanceId: "abc123" }));
    expect((await lower.json()).match?.name).toBe("Lower case");
  });

  it("PR #487 r17: case-only collision with no exact hit returns candidates (no arbitrary pick)", async () => {
    // If the query case matches NEITHER stored row but does match
    // both case-insensitively, we'd be picking arbitrarily — refuse
    // and surface both as candidates instead.
    await Filament.create({
      name: "Upper case",
      vendor: "Test",
      type: "PLA",
      instanceId: "ABC123",
    });
    await Filament.create({
      name: "Lower case",
      vendor: "Test",
      type: "PLA",
      instanceId: "abc123",
    });
    const res = await matchFilaments(matchReq({ instanceId: "AbC123" }));
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates.map((c: { name: string }) => c.name).sort()).toEqual([
      "Lower case",
      "Upper case",
    ]);
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

  // #732 Phase 2: resolve by spools[].instanceId, report which spool, and keep
  // the filament-level fallback.
  describe("#732 spool-level instanceId resolution", () => {
    it("resolves an exact spool instanceId and reports the matched spool", async () => {
      const f = await Filament.create({
        name: "Spool Match PLA",
        vendor: "Test",
        type: "PLA",
        spools: [
          { label: "Drybox A", totalWeight: 1000, instanceId: "5p00111111" },
          { label: "Shelf B", totalWeight: 800, instanceId: "5pool22222" },
        ],
      });
      const res = await matchFilaments(matchReq({ instanceId: "5pool22222" }));
      const body = await res.json();
      expect(body.match?.name).toBe("Spool Match PLA");
      expect(body.candidates).toEqual([]);
      expect(body.matchedSpool).toMatchObject({
        instanceId: "5pool22222",
        label: "Shelf B",
        _id: String(f.spools[1]._id),
      });
    });

    it("resolves a spool instanceId case-insensitively", async () => {
      await Filament.create({
        name: "CI Spool PLA",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "A", totalWeight: 1000, instanceId: "ABCDEF0011" }],
      });
      const res = await matchFilaments(matchReq({ instanceId: "abcdef0011" }));
      const body = await res.json();
      expect(body.match?.name).toBe("CI Spool PLA");
      expect(body.matchedSpool?.instanceId).toBe("ABCDEF0011");
    });

    it("a spool hit wins over a filament whose top-level instanceId also matches", async () => {
      // Filament Y carries the queried id at the FILAMENT level; filament X
      // carries it on a SPOOL. The spool tier runs first, so X wins.
      await Filament.create({
        name: "Filament-level Y",
        vendor: "Test",
        type: "PLA",
        instanceId: "c0111db123",
      });
      await Filament.create({
        name: "Spool-level X",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "S", totalWeight: 900, instanceId: "c0111db123" }],
      });
      const res = await matchFilaments(matchReq({ instanceId: "c0111db123" }));
      const body = await res.json();
      expect(body.match?.name).toBe("Spool-level X");
      expect(body.matchedSpool?.instanceId).toBe("c0111db123");
    });

    it("falls back to the filament-level instanceId when no spool matches (matchedSpool null)", async () => {
      await Filament.create({
        name: "Legacy Filament ID",
        vendor: "Test",
        type: "PLA",
        instanceId: "fa11bac001",
        spools: [{ label: "S", totalWeight: 900, instanceId: "differentaa" }],
      });
      const res = await matchFilaments(matchReq({ instanceId: "fa11bac001" }));
      const body = await res.json();
      expect(body.match?.name).toBe("Legacy Filament ID");
      expect(body.matchedSpool).toBeNull();
    });

    it("a cross-filament spool id collision is ambiguous (candidates, no match)", async () => {
      await Filament.create({
        name: "Collide One",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "S", totalWeight: 900, instanceId: "c0111de999" }],
      });
      await Filament.create({
        name: "Collide Two",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "S", totalWeight: 900, instanceId: "c0111de999" }],
      });
      const res = await matchFilaments(matchReq({ instanceId: "c0111de999" }));
      const body = await res.json();
      expect(body.match).toBeNull();
      expect(body.matchedSpool).toBeNull();
      expect(names(body.candidates)).toEqual(["Collide One", "Collide Two"]);
    });

    it("excludes soft-deleted filaments from spool resolution", async () => {
      await Filament.create({
        name: "Trashed Spool",
        vendor: "Test",
        type: "PLA",
        _deletedAt: new Date(),
        spools: [{ label: "S", totalWeight: 900, instanceId: "dead5p0011" }],
      });
      const res = await matchFilaments(matchReq({ instanceId: "dead5p0011" }));
      const body = await res.json();
      expect(body.match).toBeNull();
      expect(body.matchedSpool).toBeNull();
    });

    it("a name match carries matchedSpool: null", async () => {
      await Filament.create({ name: "Named PLA", vendor: "Test", type: "PLA" });
      const res = await matchFilaments(matchReq({ name: "Named PLA" }));
      const body = await res.json();
      expect(body.match?.name).toBe("Named PLA");
      expect(body.matchedSpool).toBeNull();
    });
  });
});

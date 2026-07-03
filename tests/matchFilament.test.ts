import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { matchFilament, escapeRegex } from "@/lib/matchFilament";

/**
 * Direct unit tests for the `matchFilament` helper (the shared match-priority
 * logic behind GET /api/filaments/match and POST /api/nfc/decode).
 *
 * The route-level suite (tests/filaments-match-route.test.ts) already pins the
 * happy paths through the endpoint. These target the remaining uncovered
 * behaviours in src/lib/matchFilament.ts by calling the helper directly:
 *   - the case-insensitive SPOOL-id tier resolving a CROSS-filament collision
 *     to candidates (line 143 / the `ciPairs.length > 1` branch), and
 *   - `toMatchedSpool` coping with a spool that has a non-string label.
 */
describe("matchFilament", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    // setup.ts wipes mongoose.models between tests; re-register the model so
    // .create() works and the helper's captured Filament reference resolves.
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  const names = (list: unknown[]) =>
    (list as { name: string }[]).map((c) => c.name).sort();

  describe("escapeRegex", () => {
    it("escapes every regex metacharacter", () => {
      expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
      expect(escapeRegex(".*+?^${}()|[]\\")).toBe(
        "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
      );
    });

    it("leaves ordinary characters untouched", () => {
      expect(escapeRegex("deadbeef42")).toBe("deadbeef42");
    });
  });

  // #732: the case-insensitive SPOOL-id tier. The exact-case tier runs first;
  // when the query case matches NEITHER stored spool id, we fall to the CI
  // tier, and a CROSS-filament CI collision must surface as candidates rather
  // than an arbitrary pick (matchFilament.ts line 143 / `ciPairs.length > 1`).
  describe("case-insensitive spool-id cross-filament collision (line 143)", () => {
    it("returns both filaments as candidates when the query case matches neither exactly", async () => {
      await Filament.create({
        name: "Upper Spool",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "S", totalWeight: 900, instanceId: "ABC123" }],
      });
      await Filament.create({
        name: "Lower Spool",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "S", totalWeight: 900, instanceId: "abc123" }],
      });

      // "AbC123" equals neither "ABC123" nor "abc123" exactly → exact tier
      // finds nothing → CI tier matches BOTH → ambiguous.
      const res = await matchFilament({ instanceId: "AbC123" });
      expect(res.match).toBeNull();
      expect(res.matchedSpool).toBeNull();
      expect(names(res.candidates)).toEqual(["Lower Spool", "Upper Spool"]);
    });

    it("still resolves to a single filament (no candidates) when only one CI spool matches", async () => {
      // Guards the boundary: a lone CI spool hit is a confident match with the
      // matched spool reported — distinguishes the >1 branch from the ==1 one.
      const f = await Filament.create({
        name: "CI Single Spool",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "Drybox", totalWeight: 1000, instanceId: "CAFEBABE01" }],
      });
      const res = await matchFilament({ instanceId: "cafebabe01" });
      expect((res.match as { name: string }).name).toBe("CI Single Spool");
      expect(res.candidates).toEqual([]);
      expect(res.matchedSpool).toMatchObject({
        instanceId: "CAFEBABE01",
        label: "Drybox",
        _id: String(f.spools[0]._id),
      });
    });
  });

  // toMatchedSpool: the matched spool's label is coerced to "" when it isn't a
  // string (matchFilament.ts line 74 false branch). The schema defaults label
  // to "", but a spool written with an explicit null (legacy / import data)
  // reads back as null on .lean(), so the non-string guard is reachable.
  describe("toMatchedSpool label coercion (line 74)", () => {
    it("reports an empty-string label for a spool whose label is null", async () => {
      const f = await Filament.create({
        name: "Null Label Spool",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: null, totalWeight: 500, instanceId: "n0lab3l001" }],
      });
      const res = await matchFilament({ instanceId: "n0lab3l001" });
      expect((res.match as { name: string }).name).toBe("Null Label Spool");
      expect(res.matchedSpool).toMatchObject({
        instanceId: "n0lab3l001",
        label: "",
        _id: String(f.spools[0]._id),
      });
      // The coercion produces a real string, never null/undefined.
      expect(typeof res.matchedSpool?.label).toBe("string");
    });

    it("preserves a genuine string label (line 74 truthy branch)", async () => {
      await Filament.create({
        name: "Labelled Spool",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "Shelf 3", totalWeight: 500, instanceId: "lab3l3d001" }],
      });
      const res = await matchFilament({ instanceId: "lab3l3d001" });
      expect(res.matchedSpool?.label).toBe("Shelf 3");
    });
  });

  // A couple of thin direct-call coverage points for the non-instanceId tiers,
  // confirming the helper's contract independent of the route wrapper.
  describe("name / vendor+type tiers (direct call)", () => {
    it("resolves an exact case-insensitive name with matchedSpool null", async () => {
      await Filament.create({ name: "Direct PLA", vendor: "Test", type: "PLA" });
      const res = await matchFilament({ name: "direct pla" });
      expect((res.match as { name: string }).name).toBe("Direct PLA");
      expect(res.matchedSpool).toBeNull();
    });

    // GH #954: the name index is case-sensitive, so "PLA Black" and "pla black"
    // can both be active. A query matching NEITHER exactly must surface both as
    // candidates, never auto-pick one (which the SSE bus would silently select).
    it("returns both filaments as candidates on a case-only name collision", async () => {
      await Filament.create({ name: "PLA Black", vendor: "Test", type: "PLA" });
      await Filament.create({ name: "pla black", vendor: "Test", type: "PLA" });
      const res = await matchFilament({ name: "PLA BLACK" });
      expect(res.match).toBeNull();
      expect(res.matchedSpool).toBeNull();
      expect(names(res.candidates)).toEqual(["PLA Black", "pla black"]);
    });

    // Exact case wins outright — a case-variant sibling must NOT demote an exact
    // hit to ambiguous.
    it("prefers the exact-case name when a case-variant sibling exists", async () => {
      await Filament.create({ name: "PLA Black", vendor: "Test", type: "PLA" });
      await Filament.create({ name: "pla black", vendor: "Test", type: "PLA" });
      const res = await matchFilament({ name: "pla black" });
      expect((res.match as { name: string }).name).toBe("pla black");
      expect(res.candidates).toEqual([]);
    });

    it("returns the empty result when nothing is supplied", async () => {
      const res = await matchFilament({});
      expect(res).toEqual({ match: null, candidates: [], matchedSpool: null });
    });
  });

  // #955.12: every match query prunes the heavy spool subfields (a photoDataUrl
  // data URL can be ~5 MB; usageHistory / dryCycles grow unbounded) that no scan
  // consumer reads, while keeping the identity fields the matcher — and the
  // matchedSpool builder — depend on. Pure-exclusion projection: everything
  // else, including spools[].instanceId / label, survives.
  describe("heavy-field projection (#955.12)", () => {
    const heavySpool = (label: string, instanceId: string) => ({
      label,
      totalWeight: 1000,
      instanceId,
      photoDataUrl: "data:image/png;base64,AAAAAAAA",
      usageHistory: [{ grams: 12, date: new Date() }],
      dryCycles: [{ date: new Date(), tempC: 50, durationMin: 120 }],
    });

    const assertPruned = (spool: Record<string, unknown>) => {
      expect(spool.photoDataUrl).toBeUndefined();
      expect(spool.usageHistory).toBeUndefined();
      expect(spool.dryCycles).toBeUndefined();
    };

    it("omits photoDataUrl / usageHistory / dryCycles from a name-tier match, keeping spool identity", async () => {
      await Filament.create({
        name: "Projected PLA",
        vendor: "Acme",
        type: "PLA",
        spools: [heavySpool("Bin 1", "proj0000a1")],
      });
      const res = await matchFilament({ name: "Projected PLA" });
      const spool = (res.match as { spools: Record<string, unknown>[] }).spools[0];
      assertPruned(spool);
      // Identity fields the consumers rely on survive the pure-exclusion projection.
      expect(spool.instanceId).toBe("proj0000a1");
      expect(spool.label).toBe("Bin 1");
      expect(spool.totalWeight).toBe(1000);
    });

    it("prunes candidates in the vendor+type tier too", async () => {
      await Filament.create({
        name: "Cand A",
        vendor: "Acme",
        type: "PETG",
        spools: [heavySpool("A", "cand0000a1")],
      });
      await Filament.create({
        name: "Cand B",
        vendor: "Acme",
        type: "PETG",
        spools: [heavySpool("B", "cand0000b1")],
      });
      const res = await matchFilament({ vendor: "Acme", type: "PETG" });
      expect(res.match).toBeNull();
      expect(res.candidates.length).toBe(2);
      for (const c of res.candidates as { spools: Record<string, unknown>[] }[]) {
        assertPruned(c.spools[0]);
      }
    });

    it("still resolves matchedSpool from the pruned spool tier", async () => {
      const f = await Filament.create({
        name: "Spool Tier",
        vendor: "Acme",
        type: "PLA",
        spools: [heavySpool("Drybox", "spool00001")],
      });
      const res = await matchFilament({ instanceId: "spool00001" });
      expect(res.matchedSpool).toMatchObject({
        instanceId: "spool00001",
        label: "Drybox",
        _id: String(f.spools[0]._id),
      });
      assertPruned((res.match as { spools: Record<string, unknown>[] }).spools[0]);
    });
  });
});

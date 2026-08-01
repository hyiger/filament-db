import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import {
  decideSpoolDeepLink,
  healedSpoolDeepLinkHref,
} from "@/lib/spoolDeepLink";
import { buildFilamentDeepLink } from "@/lib/labelDeepLink";
import { performParentPromotion } from "@/lib/promoteParent";

/**
 * Round 7 P2 — self-healing spool deep links (src/lib/spoolDeepLink.ts).
 *
 * Printed labels encode `/filaments/<id>?spool=<spoolId>` permanently
 * (buildFilamentDeepLink); a GH #605 promotion moves the spool onto the
 * variant while preserving its subdoc _id, so the printed filament id goes
 * stale. The detail page heals at resolution time: spool not on the
 * addressed doc → resolve the true owner via GET /api/spools/{spoolId} →
 * router.replace to the owner with the query string intact.
 *
 * The pure decision helpers are unit-tested first; the promotion-integration
 * cases then walk the exact page flow against the real models + route
 * (mongodb-memory-server via tests/setup.ts) using the same fixtures the
 * promoteParent tests use. The page effect itself is a client component the
 * node test env can't render — these pin every branch it delegates to.
 */
describe("spool deep-link self-heal (round 7 P2)", () => {
  // ── decideSpoolDeepLink (pure) ──────────────────────────────────────────

  it("no ?spool= param → none (with or without other params)", () => {
    expect(decideSpoolDeepLink("", ["a", "b"])).toEqual({ action: "none" });
    expect(decideSpoolDeepLink("?foo=1", ["a"])).toEqual({ action: "none" });
  });

  it("spool on the addressed doc → highlight, never a redirect", () => {
    expect(decideSpoolDeepLink("?spool=b", ["a", "b"])).toEqual({
      action: "highlight",
      spoolId: "b",
    });
    // Other params riding along don't change the classification.
    expect(decideSpoolDeepLink("?x=1&spool=a&y=2", ["a"])).toEqual({
      action: "highlight",
      spoolId: "a",
    });
  });

  it("spool NOT on the addressed doc → resolve (the stale-label case)", () => {
    expect(decideSpoolDeepLink("?spool=gone", ["a", "b"])).toEqual({
      action: "resolve",
      spoolId: "gone",
    });
    expect(decideSpoolDeepLink("?spool=x", [])).toEqual({
      action: "resolve",
      spoolId: "x",
    });
  });

  // ── healedSpoolDeepLinkHref (pure) ──────────────────────────────────────

  it("builds the owner's page with the FULL original query string preserved", () => {
    expect(healedSpoolDeepLinkHref("stale", "owner1", "?spool=s1")).toBe(
      "/filaments/owner1?spool=s1",
    );
    // Every other param rides along verbatim — not just ?spool=.
    expect(
      healedSpoolDeepLinkHref("stale", "owner1", "?spool=s1&from=label&x=%C3%A4"),
    ).toBe("/filaments/owner1?spool=s1&from=label&x=%C3%A4");
  });

  it("percent-encodes the owner id segment", () => {
    expect(healedSpoolDeepLinkHref("stale", "a/b", "?spool=s")).toBe(
      "/filaments/a%2Fb?spool=s",
    );
  });

  it("no owner (spool exists nowhere) → null: keep the current not-found posture", () => {
    expect(healedSpoolDeepLinkHref("stale", null, "?spool=s")).toBeNull();
    expect(healedSpoolDeepLinkHref("stale", undefined, "?spool=s")).toBeNull();
    expect(healedSpoolDeepLinkHref("stale", "", "?spool=s")).toBeNull();
    expect(healedSpoolDeepLinkHref("stale", "   ", "?spool=s")).toBeNull();
  });

  it("owner IS the addressed doc → null (nothing to heal; loop guard)", () => {
    expect(healedSpoolDeepLinkHref("same", "same", "?spool=s")).toBeNull();
  });

  // ── promotion integration (real models + the real resolver route) ───────

  describe("against the real models and GET /api/spools/{spoolId}", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let Filament: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let externalRefs: { printHistory: any; printer: any };

    beforeEach(async () => {
      const filMod = await import("@/models/Filament");
      const histMod = await import("@/models/PrintHistory");
      const printerMod = await import("@/models/Printer");
      if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
      if (!mongoose.models.PrintHistory)
        mongoose.model("PrintHistory", histMod.default.schema);
      if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
      Filament = mongoose.models.Filament;
      externalRefs = {
        printHistory: mongoose.models.PrintHistory,
        printer: mongoose.models.Printer,
      };
    });

    async function resolveSpoolViaRoute(spoolId: string) {
      const { GET } = await import("@/app/api/spools/[spoolId]/route");
      return GET(new NextRequest(`http://localhost/api/spools/${spoolId}`), {
        params: Promise.resolve({ spoolId }),
      });
    }

    /** The `?spool=…` search string a printed label's QR carries. */
    function labelSearch(filamentId: string, spoolId: string): string {
      const url = new URL(
        buildFilamentDeepLink("http://192.168.1.10:3456", filamentId, spoolId),
      );
      return url.search;
    }

    it("a label printed BEFORE a promotion lands on the promoted variant with the spool selected", async () => {
      // Same fixture shape as the promoteParent tests: a carrying parent
      // whose single spool a printed label points at.
      const parent = await Filament.create({
        name: "Labelled PLA",
        vendor: "V",
        type: "PLA",
        color: "#654321",
        spools: [{ label: "printed roll", totalWeight: 800 }],
      });
      const parentLean = await Filament.findById(parent._id).lean();
      const spoolId = String(parentLean.spools[0]._id);
      const search = labelSearch(String(parent._id), spoolId);

      const { variant } = await performParentPromotion(Filament, parentLean, {
        externalRefs,
      });

      // The stale page (the parent's spools are now cleared) classifies the
      // label's spool as "resolve"…
      const staleParent = await Filament.findById(parent._id).lean();
      const decision = decideSpoolDeepLink(
        search,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (staleParent.spools ?? []).map((s: any) => String(s._id)),
      );
      expect(decision).toEqual({ action: "resolve", spoolId });

      // …the global resolver reports the VARIANT as the true owner…
      const res = await resolveSpoolViaRoute(spoolId);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(String(body.filament._id)).toBe(String(variant._id));

      // …and the healed href is the variant's page with ?spool= intact, so
      // the remounted page highlights the spool.
      const href = healedSpoolDeepLinkHref(
        String(parent._id),
        String(body.filament._id),
        search,
      );
      expect(href).toBe(`/filaments/${variant._id}?spool=${spoolId}`);
      const ownerDoc = await Filament.findById(variant._id).lean();
      expect(
        decideSpoolDeepLink(
          search,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (ownerDoc.spools ?? []).map((s: any) => String(s._id)),
        ),
      ).toEqual({ action: "highlight", spoolId });
    });

    it("spool on the addressed doc: highlight path, no resolver round-trip needed", async () => {
      const f = await Filament.create({
        name: "Fresh Label PLA",
        vendor: "V",
        type: "PLA",
        spools: [{ label: "roll", totalWeight: 900 }],
      });
      const lean = await Filament.findById(f._id).lean();
      const spoolId = String(lean.spools[0]._id);
      const search = labelSearch(String(f._id), spoolId);

      const decision = decideSpoolDeepLink(
        search,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lean.spools ?? []).map((s: any) => String(s._id)),
      );
      expect(decision).toEqual({ action: "highlight", spoolId });
    });

    it("nonexistent spool: resolver 404s and the heal yields no redirect (current not-found posture)", async () => {
      const f = await Filament.create({
        name: "No Such Spool PLA",
        vendor: "V",
        type: "PLA",
        spools: [{ label: "roll", totalWeight: 500 }],
      });
      const ghostId = String(new mongoose.Types.ObjectId());
      const search = `?spool=${ghostId}`;

      const lean = await Filament.findById(f._id).lean();
      const decision = decideSpoolDeepLink(
        search,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lean.spools ?? []).map((s: any) => String(s._id)),
      );
      expect(decision).toEqual({ action: "resolve", spoolId: ghostId });

      const res = await resolveSpoolViaRoute(ghostId);
      expect(res.status).toBe(404);
      // The page's fetch sees !ok → no owner → no navigation.
      expect(healedSpoolDeepLinkHref(String(f._id), null, search)).toBeNull();
    });
  });
});

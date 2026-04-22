import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listShares, POST as createShare } from "@/app/api/share/route";
import {
  GET as getShare,
  DELETE as deleteShare,
} from "@/app/api/share/[slug]/route";

/**
 * /api/share publishes a static snapshot of selected filaments along with
 * the referenced nozzles/printers/bedTypes. /api/share/{slug} serves that
 * snapshot publicly and bumps a view counter.
 *
 * These tests cover both the publishing side (POST /api/share) and the
 * public fetch (GET /api/share/{slug}), plus the atomic-increment fix
 * added in the v1.11 review round.
 */
describe("/api/share", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SharedCatalog: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Nozzle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;

  beforeEach(async () => {
    const sharedMod = await import("@/models/SharedCatalog");
    const filamentMod = await import("@/models/Filament");
    const nozzleMod = await import("@/models/Nozzle");
    const printerMod = await import("@/models/Printer");
    const bedTypeMod = await import("@/models/BedType");
    if (!mongoose.models.SharedCatalog) {
      mongoose.model("SharedCatalog", sharedMod.default.schema);
    }
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    if (!mongoose.models.Nozzle) {
      mongoose.model("Nozzle", nozzleMod.default.schema);
    }
    if (!mongoose.models.Printer) {
      mongoose.model("Printer", printerMod.default.schema);
    }
    if (!mongoose.models.BedType) {
      mongoose.model("BedType", bedTypeMod.default.schema);
    }
    SharedCatalog = mongoose.models.SharedCatalog;
    Filament = mongoose.models.Filament;
    Nozzle = mongoose.models.Nozzle;
    Printer = mongoose.models.Printer;
  });

  describe("POST /api/share", () => {
    async function makeFilamentWithRefs() {
      const nozzle = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "brass" });
      const printer = await Printer.create({
        name: "Core One",
        manufacturer: "Prusa",
        printerModel: "CORE One",
      });
      const filament = await Filament.create({
        name: "Test PLA",
        vendor: "TestCo",
        type: "PLA",
        compatibleNozzles: [nozzle._id],
        calibrations: [{ nozzle: nozzle._id, printer: printer._id, extrusionMultiplier: 0.95 }],
      });
      return { filament, nozzle, printer };
    }

    function postReq(body: unknown) {
      return new NextRequest("http://localhost/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("publishes selected filaments and denormalises referenced entities", async () => {
      const { filament, nozzle, printer } = await makeFilamentWithRefs();
      const res = await createShare(
        postReq({
          title: "My favourites",
          filamentIds: [String(filament._id)],
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.slug).toBeDefined();

      const saved = await SharedCatalog.findOne({ slug: body.slug });
      expect(saved.payload.filaments).toHaveLength(1);
      expect(saved.payload.nozzles.map((n: { _id: unknown }) => String(n._id))).toContain(
        String(nozzle._id),
      );
      expect(saved.payload.printers.map((p: { _id: unknown }) => String(p._id))).toContain(
        String(printer._id),
      );
    });

    it("returns 400 when title is missing", async () => {
      const { filament } = await makeFilamentWithRefs();
      const res = await createShare(
        postReq({ filamentIds: [String(filament._id)] }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when title exceeds 200 chars (length-bounds guard)", async () => {
      const { filament } = await makeFilamentWithRefs();
      const res = await createShare(
        postReq({
          title: "a".repeat(201),
          filamentIds: [String(filament._id)],
        }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 when none of the requested filaments exist", async () => {
      const res = await createShare(
        postReq({
          title: "Nothing",
          filamentIds: [new mongoose.Types.ObjectId().toString()],
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/share/[slug]", () => {
    async function seed(payload = {}, expiresAt?: Date | null) {
      const catalog = await SharedCatalog.create({
        title: "Seed",
        description: "",
        payload: {
          version: 1,
          createdAt: new Date().toISOString(),
          filaments: [],
          nozzles: [],
          printers: [],
          bedTypes: [],
          ...payload,
        },
        expiresAt: expiresAt ?? null,
      });
      return catalog;
    }

    it("returns the payload and bumps viewCount atomically", async () => {
      const catalog = await seed();
      const r1 = await getShare(
        new NextRequest(`http://localhost/api/share/${catalog.slug}`),
        { params: Promise.resolve({ slug: catalog.slug }) },
      );
      const b1 = await r1.json();
      expect(b1.viewCount).toBe(1);

      const r2 = await getShare(
        new NextRequest(`http://localhost/api/share/${catalog.slug}`),
        { params: Promise.resolve({ slug: catalog.slug }) },
      );
      const b2 = await r2.json();
      expect(b2.viewCount).toBe(2);
    });

    it("handles concurrent requests without losing increments (atomic $inc)", async () => {
      // The pre-fix code did findOne + save() which races: both reads see
      // count=0, both increment to 1. The fix uses findOneAndUpdate($inc).
      const catalog = await seed();
      await Promise.all(
        Array.from({ length: 10 }, () =>
          getShare(
            new NextRequest(`http://localhost/api/share/${catalog.slug}`),
            { params: Promise.resolve({ slug: catalog.slug }) },
          ),
        ),
      );
      const fresh = await SharedCatalog.findOne({ slug: catalog.slug });
      expect(fresh.viewCount).toBe(10);
    });

    it("returns 404 for an unknown slug", async () => {
      const res = await getShare(
        new NextRequest("http://localhost/api/share/nope"),
        { params: Promise.resolve({ slug: "nope" }) },
      );
      expect(res.status).toBe(404);
    });

    it("returns 410 when a catalog has expired", async () => {
      const catalog = await seed({}, new Date(Date.now() - 1000));
      const res = await getShare(
        new NextRequest(`http://localhost/api/share/${catalog.slug}`),
        { params: Promise.resolve({ slug: catalog.slug }) },
      );
      expect(res.status).toBe(410);
    });
  });

  describe("GET /api/share", () => {
    it("lists every published catalog newest-first", async () => {
      await SharedCatalog.create({
        title: "Old",
        payload: {
          version: 1,
          createdAt: new Date().toISOString(),
          filaments: [],
          nozzles: [],
          printers: [],
          bedTypes: [],
        },
        createdAt: new Date("2026-01-01"),
      });
      await SharedCatalog.create({
        title: "New",
        payload: {
          version: 1,
          createdAt: new Date().toISOString(),
          filaments: [],
          nozzles: [],
          printers: [],
          bedTypes: [],
        },
      });
      const res = await listShares();
      const body = await res.json();
      expect(body.map((c: { title: string }) => c.title)).toEqual(["New", "Old"]);
    });
  });

  describe("DELETE /api/share/[slug]", () => {
    it("unpublishes a catalog", async () => {
      const catalog = await SharedCatalog.create({
        title: "Doomed",
        payload: {
          version: 1,
          createdAt: new Date().toISOString(),
          filaments: [],
          nozzles: [],
          printers: [],
          bedTypes: [],
        },
      });
      const res = await deleteShare(
        new NextRequest(`http://localhost/api/share/${catalog.slug}`),
        { params: Promise.resolve({ slug: catalog.slug }) },
      );
      expect(res.status).toBe(200);
      const check = await SharedCatalog.findOne({ slug: catalog.slug });
      expect(check).toBeNull();
    });
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { NextRequest } from "next/server";
import { POST as importAtlas } from "@/app/api/filaments/import-atlas/route";
import Filament from "@/models/Filament";

// Same bypass as tests/embedded-spool-photo-validation.test.ts (GH #626):
// assertSafeMongoUri would reject the in-memory mongod's plain
// mongodb://127.0.0.1 URI; the guard has its own dedicated suite.
vi.mock("@/lib/mongoUriGuard", () => ({
  assertSafeMongoUri: vi.fn(async () => {}),
}));

/**
 * GH #1021 (Codex P1 r20) — the Atlas import allow-lists `settings` and
 * discards the source's `compatibleNozzles`, so a pre-#1022 source database's
 * stamped machine condition used to import verbatim with its provenance
 * thrown away — and the local one-shot marker (already completed) meant
 * nothing ever caught it. The route now resolves provenance against the
 * SOURCE database BEFORE discarding the refs and strips a matching value.
 */
describe("POST /api/filaments/import-atlas — legacy nozzle-condition strip (GH #1021 r20)", () => {
  function remoteUri() {
    const parsed = new URL((process.env.MONGODB_URI as string).replace("mongodb://", "http://"));
    return `mongodb://${parsed.host}/atlas-legacy-src`;
  }
  function postReq(body: unknown) {
    return new NextRequest("http://localhost/api/filaments/import-atlas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    const client = await new MongoClient(remoteUri()).connect();
    try {
      await client.db().dropDatabase();
    } finally {
      await client.close();
    }
    await Filament.deleteMany({ name: /^Atlas / });
  });

  it("strips a provenance-matching machine condition (own + parent ticks); preserves a mismatched pin", async () => {
    const client = await new MongoClient(remoteUri()).connect();
    const srcDb = client.db();
    try {
      const noz04 = new ObjectId();
      const noz08 = new ObjectId();
      await srcDb.collection("nozzles").insertMany([
        { _id: noz04, name: "Src 0.4", diameter: 0.4 },
        { _id: noz08, name: "Src 0.8", diameter: 0.8 },
      ]);
      const idMachine = new ObjectId();
      const idPin = new ObjectId();
      const idParent = new ObjectId();
      const idVariant = new ObjectId();
      await srcDb.collection("filaments").insertMany([
        {
          _id: idMachine,
          name: "Atlas Machine PLA",
          vendor: "S",
          type: "PLA",
          compatibleNozzles: [noz04],
          settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4", cooling: "1" },
        },
        {
          // Same syntax, but the ticks derive to ==0.8 — a user pin.
          _id: idPin,
          name: "Atlas Pin PLA",
          vendor: "S",
          type: "PLA",
          compatibleNozzles: [noz08],
          settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4" },
        },
        {
          // Provenance through the source-side ACTIVE parent.
          _id: idParent,
          name: "Atlas Parent PLA",
          vendor: "S",
          type: "PLA",
          compatibleNozzles: [noz04],
          _deletedAt: null,
        },
        {
          _id: idVariant,
          name: "Atlas Variant PLA",
          vendor: "S",
          type: "PLA",
          compatibleNozzles: [],
          parentId: idParent,
          settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4" },
        },
      ]);

      const res = await importAtlas(
        postReq({
          uri: remoteUri(),
          filamentIds: [String(idMachine), String(idPin), String(idVariant)],
        }),
      );
      expect(res.status).toBe(200);

      const machine = await Filament.findOne({ name: "Atlas Machine PLA" }).lean();
      expect(machine!.settings?.compatible_printers_condition).toBe(""); // stripped
      expect(machine!.settings?.cooling).toBe("1"); // sibling key intact
      const pin = await Filament.findOne({ name: "Atlas Pin PLA" }).lean();
      expect(pin!.settings?.compatible_printers_condition).toBe("nozzle_diameter[0]==0.4"); // kept
      const variant = await Filament.findOne({ name: "Atlas Variant PLA" }).lean();
      expect(variant!.settings?.compatible_printers_condition).toBe(""); // via source parent
    } finally {
      await client.close();
    }
  });
});

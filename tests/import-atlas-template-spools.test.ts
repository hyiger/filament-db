import { describe, it, expect, beforeEach, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { NextRequest } from "next/server";
import { POST as importAtlas } from "@/app/api/filaments/import-atlas/route";
import Filament from "@/models/Filament";

// Same bypass as tests/import-atlas-legacy-condition.test.ts (GH #626):
// assertSafeMongoUri would reject the in-memory mongod's plain
// mongodb://127.0.0.1 URI; the guard has its own dedicated suite.
vi.mock("@/lib/mongoUriGuard", () => ({
  assertSafeMongoUri: vi.fn(async () => {}),
}));

/**
 * GH #605 (codex round 3 sweep) — the Atlas import's UPDATE path replaces
 * the whole local `spools` array with the remote's, so a remote row whose
 * name matches a LOCAL TEMPLATE (a filament with live variants) used to
 * attach inventory to it. The route now drops the remote spools for that
 * row (everything else still applies), reports it in `errors`, and leaves
 * the local spool state untouched.
 */
describe("POST /api/filaments/import-atlas — template spool guard (GH #605)", () => {
  function remoteUri() {
    const parsed = new URL((process.env.MONGODB_URI as string).replace("mongodb://", "http://"));
    return `mongodb://${parsed.host}/atlas-template-src`;
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

  it("drops remote spools aimed at a local template, applies the rest, and reports it", async () => {
    // Local template: a parent with one live variant and NO spools of its own.
    const localTemplate = await Filament.create({
      name: "Atlas Template PLA",
      vendor: "L",
      type: "PLA",
      color: null,
      density: 1.1,
    });
    await Filament.create({
      name: "Atlas Template PLA — Red",
      vendor: "L",
      type: "PLA",
      color: "#FF0000",
      parentId: localTemplate._id,
    });

    const client = await new MongoClient(remoteUri()).connect();
    try {
      const remoteId = new ObjectId();
      await client.db().collection("filaments").insertOne({
        _id: remoteId,
        name: "Atlas Template PLA",
        vendor: "R",
        type: "PLA",
        density: 1.24,
        spools: [
          { label: "remote roll 1", totalWeight: 1000 },
          { label: "remote roll 2", totalWeight: 800 },
        ],
        _deletedAt: null,
      });

      const res = await importAtlas(
        postReq({ uri: remoteUri(), filamentIds: [String(remoteId)] }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toMatch(/template/i);
      expect(body.errors[0]).toMatch(/2 spool/);
      expect(body.message).toMatch(/1 note/);

      const fresh = await Filament.findById(localTemplate._id).lean();
      // No inventory landed on the template …
      expect(fresh!.spools).toHaveLength(0);
      // … but the rest of the remote row still applied.
      expect(fresh!.density).toBe(1.24);
    } finally {
      await client.close();
    }
  });

  it("drops a non-null remote totalWeight aimed at a local template (legacy inventory — PUT-strip parity)", async () => {
    const localTemplate = await Filament.create({
      name: "Atlas Template PETG",
      vendor: "L",
      type: "PETG",
      color: null,
      totalWeight: null,
    });
    await Filament.create({
      name: "Atlas Template PETG — Blue",
      vendor: "L",
      type: "PETG",
      color: "#0000FF",
      parentId: localTemplate._id,
    });

    const client = await new MongoClient(remoteUri()).connect();
    try {
      const remoteId = new ObjectId();
      await client.db().collection("filaments").insertOne({
        _id: remoteId,
        name: "Atlas Template PETG",
        vendor: "R",
        type: "PETG",
        density: 1.27,
        totalWeight: 750, // legacy inventory — must not land on the template
        _deletedAt: null,
      });

      const res = await importAtlas(
        postReq({ uri: remoteUri(), filamentIds: [String(remoteId)] }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toMatch(/template/i);
      expect(body.errors[0]).toMatch(/total weight/);

      const fresh = await Filament.findById(localTemplate._id).lean();
      expect(fresh!.totalWeight).toBeNull(); // no inventory re-attached
      expect(fresh!.density).toBe(1.27); // rest of the row still applied
    } finally {
      await client.close();
    }
  });

  it("drops non-null remote color/colorName/lowStockThreshold aimed at a local template (round 4 F4 — PUT-strip parity)", async () => {
    const localTemplate = await Filament.create({
      name: "Atlas Template ASA",
      vendor: "L",
      type: "ASA",
      color: null,
      colorName: null,
    });
    await Filament.create({
      name: "Atlas Template ASA — Green",
      vendor: "L",
      type: "ASA",
      color: "#00FF00",
      parentId: localTemplate._id,
    });

    const client = await new MongoClient(remoteUri()).connect();
    try {
      const remoteId = new ObjectId();
      await client.db().collection("filaments").insertOne({
        _id: remoteId,
        name: "Atlas Template ASA",
        vendor: "R",
        type: "ASA",
        density: 1.07,
        // Per-variant identity/alarm state — templates are colorless and
        // inventory-free, so none of these may land (PUT-parity with the
        // TEMPLATE_STRIP_FIELDS list in [id]/route.ts).
        color: "#123456",
        colorName: "Remote Blue",
        lowStockThreshold: 250,
        _deletedAt: null,
      });

      const res = await importAtlas(
        postReq({ uri: remoteUri(), filamentIds: [String(remoteId)] }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toMatch(/template/i);
      expect(body.errors[0]).toMatch(/a color/);
      expect(body.errors[0]).toMatch(/color name/);
      expect(body.errors[0]).toMatch(/low-stock threshold/);

      const fresh = await Filament.findById(localTemplate._id).lean();
      expect(fresh!.color ?? null).toBeNull();
      expect(fresh!.colorName ?? null).toBeNull();
      expect(fresh!.lowStockThreshold ?? null).toBeNull();
      // The rest of the remote row still applied.
      expect(fresh!.density).toBe(1.07);
    } finally {
      await client.close();
    }
  });

  it("explicit remote NULL color/colorName still applies to a template (legacy cleanup — same posture as PUT)", async () => {
    // A LEGACY carrying template: still holds a color despite having a live
    // variant (enforce-forward residue). A remote row that has already been
    // cleaned (explicit nulls) may propagate that cleanup.
    const localTemplate = await Filament.create({
      name: "Atlas Legacy Template",
      vendor: "L",
      type: "PLA",
      color: "#808080",
      colorName: "Gray",
      lowStockThreshold: 100,
    });
    await Filament.create({
      name: "Atlas Legacy Template — Red",
      vendor: "L",
      type: "PLA",
      color: "#FF0000",
      parentId: localTemplate._id,
    });

    const client = await new MongoClient(remoteUri()).connect();
    try {
      const remoteId = new ObjectId();
      await client.db().collection("filaments").insertOne({
        _id: remoteId,
        name: "Atlas Legacy Template",
        vendor: "R",
        type: "PLA",
        color: null,
        colorName: null,
        lowStockThreshold: null,
        _deletedAt: null,
      });

      const res = await importAtlas(
        postReq({ uri: remoteUri(), filamentIds: [String(remoteId)] }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.errors).toBeUndefined();

      const fresh = await Filament.findById(localTemplate._id).lean();
      expect(fresh!.color).toBeNull();
      expect(fresh!.colorName).toBeNull();
      expect(fresh!.lowStockThreshold).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("a non-template local row still receives the remote spools (no errors reported)", async () => {
    const local = await Filament.create({
      name: "Atlas Plain PLA",
      vendor: "L",
      type: "PLA",
    });

    const client = await new MongoClient(remoteUri()).connect();
    try {
      const remoteId = new ObjectId();
      await client.db().collection("filaments").insertOne({
        _id: remoteId,
        name: "Atlas Plain PLA",
        vendor: "R",
        type: "PLA",
        spools: [{ label: "remote roll", totalWeight: 900 }],
        _deletedAt: null,
      });

      const res = await importAtlas(
        postReq({ uri: remoteUri(), filamentIds: [String(remoteId)] }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(body.errors).toBeUndefined();
      expect(body.message).not.toMatch(/note/);

      const fresh = await Filament.findById(local._id).lean();
      expect(fresh!.spools).toHaveLength(1);
      expect(fresh!.spools[0].label).toBe("remote roll");
    } finally {
      await client.close();
    }
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";

// The route validates the caller-supplied URI with
// assertSafeMongoUri({ requireSrv: true, blockPrivateHosts: true }), which
// would reject the in-memory mongod's plain mongodb://127.0.0.1 URI. The
// guard has its own suite (tests/mongoUriGuard.test.ts); bypass it here so
// the route can talk to the memory server as if it were a remote Atlas.
vi.mock("@/lib/mongoUriGuard", () => ({
  assertSafeMongoUri: vi.fn(async () => {}),
}));

import { POST as importAtlas } from "@/app/api/filaments/import-atlas/route";

describe("Atlas import agrees with the trimmed identity rule (#1116, Codex P2)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  const REMOTE_DB = "atlas-remote-1116";

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", mod.default.schema);
    Filament = mongoose.models.Filament;
  });

  afterEach(async () => {
    await remoteCollection().drop().catch(() => {});
  });

  function remoteUri() {
    // setup.ts stores the memory server's URI in MONGODB_URI; repoint the
    // path at a separate db so it plays the part of the remote Atlas.
    const parsed = new URL(
      (process.env.MONGODB_URI as string).replace("mongodb://", "http://"),
    );
    return `mongodb://${parsed.host}/${REMOTE_DB}`;
  }

  function remoteCollection() {
    return mongoose.connection.getClient().db(REMOTE_DB).collection("filaments");
  }

  it("an untrimmed SOURCE name UPDATES the trimmed local row", async () => {
    // The local side is normalized by the migration; an older Atlas source
    // still holds "PLA Basic ". This must resolve to the local row rather
    // than creating a second one (which the setter would then trim into an
    // E11000, failing the whole selected-filament import).
    //
    // Note this passes on the pre-#1116 route too: Mongoose applies a String
    // schema setter to QUERY values, so `findOne({ name: "PLA Basic " })`
    // already casts to `"PLA Basic"`. The explicit `.trim()` in the route
    // exists so the identity rule survives the lookup ever moving to the raw
    // driver, which does no casting — and this test is the invariant that
    // would catch it if it did.
    const local = await Filament.create({
      name: "PLA Basic",
      vendor: "V",
      type: "PLA",
      cost: 10,
    });
    const remoteId = new mongoose.Types.ObjectId();
    await remoteCollection().insertOne({
      _id: remoteId,
      name: "PLA Basic ",
      vendor: "V",
      type: "PLA",
      cost: 42,
      _deletedAt: null,
      spools: [],
    });

    const res = await importAtlas(
      new NextRequest("http://localhost/api/filaments/import-atlas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri: remoteUri(), filamentIds: [String(remoteId)] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.updated).toBe(1);

    expect(await Filament.countDocuments({})).toBe(1);
    const fresh = await Filament.findById(local._id);
    expect(fresh.name).toBe("PLA Basic");
    expect(fresh.cost).toBe(42);
  });

  it("does NOT manufacture a name out of a non-castable remote value (Codex P2)", async () => {
    // The remote document is attacker-influenceable — the caller supplies the
    // URI. A blanket String(...) turns `["Victim"]` into `Victim`, which then
    // SELECTS and overwrites the local Victim row; previously the cast error
    // refused the row outright.
    const victim = await Filament.create({
      name: "Victim",
      vendor: "V",
      type: "PLA",
      cost: 10,
    });
    const remoteId = new mongoose.Types.ObjectId();
    await remoteCollection().insertOne({
      _id: remoteId,
      name: ["Victim"],
      vendor: "Attacker",
      type: "PLA",
      cost: 999,
      _deletedAt: null,
      spools: [],
    });

    const res = await importAtlas(
      new NextRequest("http://localhost/api/filaments/import-atlas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri: remoteUri(), filamentIds: [String(remoteId)] }),
      }),
    );
    const body = await res.json();
    // Whatever the response shape, the local row must be untouched.
    expect(body.updated ?? 0).toBe(0);
    const fresh = await Filament.findById(victim._id);
    expect(fresh.vendor).toBe("V");
    expect(fresh.cost).toBe(10);
  });
});

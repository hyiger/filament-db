import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listLocations, POST as createLocation } from "@/app/api/locations/route";
import {
  GET as getLocation,
  PUT as updateLocation,
  DELETE as deleteLocation,
} from "@/app/api/locations/[id]/route";

/**
 * Route-level tests for the v1.11 Locations feature. Locations are a
 * brand-new concept in this release — every spool-location assignment,
 * the inventory dashboard, and the "reassign before delete" guardrail
 * live here. No existing test exercised this surface.
 */
describe("/api/locations", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Location: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    // Re-register models after setup.ts's afterEach wipes mongoose.models.
    // Route handlers do .populate() and aggregation against the registry
    // by model name, so ESM-cached modules aren't enough on their own.
    const locationMod = await import("@/models/Location");
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Location) {
      mongoose.model("Location", locationMod.default.schema);
    }
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Location = mongoose.models.Location;
    Filament = mongoose.models.Filament;
    // Sync indexes so the partial-unique name index exists for the
    // duplicate-name test; without this mongoose-memory-server skips
    // index creation and 11000 errors never surface.
    await Location.syncIndexes();
  });

  function jsonReq(url: string, body?: unknown) {
    return new NextRequest(url, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  describe("POST /api/locations", () => {
    it("creates a location with the given fields", async () => {
      const res = await createLocation(
        jsonReq("http://localhost/api/locations", {
          name: "Main shelf",
          kind: "shelf",
          notes: "near the workbench",
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("Main shelf");
      expect(body.kind).toBe("shelf");
      expect(body._id).toBeDefined();
    });

    it("returns 409 on duplicate name", async () => {
      await createLocation(
        jsonReq("http://localhost/api/locations", { name: "Dry box", kind: "drybox" }),
      );
      const res = await createLocation(
        jsonReq("http://localhost/api/locations", { name: "Dry box", kind: "drybox" }),
      );
      expect(res.status).toBe(409);
    });

    it("strips server-managed fields from the body", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await createLocation(
        jsonReq("http://localhost/api/locations", {
          _id: fakeId,
          name: "Trust-no-client",
          kind: "bin",
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      // _id should be server-generated, not the one the client sent.
      expect(body._id).not.toBe(fakeId);
    });
  });

  describe("GET /api/locations", () => {
    it("lists only non-deleted locations sorted by name", async () => {
      await Location.create({ name: "Zebra", kind: "shelf" });
      await Location.create({ name: "Alpha", kind: "shelf" });
      const res = await listLocations(jsonReq("http://localhost/api/locations"));
      const body = await res.json();
      expect(body.map((l: { name: string }) => l.name)).toEqual(["Alpha", "Zebra"]);
    });

    it("filters by kind when ?kind= is passed", async () => {
      await Location.create({ name: "Shelf A", kind: "shelf" });
      await Location.create({ name: "Box 1", kind: "drybox" });
      const res = await listLocations(jsonReq("http://localhost/api/locations?kind=drybox"));
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].kind).toBe("drybox");
    });

    it("attaches spoolCount/totalGrams when ?stats=true", async () => {
      const loc = await Location.create({ name: "Cabinet", kind: "shelf" });
      await Filament.create({
        name: "Stats Test",
        vendor: "Test",
        type: "PLA",
        spools: [
          { label: "", totalWeight: 500, locationId: loc._id, retired: false },
          { label: "", totalWeight: 300, locationId: loc._id, retired: false },
          { label: "", totalWeight: 999, locationId: loc._id, retired: true }, // excluded
        ],
      });

      const res = await listLocations(
        jsonReq("http://localhost/api/locations?stats=true"),
      );
      const body = await res.json();
      const stats = body.find((l: { name: string }) => l.name === "Cabinet");
      expect(stats.spoolCount).toBe(2);
      expect(stats.totalGrams).toBe(800);
    });
  });

  describe("GET /api/locations/[id]", () => {
    it("fetches a single location by id", async () => {
      const loc = await Location.create({ name: "X", kind: "shelf" });
      const res = await getLocation(
        jsonReq(`http://localhost/api/locations/${loc._id}`),
        { params: Promise.resolve({ id: String(loc._id) }) },
      );
      const body = await res.json();
      expect(body.name).toBe("X");
    });

    it("returns 404 for a missing id", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await getLocation(
        jsonReq(`http://localhost/api/locations/${fakeId}`),
        { params: Promise.resolve({ id: fakeId }) },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/locations/[id]", () => {
    it("updates mutable fields", async () => {
      const loc = await Location.create({ name: "Old", kind: "shelf" });
      const res = await updateLocation(
        new NextRequest(`http://localhost/api/locations/${loc._id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "New", notes: "updated" }),
        }),
        { params: Promise.resolve({ id: String(loc._id) }) },
      );
      const body = await res.json();
      expect(body.name).toBe("New");
      expect(body.notes).toBe("updated");
    });
  });

  describe("DELETE /api/locations/[id]", () => {
    it("soft-deletes an unreferenced location", async () => {
      const loc = await Location.create({ name: "Gone", kind: "shelf" });
      const res = await deleteLocation(
        jsonReq(`http://localhost/api/locations/${loc._id}`),
        { params: Promise.resolve({ id: String(loc._id) }) },
      );
      expect(res.status).toBe(200);

      // Should no longer be listed
      const list = await listLocations(jsonReq("http://localhost/api/locations"));
      const body = await list.json();
      expect(body.find((l: { _id: string }) => String(l._id) === String(loc._id))).toBeUndefined();
    });

    it("refuses to delete a location referenced by a spool", async () => {
      const loc = await Location.create({ name: "In use", kind: "shelf" });
      await Filament.create({
        name: "Has Location",
        vendor: "Test",
        type: "PLA",
        spools: [{ label: "", totalWeight: 500, locationId: loc._id }],
      });
      const res = await deleteLocation(
        jsonReq(`http://localhost/api/locations/${loc._id}`),
        { params: Promise.resolve({ id: String(loc._id) }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/referenced by spools/i);

      // Location still exists.
      const fresh = await Location.findById(loc._id);
      expect(fresh._deletedAt).toBeNull();
    });
  });
});

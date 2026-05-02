import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";

describe("dbConnect", () => {
  beforeEach(() => {
    // Reset the global cache before each test
    (global as Record<string, unknown>).mongoose = undefined;
  });

  it("throws when MONGODB_URI is not defined", async () => {
    const original = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;

    await expect(dbConnect()).rejects.toThrow(
      "Please define the MONGODB_URI environment variable"
    );

    process.env.MONGODB_URI = original;
  });

  it("connects and returns mongoose instance", async () => {
    const result = await dbConnect();
    expect(result).toBeDefined();
    expect(result).toBe(mongoose);
  });

  it("returns cached connection on second call", async () => {
    const first = await dbConnect();
    const second = await dbConnect();
    expect(first).toBe(second);
  });

  it("sets global.mongoose cache", async () => {
    await dbConnect();
    expect((global as Record<string, unknown>).mongoose).toBeDefined();
  });

  it("reuses existing promise when connection is in progress", async () => {
    // Set up a cache with a pending promise but no connection
    const connectPromise = Promise.resolve(mongoose);
    (global as Record<string, unknown>).mongoose = {
      conn: null,
      promise: connectPromise,
      uri: process.env.MONGODB_URI,
      migrations: { instanceIds: false, sharedCatalogIndexes: false },
    };

    const result = await dbConnect();
    expect(result).toBe(mongoose);
  });

  it("initializes global.mongoose when not set", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    await dbConnect();
    expect((global as Record<string, unknown>).mongoose).toBeDefined();
  });

  it("logs when migration backfills instanceIds", async () => {
    // Connect first to get access to the collection
    await dbConnect();

    // Insert a filament without instanceId directly via collection
    const Filament = mongoose.models.Filament || (await import("@/models/Filament")).default;
    await Filament.collection.insertOne({
      name: "MigrationTest",
      vendor: "Test",
      type: "PLA",
      color: "#808080",
      diameter: 1.75,
      _deletedAt: null,
    });

    // Reset cache to force migration to run again
    const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
    cached.migrations = { instanceIds: false, sharedCatalogIndexes: false };
    cached.conn = null;
    cached.promise = null;

    // Spy on console.log to verify migration message
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dbConnect();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[migration] Backfilled instanceId")
      );
    } finally {
      logSpy.mockRestore();
      // Clean up
      await Filament.deleteMany({ name: "MigrationTest" });
    }
  });


  it("reconnects when URI changes", async () => {
    // First connect with current URI
    await dbConnect();

    // Simulate URI change by modifying the cached URI
    const cached = (global as Record<string, unknown>).mongoose as Record<string, unknown>;
    cached.uri = "mongodb://different-uri:27017/test";

    // This should trigger disconnect and reconnect
    const result = await dbConnect();
    expect(result).toBeDefined();
  });

  it("marks each migration complete on first successful connect", async () => {
    (global as Record<string, unknown>).mongoose = undefined;

    const result = await dbConnect();
    expect(result).toBeDefined();
    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { instanceIds: boolean; sharedCatalogIndexes: boolean };
    };
    expect(cached.migrations.instanceIds).toBe(true);
    expect(cached.migrations.sharedCatalogIndexes).toBe(true);
  });

  it("skips migrations on subsequent connects once they've succeeded", async () => {
    (global as Record<string, unknown>).mongoose = undefined;
    await dbConnect();

    const cached = (global as Record<string, unknown>).mongoose as {
      migrations: { instanceIds: boolean; sharedCatalogIndexes: boolean };
    };
    expect(cached.migrations.instanceIds).toBe(true);
    expect(cached.migrations.sharedCatalogIndexes).toBe(true);

    const result = await dbConnect();
    expect(result).toBeDefined();
  });

  it("retries a failed migration on the next connect (doesn't poison the cache)", async () => {
    // Codex round-4 P2: a transient failure on backfillInstanceIds or
    // syncIndexes used to set the single `migrated` flag and skip both
    // migrations forever after. With per-migration flags, only the
    // succeeded migration sticks; a failed one retries on the next call.
    (global as Record<string, unknown>).mongoose = undefined;

    // Force the SharedCatalog migration to throw on its first attempt.
    const sharedCatalogMod = await import("@/models/SharedCatalog");
    const SharedCatalog = sharedCatalogMod.default;
    const syncIndexesSpy = vi
      .spyOn(SharedCatalog, "syncIndexes")
      .mockRejectedValueOnce(new Error("transient failure"));

    try {
      await dbConnect();
      const cached = (global as Record<string, unknown>).mongoose as {
        migrations: { instanceIds: boolean; sharedCatalogIndexes: boolean };
      };
      // The instanceIds backfill succeeded; the sharedCatalog migration didn't.
      expect(cached.migrations.instanceIds).toBe(true);
      expect(cached.migrations.sharedCatalogIndexes).toBe(false);

      // Next call should retry the failed one — and now succeed.
      await dbConnect();
      expect(syncIndexesSpy).toHaveBeenCalledTimes(2);
      expect(cached.migrations.sharedCatalogIndexes).toBe(true);
    } finally {
      syncIndexesSpy.mockRestore();
    }
  });
});
